#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { execSync } = require("child_process");

const DEFAULT_PORT = 17922;
const SERVICE_NAME = "exam-assistant";
const SERVICE_VERSION = "1.4.0";
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".exam-assistant");
const MAX_BODY = 2 * 1024 * 1024;

function dataDir() {
  const override = process.env.EXAM_ASSISTANT_DATA_DIR;
  if (override) return path.resolve(override);
  return DEFAULT_DATA_DIR;
}

function ensureDirs(root) {
  for (const dir of ["sessions", "pages", "assignments", "reports"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeToken(value, fallback) {
  const token = String(value || "").replace(/[^\p{L}\p{N}_-]+/gu, "");
  return token || fallback;
}

function sessionFilename(sessionId) {
  return `exam-session-${safeToken(sessionId, "practice")}.json`;
}

function sessionIdOf(rec) {
  return String((rec && (rec.sessionId || rec.id)) || "");
}

function isSubmitted(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (rec.submitted === false) return false;
  if (rec.submitted === true) return true;
  return false;
}

function recordTimestamp(rec, fallback) {
  return (rec && (rec.savedAt || rec.submittedAt || rec.startedAt)) || fallback || "";
}

function sessionFilePath(item) {
  return (item && (item.path || item.file)) || "";
}

function answeredCount(rec) {
  if (!rec) return 0;
  const items = Array.isArray(rec.items) ? rec.items : [];
  const fromItems = items.filter((it) => it && hasAnswer(it.userAnswer)).length;
  if (fromItems) return fromItems;
  if (rec.answers && typeof rec.answers === "object") {
    return Object.values(rec.answers).filter((v) => hasAnswer(v)).length;
  }
  return 0;
}

function hasAnswer(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((v) => String(v || "").trim());
  return String(value).trim().length > 0;
}

function newerSession(a, b) {
  const pa = sessionFilePath(a);
  const pb = sessionFilePath(b);
  const ta = recordTimestamp(a && a.data, pa ? path.basename(pa) : "");
  const tb = recordTimestamp(b && b.data, pb ? path.basename(pb) : "");
  if (ta !== tb) return ta > tb;
  return pa >= pb;
}

function betterSession(a, b) {
  if (!b) return true;
  if (!a) return false;
  const aSub = isSubmitted(a.data);
  const bSub = isSubmitted(b.data);
  if (aSub !== bSub) return aSub;
  const aAns = answeredCount(a.data);
  const bAns = answeredCount(b.data);
  if ((aAns === 0) !== (bAns === 0)) return aAns > 0;
  return newerSession(a, b);
}

function listSessionFiles(root) {
  const dir = path.join(root, "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith("exam-session-") && name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort();
}

function loadSessions(root) {
  const items = [];
  for (const filePath of listSessionFiles(root)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) {
        items.push({ path: filePath, data });
      }
    } catch {
      // skip broken session files
    }
  }
  items.sort((a, b) => {
    const ka = a.data.savedAt || a.data.startedAt || path.basename(a.path);
    const kb = b.data.savedAt || b.data.startedAt || path.basename(b.path);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return items;
}

function sessionsForId(root, sessionId) {
  const sid = String(sessionId || "");
  if (!sid) return [];
  return loadSessions(root).filter((item) => sessionIdOf(item.data) === sid);
}

function pickSessionRecord(items) {
  if (!items.length) return null;
  return items.reduce((best, item) => (betterSession(item, best) ? item : best));
}

function loadSessionById(root, sessionId) {
  const picked = pickSessionRecord(sessionsForId(root, sessionId));
  return picked ? picked.data : null;
}

function resolveSessionWritePath(root, record) {
  const sid = sessionIdOf(record) || "practice";
  const existing = sessionsForId(root, sid);
  const canonical = path.join(root, "sessions", sessionFilename(sid));
  if (record && record.submitted === false) {
    const kept = existing.filter((item) => isSubmitted(item.data) && answeredCount(item.data) > 0);
    if (kept.length) {
      const draftPath = path.join(root, "sessions", `exam-session-${safeToken(sid, "practice")}-draft.json`);
      const existingDraft = existing.find((item) => {
        const p = sessionFilePath(item);
        return path.resolve(p) === path.resolve(draftPath) || /draft\.json$/.test(p);
      });
      return existingDraft ? (existingDraft.path || existingDraft.file) : draftPath;
    }
  }
  const canonItem = existing.find((item) => path.resolve(item.path) === path.resolve(canonical));
  if (canonItem) return canonItem.path;
  const latest = pickSessionRecord(existing);
  if (latest && !/draft\.json$/.test(latest.path || "")) return latest.path;
  return canonical;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

function timestampLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function listJsonRecords(root, dir, prefix) {
  const folder = path.join(root, dir);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(folder, name);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;
        return {
          file: `${dir}/${name}`,
          path: filePath,
          mtime: fs.statSync(filePath).mtimeMs,
          data,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ka = a.data.savedAt || a.data.createdAt || a.data.assignedAt || "";
      const kb = b.data.savedAt || b.data.createdAt || b.data.assignedAt || "";
      if (ka !== kb) return ka < kb ? 1 : -1;
      return b.mtime - a.mtime;
    });
}

function assignmentFilename(record) {
  const sid = safeToken(record.sessionId || record.id || "", "paper");
  const created = record.createdAt || nowIso();
  const ts = String(created).replace(/\D/g, "").slice(0, 14) || timestampLocal();
  return `exam-assignment-${sid}-${ts}.json`;
}

function findAssignmentPath(root, sessionId) {
  if (!sessionId) return null;
  const found = listJsonRecords(root, "assignments", "exam-assignment-")
    .find((row) => sessionIdOf(row.data) === String(sessionId));
  return found ? found.path : null;
}

function validateAssignment(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("记录必须是 JSON 对象");
  }
  const record = {
    ...payload,
    id: payload.id || payload.sessionId || "paper",
    sessionId: payload.sessionId || payload.id || "paper",
    title: payload.title || "未命名试卷",
    createdAt: payload.createdAt || nowIso(),
    status: payload.status || "assigned",
  };
  if (record.schemaVersion !== 1) return record;

  const sessionId = payload.sessionId ?? payload.id;
  if (typeof sessionId !== "string" || !/^[\p{L}\p{N}_-]{1,64}$/u.test(sessionId)) {
    throw new Error("试卷 ID 须由 1–64 个字母、数字、下划线或连字符组成");
  }
  if (!Array.isArray(record.questions) || !record.questions.length) {
    throw new Error("试卷缺少题目");
  }
  const questionIds = new Set();
  for (const question of record.questions) {
    if (typeof question?.id !== "string" || !question.id.trim() || questionIds.has(question.id)) {
      throw new Error("每题须有唯一的题目 ID");
    }
    questionIds.add(question.id);
  }
  if (record.materials != null && !Array.isArray(record.materials)) {
    throw new Error("materials 必须是数组");
  }
  record.id = record.sessionId = sessionId;
  record.questionCount = record.questions.length;
  record.page = "/practice/" + encodeURIComponent(sessionId);
  return record;
}

function saveAssignment(root, payload) {
  const record = validateAssignment(payload);
  const existingPath = findAssignmentPath(root, record.sessionId);
  const existing = existingPath && loadJson(existingPath, null);
  if (existing && (existing.schemaVersion === 1 || record.schemaVersion === 1)) {
    record.createdAt = existing.createdAt;
    if (!isDeepStrictEqual(record, existing)) {
      throw new Error("该试卷 ID 已布置，请用新的 ID 布置新版试卷");
    }
    return { file: "assignments/" + path.basename(existingPath), assignment: existing };
  }
  const filename = existingPath ? path.basename(existingPath) : assignmentFilename(record);
  writeJson(path.join(root, "assignments", filename), record);
  return { file: "assignments/" + filename, assignment: record };
}

function validateRecord(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("记录必须是 JSON 对象");
  }
  if (!Array.isArray(payload.items)) {
    throw new Error("记录缺少 items");
  }
  return {
    ...payload,
    savedAt: payload.savedAt || nowIso(),
    sessionId: payload.sessionId || payload.id || "practice",
  };
}

function applyStartedAt(root, record) {
  const sid = sessionIdOf(record);
  if (!sid) return record;
  const existing = pickSessionRecord(sessionsForId(root, sid));
  if (existing && existing.data && existing.data.startedAt) {
    record.startedAt = existing.data.startedAt;
  }
  return record;
}

function buildHome(root) {
  const assignments = listJsonRecords(root, "assignments", "exam-assignment-");
  const sessions = loadSessions(root).map(({ path: filePath, data }) => ({
    file: "sessions/" + path.basename(filePath),
    path: filePath,
    data,
    mtime: fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0,
  }));
  const grouped = new Map();
  for (const row of sessions) {
    const key = sessionIdOf(row.data) || row.file;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const sessionById = new Map();
  for (const [key, items] of grouped) {
    sessionById.set(key, pickSessionRecord(items));
  }

  const papers = [];
  const seen = new Set();
  function pushPaper(row, kind) {
    const rec = row.data;
    const sessionId = rec.sessionId || rec.id || "";
    const session = sessionId ? sessionById.get(sessionId) : null;
    const submitted = isSubmitted(session ? session.data : (kind === "session" ? rec : null));
    const src = submitted && session ? session.data : rec;
    const summary = src.summary || rec.summary || {};
    const key = (sessionId || rec.title || row.file) + "::" + kind;
    if (seen.has(sessionId || key)) return;
    if (sessionId) seen.add(sessionId);
    else seen.add(key);
    papers.push({
      sessionId,
      title: rec.title || src.title || "未命名试卷",
      source: rec.source || src.source || "",
      mode: rec.mode || src.mode || "",
      questionCount: rec.questionCount || (rec.questions || rec.items || []).length || summary.total || 0,
      total: summary.total || rec.questionCount || 0,
      scored: summary.scored,
      correct: summary.correct,
      accuracy: summary.accuracy,
      durationMinutes: rec.durationMinutes || src.durationMinutes || 0,
      page: rec.page || src.page || "",
      createdAt: rec.createdAt || rec.startedAt || src.startedAt || rec.savedAt,
      submittedAt: submitted ? (src.savedAt || rec.submittedAt || "") : "",
      startedAt: src.startedAt || rec.startedAt || "",
      usedSeconds: src.usedSeconds || rec.usedSeconds || 0,
      submitted,
    });
  }
  assignments.forEach((row) => pushPaper(row, "assignment"));
  for (const row of sessions) {
    const sid = row.data.sessionId || row.data.id || "";
    const already = papers.some((p) => p.sessionId && sid && p.sessionId === sid);
    if (!already) pushPaper(row, "session");
  }
  papers.sort((a, b) => String(b.createdAt || b.submittedAt || "").localeCompare(String(a.createdAt || a.submittedAt || "")));
  return {
    updatedAt: nowIso(),
    latest: papers[0] || null,
    papers,
  };
}


const DAY_MS = 24 * 60 * 60 * 1000;
const MASTERY_LEVELS = {
  new: "未练",
  weak: "薄弱",
  learning: "学习中",
  mastered: "掌握",
};
const DUE_AFTER_MS = {
  new: 0,
  weak: DAY_MS,
  learning: DAY_MS,
  mastered: 7 * DAY_MS,
};
const UNGROUPED_SUBJECT = "未分科目";
const SETTLED_WRONG = new Set([
  "done", "resolved", "reviewed", "cleared", "mastered", "closed",
  "已掌握", "已复习", "已消化", "已完成",
]);

function normalizeMastery(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "new" || raw === "未练") return "new";
  if (raw === "weak" || raw === "薄弱") return "weak";
  if (raw === "learning" || raw === "学习中" || raw === "一般") return "learning";
  if (raw === "mastered" || raw === "掌握") return "mastered";
  return "new";
}

function masteryLabel(mastery) {
  return MASTERY_LEVELS[normalizeMastery(mastery)] || "未练";
}

function isTopicDue(topic, now = Date.now()) {
  const mastery = normalizeMastery(topic && topic.mastery);
  const lastSeen = topic && topic.last_seen;
  if (!lastSeen || mastery === "new") return true;
  const t = Date.parse(lastSeen);
  if (Number.isNaN(t)) return true;
  const wait = Object.prototype.hasOwnProperty.call(DUE_AFTER_MS, mastery) ? DUE_AFTER_MS[mastery] : DAY_MS;
  return now - t >= wait;
}

function loadWrongItemList(root) {
  const file = path.join(root, "wrong-items.json");
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data)) {
      return data.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    }
    if (data && typeof data === "object") {
      const list = data.items || data.wrongItems || [];
      return Array.isArray(list)
        ? list.filter((item) => item && typeof item === "object" && !Array.isArray(item))
        : [];
    }
  } catch {
    // skip broken wrong-items file
  }
  return [];
}

