#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 17922;
const SERVICE_NAME = "exam-assistant";
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
  return {
    ...payload,
    id: payload.id || payload.sessionId || "paper",
    sessionId: payload.sessionId || payload.id || "paper",
    title: payload.title || "未命名试卷",
    createdAt: payload.createdAt || nowIso(),
    status: payload.status || "assigned",
  };
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

function readTemplate(root) {
  const names = [
    path.join(__dirname, "..", "templates", "home.html"),
    path.join(__dirname, "templates", "home.html"),
    path.join(__dirname, "home.html"),
    path.join(root, "home.html"),
  ];
  for (const file of names) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return fs.readFileSync(file, "utf8");
    }
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>考试助手</title></head>
<body><p>未找到 home.html 模板。请把 templates/home.html 复制到记录目录后重新启动服务。</p></body></html>`;
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

function createHandler(root, port) {
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
        sendBytes(res, 200, readTemplate(root), "text/html; charset=utf-8");
        return;
      }
      if (pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          runtime: "node",
          service: SERVICE_NAME,
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
        const ctype = ext === ".html" || ext === ".htm" ? "text/html; charset=utf-8" : "application/octet-stream";
        sendBytes(res, 200, fs.readFileSync(target), ctype);
        return;
      }
      sendJson(res, 404, { ok: false, error: "未找到接口" });
      return;
    }

    if (req.method === "POST") {
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
            const record = validateAssignment(payload);
            const existingPath = findAssignmentPath(root, record.sessionId);
            const filename = existingPath ? path.basename(existingPath) : assignmentFilename(record);
            const filePath = existingPath || path.join(root, "assignments", filename);
            writeJson(filePath, record);
            sendJson(res, 200, { ok: true, file: "assignments/" + filename, assignment: record });
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
  if (existing && existing.ok && existing.runtime === "node" && existing.service === SERVICE_NAME) {
    console.log(`考试助手记录服务已在运行：http://127.0.0.1:${args.port}`);
    console.log(`记录目录：${existing.dataDir || root}`);
    return 0;
  }
  if (existing && existing.ok) {
    console.error(`127.0.0.1:${args.port} 上已有其他服务在运行，请先停止后再启动考试助手记录服务。`);
    return 1;
  }

  const server = http.createServer(createHandler(root, args.port));
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
  DEFAULT_DATA_DIR,
  dataDir,
  ensureDirs,
  createHandler,
  resolveSessionWritePath,
  applyStartedAt,
  validateRecord,
  validateAssignment,
  writeJson,
  loadSessionById,
  isSubmitted,
  parseArgs,
  probe,
  main,
};