function isPendingWrong(item) {
  if (!item || typeof item !== "object") return false;
  if (item.pending === false || item.resolved === true || item.reviewed === true || item.done === true) {
    return false;
  }
  if (item.pending === true) return true;
  const status = String(item.status || item.reviewStatus || item.state || "pending").trim();
  if (!status) return true;
  return !SETTLED_WRONG.has(status) && !SETTLED_WRONG.has(status.toLowerCase());
}

function matchWrongItemTopic(item, topics) {
  const id = String(item.topicId || item.topic_id || item.knowledgeId || "").trim();
  if (id) return topics.find(topic => topic.id === id);
  const name = String(item.topic || item.topicName || item.knowledge || "").trim();
  if (!name) return;
  const matches = topics.filter(topic => topic.topic === name);
  if (matches.length === 1) return matches[0];
}

function emptyMap(updatedAt) {
  return {
    updatedAt: updatedAt || nowIso(),
    summary: {
      byLevel: { "未练": 0, "薄弱": 0, "学习中": 0, "掌握": 0 },
      practiceCount: 0,
      sessionCount: 0,
      questionCount: 0,
      answeredCount: 0,
      correctCount: 0,
      accuracy: null,
      pendingWrongCount: 0,
      dueCount: 0,
    },
    subjects: [],
    clusters: [],
    topics: [],
  };
}

function numberOr(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildMap(root, now = Date.now()) {
  const statePath = path.join(root, "state.json");
  if (!fs.existsSync(statePath)) return emptyMap();
  const state = loadJson(statePath, null);
  if (!state) return emptyMap();

  const topicsIn = Array.isArray(state.topics) ? state.topics : [];
  const stats = state.stats && typeof state.stats === "object" ? state.stats : {};
  const pendingItems = loadWrongItemList(root).filter(isPendingWrong);

  const packedTopics = topicsIn
    .filter((topic) => topic && typeof topic === "object" && !Array.isArray(topic))
    .map((topic) => {
      const mastery = normalizeMastery(topic.mastery);
      const correct = numberOr(topic.correct, 0);
      const wrong = numberOr(topic.wrong, 0);
      const attempts = correct + wrong;
      return {
        id: String(topic.id || ""),
        topic: String(topic.topic || topic.name || ""),
        subject: String(topic.subject || "").trim() || UNGROUPED_SUBJECT,
        source: topic.source || "",
        clusterId: String(topic.clusterId || "").trim(),
        mastery,
        level: masteryLabel(mastery),
        correct,
        wrong,
        attempts,
        accuracy: attempts ? Math.round((correct / attempts) * 1000) / 1000 : null,
        pendingWrong: 0,
        last_seen: topic.last_seen || "",
        due: isTopicDue({ mastery, last_seen: topic.last_seen }, now),
      };
    });

  for (const item of pendingItems) {
    const match = matchWrongItemTopic(item, packedTopics);
    if (match) match.pendingWrong += 1;
  }

  const byLevel = { "未练": 0, "薄弱": 0, "学习中": 0, "掌握": 0 };
  let dueCount = 0;
  for (const topic of packedTopics) {
    byLevel[topic.level] = (byLevel[topic.level] || 0) + 1;
    if (topic.due) dueCount += 1;
  }

  const subjectNames = [];
  const seenSubject = new Set();
  for (const topic of packedTopics) {
    if (!seenSubject.has(topic.subject)) {
      seenSubject.add(topic.subject);
      subjectNames.push(topic.subject);
    }
  }
  subjectNames.sort((a, b) => {
    if (a === UNGROUPED_SUBJECT) return 1;
    if (b === UNGROUPED_SUBJECT) return -1;
    return a.localeCompare(b, "zh");
  });

  const subjects = subjectNames.map((name) => {
    const list = packedTopics.filter((topic) => topic.subject === name);
    const correct = list.reduce((sum, topic) => sum + topic.correct, 0);
    const wrong = list.reduce((sum, topic) => sum + topic.wrong, 0);
    const attempts = correct + wrong;
    const levels = { "未练": 0, "薄弱": 0, "学习中": 0, "掌握": 0 };
    let pendingWrong = 0;
    let due = 0;
    for (const topic of list) {
      levels[topic.level] = (levels[topic.level] || 0) + 1;
      pendingWrong += topic.pendingWrong;
      if (topic.due) due += 1;
    }
    return {
      name,
      topicCount: list.length,
      correct,
      wrong,
      attempts,
      accuracy: attempts ? Math.round((correct / attempts) * 1000) / 1000 : null,
      pendingWrong,
      dueCount: due,
      byLevel: levels,
      topics: list,
    };
  });

  const sessionCount = Array.isArray(state.sessions) ? state.sessions.length : 0;
  const practiceCount = numberOr(stats.practiceCount, sessionCount);
  const answeredFromTopics = packedTopics.reduce((sum, topic) => sum + topic.attempts, 0);
  const correctFromTopics = packedTopics.reduce((sum, topic) => sum + topic.correct, 0);
  const answeredCount = numberOr(stats.answeredCount, answeredFromTopics);
  const correctCount = numberOr(stats.correctCount, correctFromTopics);
  const questionCount = numberOr(stats.questionCount, answeredCount);

  return {
    updatedAt: state.updatedAt || nowIso(),
    summary: {
      byLevel,
      practiceCount,
      sessionCount,
      questionCount,
      answeredCount,
      correctCount,
      accuracy: answeredCount ? Math.round((correctCount / answeredCount) * 1000) / 1000 : null,
      pendingWrongCount: pendingItems.length,
      dueCount,
    },
    subjects,
    clusters: packClusters(state.clusters, packedTopics),
    topics: packedTopics,
  };
}

function packClusters(clustersIn, packedTopics) {
  const input = Array.isArray(clustersIn) ? clustersIn : [];
  const topicsById = new Map();
  for (const topic of packedTopics) {
    if (topic.id) topicsById.set(topic.id, topic);
  }
  const packed = [];
  const seen = new Set();
  for (const cluster of input) {
    if (!cluster || typeof cluster !== "object" || Array.isArray(cluster)) continue;
    const id = String(cluster.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const idSet = new Set();
    const ids = [];
    const rawIds = Array.isArray(cluster.topicIds) ? cluster.topicIds : [];
    for (const raw of rawIds) {
      const tid = String(raw || "").trim();
      if (!tid || idSet.has(tid)) continue;
      idSet.add(tid);
      ids.push(tid);
    }
    for (const topic of packedTopics) {
      if (topic.clusterId === id && !idSet.has(topic.id)) {
        idSet.add(topic.id);
        ids.push(topic.id);
      }
    }
    const list = ids.map((tid) => topicsById.get(tid)).filter(Boolean);
    const correct = list.reduce((sum, topic) => sum + topic.correct, 0);
    const wrong = list.reduce((sum, topic) => sum + topic.wrong, 0);
    const attempts = correct + wrong;
    const levels = { "未练": 0, "薄弱": 0, "学习中": 0, "掌握": 0 };
    let pendingWrong = 0;
    let due = 0;
    for (const topic of list) {
      levels[topic.level] = (levels[topic.level] || 0) + 1;
      pendingWrong += topic.pendingWrong;
      if (topic.due) due += 1;
    }
    packed.push({
      id,
      name: String(cluster.name || "").trim() || id,
      subject: String(cluster.subject || "").trim(),
      summary: String(cluster.summary || "").trim(),
      topicCount: list.length,
      correct,
      wrong,
      attempts,
      accuracy: attempts ? Math.round((correct / attempts) * 1000) / 1000 : null,
      pendingWrong,
      dueCount: due,
      byLevel: levels,
      topics: list,
    });
  }
  return packed;
}

function readTemplate(root, name) {
  const names = [
    path.join(__dirname, "..", "templates", name),
    path.join(__dirname, "templates", name),
    path.join(__dirname, name),
    path.join(root, name),
  ];
  for (const file of names) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return fs.readFileSync(file, "utf8");
    }
  }
  return null;
}

const APP_CHROME_MARKER = "{{APP_CHROME}}";
const APP_CHROME_TABS = ["latest", "papers", "map"];

function loadAppChrome(root) {
  return readTemplate(root, "app-chrome.inc.html") || "";
}

function applyAppChrome(html, root, { active = "latest" } = {}) {
  if (!html) return html;
  let chrome = loadAppChrome(root);
  if (!chrome) {
    return html.includes(APP_CHROME_MARKER) ? html.split(APP_CHROME_MARKER).join("") : html;
  }
  const tab = APP_CHROME_TABS.includes(active) ? active : "latest";
  for (const name of APP_CHROME_TABS) {
    chrome = chrome.split(`{{ACTIVE_${name}}}`).join(name === tab ? "active" : "");
  }
  if (html.includes(APP_CHROME_MARKER)) {
    return html.split(APP_CHROME_MARKER).join(chrome);
  }
  return html;
}

function injectAppChrome(html, root, opts) {
  if (!html) return html;
  if (html.includes('id="app-chrome"') || html.includes(APP_CHROME_MARKER)) {
    return applyAppChrome(html, root, opts);
  }
  if (/<body[^>]*>/i.test(html)) {
    return applyAppChrome(html.replace(/<body[^>]*>/i, (m) => m + "\n" + APP_CHROME_MARKER + "\n"), root, opts);
  }
  return applyAppChrome(APP_CHROME_MARKER + "\n" + html, root, opts);
}

function wantsEmbed(req, url) {
  if (url.searchParams.get("embed") === "1") return true;
  const dest = String((req && req.headers && req.headers["sec-fetch-dest"]) || "").toLowerCase();
  return dest === "iframe";
}

function renderPractice(template, assignment, root, opts = {}) {
  const marker = '<script type="application/json" id="exam-data">{}</script>';
  if (!template.includes(marker)) throw new Error("练习页模板缺少试卷数据位置");
  const data = JSON.stringify(assignment).replace(/</g, "\\u003c");
  let html = template.replace(marker, () => `<script type="application/json" id="exam-data">${data}</script>`);
  html = applyAppChrome(html, root || path.join(__dirname), { active: (opts && opts.active) || "latest" });
  return html;
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  res.writeHead(code, corsHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
  }));
  res.end(body);
}

function sendBytes(res, code, body, ctype) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, corsHeaders({
    "Content-Type": ctype,
    "Content-Length": String(buf.length),
  }));
  res.end(buf);
}

function corsHeaders(extra) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function safePagePath(root, rel) {
  const pages = path.resolve(path.join(root, "pages"));
  const target = path.resolve(path.join(pages, rel));
  const prefix = pages.endsWith(path.sep) ? pages : pages + path.sep;
  if (target !== pages && !target.startsWith(prefix)) return null;
  return target;
}

function createHandler(root, port, controls) {
  return (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET") {
      if (pathname === "/" || pathname === "/index.html" || pathname === "/home" || pathname === "/home.html") {
        const raw = readTemplate(root, "home.html");
        const home = raw ? applyAppChrome(raw, root, { active: "latest" }) : null;
        sendBytes(res, 200, home || '<!DOCTYPE html><meta charset="UTF-8"><p>请把 templates/home.html 复制到记录目录。</p>', "text/html; charset=utf-8");
        return;
      }
      if (pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          runtime: "node",
          service: SERVICE_NAME,
          version: SERVICE_VERSION,
          dataDir: root,
          sessionCount: listSessionFiles(root).length,
          port,
          homeUrl: "http://127.0.0.1:" + port + "/",
        });
        return;
      }
      if (pathname === "/api/home") {
        sendJson(res, 200, { ok: true, home: buildHome(root) });
        return;
      }
      if (pathname === "/api/map") {
        sendJson(res, 200, { ok: true, map: buildMap(root) });
        return;
      }
      if (pathname === "/api/assignments") {
        sendJson(res, 200, {
          ok: true,
          assignments: listJsonRecords(root, "assignments", "exam-assignment-").map((row) => ({
            file: row.file,
            ...row.data,
          })),
        });
        return;
      }
      const assignmentMatch = pathname.match(/^\/(api\/assignments|practice)\/([^/]+)$/);
      if (assignmentMatch) {
        const [, route, id] = assignmentMatch;
        const file = findAssignmentPath(root, id);
        const assignment = file && loadJson(file, null);
        if (!assignment || (route === "practice" && assignment.schemaVersion !== 1)) {
          sendJson(res, 404, { ok: false, error: "未找到该试卷" });
          return;
        }
        if (route === "api/assignments") {
          sendJson(res, 200, { ok: true, assignment });
          return;
        }
        try {
          const template = readTemplate(root, "practice.html");
          if (!template) throw new Error("请把 templates/practice.html 复制到记录目录");
          const html = renderPractice(template, assignment, root, { active: "latest" });
          sendBytes(res, 200, html, "text/html; charset=utf-8");
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
      }
      if (pathname === "/api/sessions") {
        sendJson(res, 200, {
          ok: true,
          sessions: loadSessions(root).map((item) => ({
            file: "sessions/" + path.basename(item.path),
            submitted: isSubmitted(item.data),
            ...item.data,
          })),
        });
        return;
      }
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const rec = loadSessionById(root, sessionMatch[1]);
        if (!rec) {
          sendJson(res, 404, { ok: false, error: "未找到该场次" });
          return;
        }
        sendJson(res, 200, { ok: true, session: { ...rec, submitted: isSubmitted(rec) } });
        return;
      }
      if (pathname.startsWith("/pages/")) {
        const rel = pathname.slice("/pages/".length);
        const target = safePagePath(root, rel);
        if (!target) {
          sendJson(res, 403, { ok: false, error: "路径不允许" });
          return;
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          sendJson(res, 404, { ok: false, error: "页面不存在" });
          return;
        }
        const ext = path.extname(target).toLowerCase();
        if (ext === ".html" || ext === ".htm") {
          let html = fs.readFileSync(target, "utf8");
          if (!wantsEmbed(req, url)) {
            html = injectAppChrome(html, root, { active: "latest" });
          }
          sendBytes(res, 200, html, "text/html; charset=utf-8");
          return;
        }
        sendBytes(res, 200, fs.readFileSync(target), "application/octet-stream");
        return;
      }
      sendJson(res, 404, { ok: false, error: "未找到接口" });
      return;
    }

    if (req.method === "POST") {
      if (pathname === "/api/shutdown") {
        sendJson(res, 200, { ok: true, shuttingDown: true });
        setImmediate(() => {
          if (controls && typeof controls.shutdown === "function") controls.shutdown();
        });
        return;
      }
      if (!["/api/sessions", "/api/assignments"].includes(pathname)) {
        sendJson(res, 404, { ok: false, error: "未找到接口" });
        return;
      }
      const length = Number(req.headers["content-length"] || 0);
      if (!length || length > MAX_BODY) {
        sendJson(res, 400, { ok: false, error: "请求体无效或过大" });
        return;
      }
      const chunks = [];
      let received = 0;
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (pathname === "/api/sessions") {
            const record = applyStartedAt(root, validateRecord(payload));
            const filePath = resolveSessionWritePath(root, record);
            writeJson(filePath, record);
            sendJson(res, 200, {
              ok: true,
              file: "sessions/" + path.basename(filePath),
              dataDir: root,
              submitted: isSubmitted(record),
              startedAt: record.startedAt || "",
              summary: record.summary || {},
            });
            return;
          }
          if (pathname === "/api/assignments") {
            sendJson(res, 200, { ok: true, ...saveAssignment(root, payload) });
            return;
          }
        } catch (err) {
          if (err instanceof SyntaxError) {
            sendJson(res, 400, { ok: false, error: "JSON 无法解析" });
            return;
          }
          sendJson(res, 400, { ok: false, error: err.message || "记录无效" });
        }
      });
      req.on("error", () => {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: "请求体无效或过大" });
      });
      return;
    }

    sendJson(res, 405, { ok: false, error: "方法不允许" });
  };
}


function sameDataDir(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)) === path.resolve(String(b));
}

function shouldReuse(existing, root, version = SERVICE_VERSION) {
  return Boolean(
    existing &&
    existing.ok &&
    existing.runtime === "node" &&
    existing.service === SERVICE_NAME &&
    existing.version === version &&
    sameDataDir(existing.dataDir, root)
  );
}

function listenPids(port) {
  const pids = new Set();
  const add = (text) => {
    const raw = String(text || "");
    for (const m of raw.matchAll(/pid=(\d+)/g)) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0 && n !== process.pid) pids.add(n);
    }
    if (!/pid=/.test(raw)) {
      for (const token of raw.split(/[^\d]+/)) {
        const n = Number(token);
        if (Number.isInteger(n) && n > 0 && n !== process.pid && n !== Number(port)) pids.add(n);
      }
    }
  };
  const run = (cmd, captureErr) => {
    try {
      add(execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", captureErr ? "pipe" : "ignore"] }));
    } catch (err) {
      if (captureErr) add(`${err && err.stdout ? err.stdout : ""}\n${err && err.stderr ? err.stderr : ""}`);
    }
  };
  run(`lsof -nP -iTCP:${Number(port)} -sTCP:LISTEN -t`, false);
  run(`fuser ${Number(port)}/tcp`, true);
  run(`ss -lptn "sport = :${Number(port)}"`, false);
  return [...pids];
}

function postJson(port, pathname, body, timeout = 1000) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body == null ? {} : body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      timeout,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilDown(port, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await probe(port);
    if (!health) return true;
    await sleep(50);
  }
  return !(await probe(port));
}

async function stopExamAssistant(port) {
  const existing = await probe(port);
  if (!existing || !existing.ok || existing.service !== SERVICE_NAME) return false;
  await postJson(port, "/api/shutdown", {});
  if (await waitUntilDown(port, 2000)) return true;
  for (const pid of listenPids(port)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  if (await waitUntilDown(port, 2000)) return true;
  for (const pid of listenPids(port)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  return waitUntilDown(port, 1000);
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({
      host: "127.0.0.1",
      port,
      path: "/api/health",
      timeout: 1000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function parseArgs(argv) {
  const args = {
    port: Number(process.env.EXAM_ASSISTANT_PORT || DEFAULT_PORT),
    dataDir: process.env.EXAM_ASSISTANT_DATA_DIR || null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      args.port = Number(a.slice("--port=".length));
    } else if (a === "--data-dir" && argv[i + 1]) {
      args.dataDir = argv[++i];
    } else if (a.startsWith("--data-dir=")) {
      args.dataDir = a.slice("--data-dir=".length);
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    throw new Error("端口无效");
  }
  return args;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const root = args.dataDir ? path.resolve(args.dataDir) : dataDir();
  ensureDirs(root);

  const existing = await probe(args.port);
  if (shouldReuse(existing, root)) {
    console.log(`考试助手记录服务已在运行：http://127.0.0.1:${args.port}`);
    console.log(`记录目录：${existing.dataDir || root}`);
    console.log(`版本：${existing.version}`);
    return 0;
  }
  if (existing && existing.ok && existing.service === SERVICE_NAME) {
    const stopped = await stopExamAssistant(args.port);
    if (!stopped) {
      console.error(`无法停止 127.0.0.1:${args.port} 上的旧考试助手记录服务，请先停止后再启动。`);
      return 1;
    }
  } else if (existing && existing.ok) {
    console.error(`127.0.0.1:${args.port} 上已有其他服务在运行，请先停止后再启动考试助手记录服务。`);
    return 1;
  }

  const controls = {};
  const server = http.createServer();
  controls.shutdown = () => {
    server.close(() => {
      console.log("\n已停止。");
      process.exit(0);
    });
  };
  server.on("request", createHandler(root, args.port, controls));
  try {
    await listen(server, args.port, "127.0.0.1");
  } catch (err) {
    console.error(`无法监听 127.0.0.1:${args.port}：${err.message}`);
    return 1;
  }

  const addr = server.address();
  console.log(`考试助手记录服务已启动：http://127.0.0.1:${args.port}`);
  console.log(`记录目录：${root}`);
  console.log(`绑定地址：${addr && addr.address}:${addr && addr.port}`);
  console.log("只监听本机。按 Ctrl+C 停止。");

  const stop = () => {
    server.close(() => {
      console.log("\n已停止。");
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return null;
}

if (require.main === module) {
  main().then((code) => {
    if (code != null) process.exit(code);
  }).catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_PORT,
  SERVICE_NAME,
  SERVICE_VERSION,
  DEFAULT_DATA_DIR,
  dataDir,
  ensureDirs,
  createHandler,
  resolveSessionWritePath,
  applyStartedAt,
  validateRecord,
  validateAssignment,
  saveAssignment,
  renderPractice,
  applyAppChrome,
  injectAppChrome,
  wantsEmbed,
  writeJson,
  loadSessionById,
  isSubmitted,
  parseArgs,
  probe,
  main,
  shouldReuse,
  stopExamAssistant,
  buildMap,
  isTopicDue,
  isPendingWrong,
  normalizeMastery,
  MASTERY_LEVELS,
};
