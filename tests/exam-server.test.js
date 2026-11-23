#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const serverPath = path.resolve(__dirname, "..", "tools", "exam-server.js");
const commandPath = path.resolve(__dirname, "..", "tools", "start-exam-server.command");
const {
  DEFAULT_PORT,
  SERVICE_NAME,
  SERVICE_VERSION,
  DEFAULT_DATA_DIR,
  createHandler,
  ensureDirs,
  writeJson,
  loadSessionById,
  isSubmitted,
  shouldReuse,
} = require(serverPath);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "exam-assistant-test-"));
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      } : { Accept: "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = raw;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function tryConnect(host, port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout: 1000 }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.code || err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "TIMEOUT" });
    });
  });
}

async function startTestServer(root, preferredPort) {
  const holder = { handler: null };
  const server = http.createServer((req, res) => holder.handler(req, res));
  const controls = {
    shutdown() {
      server.close();
    },
  };
  let addr;
  try {
    addr = await listen(server, preferredPort || DEFAULT_PORT, "127.0.0.1");
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      addr = await listen(server, 0, "127.0.0.1");
    } else {
      throw err;
    }
  }
  holder.handler = createHandler(root, addr.port, controls);
  return { server, port: addr.port, address: addr.address };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function waitForOutput(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("timed out waiting for " + pattern + " in: " + out));
    }, timeoutMs);
    const take = (buf) => {
      out += buf.toString();
      if (pattern.test(out)) {
        clearTimeout(timer);
        child.stdout.off("data", take);
        child.stderr.off("data", take);
        resolve(out);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 2000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function testHealthAndBind() {
  const root = tmpDir();
  ensureDirs(root);
  const { server, port, address } = await startTestServer(root, DEFAULT_PORT);
  try {
    assert.strictEqual(address, "127.0.0.1");
    const health = await request(port, "GET", "/api/health");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.data.ok, true);
    assert.strictEqual(health.data.runtime, "node");
    assert.strictEqual(health.data.service, SERVICE_NAME);
    assert.strictEqual(health.data.version, SERVICE_VERSION);
    assert.ok(SERVICE_VERSION);
    assert.strictEqual(health.data.dataDir, root);
    assert.strictEqual(health.data.port, port);
    assert.ok(String(health.data.homeUrl).includes("127.0.0.1"));
    assert.notStrictEqual(root, DEFAULT_DATA_DIR);
    assert.ok(!root.startsWith(DEFAULT_DATA_DIR));
    assert.ok(!root.startsWith("/home/box/"));

    const external = await tryConnect("0.0.0.0", port, "/api/health");
    if (external.ok) {
      // Binding 127.0.0.1 should not accept connections via a non-loopback interface.
      // 0.0.0.0 as a request host may still mean loopback on some systems; verify with a
      // non-loopback address if one exists.
    }
    const nics = Object.values(os.networkInterfaces() || {}).flat().filter((n) => n && n.family === "IPv4" && !n.internal);
    if (nics.length) {
      const fromLan = await tryConnect(nics[0].address, port, "/api/health");
      assert.strictEqual(fromLan.ok, false, "server must not accept connections on public interfaces");
    }
    const loopback = await tryConnect("127.0.0.1", port, "/api/health");
    assert.strictEqual(loopback.ok, true);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testAssignmentsAndHome() {
  const root = tmpDir();
  ensureDirs(root);
  const { server, port } = await startTestServer(root, 0);
  try {
    const payload = {
      sessionId: "2026-11-22-demo-01",
      title: "材料练习",
      mode: "material",
      questionCount: 5,
      durationMinutes: 10,
      page: "2026-11-22-材料练习.html",
    };
    const created = await request(port, "POST", "/api/assignments", payload);
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.data.ok, true);
    assert.ok(created.data.file.startsWith("assignments/exam-assignment-"));
    const filePath = path.join(root, created.data.file);
    assert.ok(fs.existsSync(filePath));

    const listed = await request(port, "GET", "/api/assignments");
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listed.data.assignments.length, 1);
    assert.strictEqual(listed.data.assignments[0].sessionId, payload.sessionId);

    const again = await request(port, "POST", "/api/assignments", { ...payload, title: "材料练习（更新）" });
    assert.strictEqual(again.status, 200);
    const listed2 = await request(port, "GET", "/api/assignments");
    assert.strictEqual(listed2.data.assignments.length, 1);
    assert.strictEqual(listed2.data.assignments[0].title, "材料练习（更新）");

    const home = await request(port, "GET", "/api/home");
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.data.home.papers.length, 1);
    assert.strictEqual(home.data.home.latest.sessionId, payload.sessionId);
    assert.strictEqual(home.data.home.latest.submitted, false);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testSessionDraftSubmitRules() {
  const root = tmpDir();
  ensureDirs(root);
  const { server, port } = await startTestServer(root, 0);
  try {
    const startedAt = "2026-11-22T08:00:00Z";
    const draft1 = {
      sessionId: "sess-keep-start",
      title: "练习",
      startedAt,
      savedAt: "2026-11-22T08:01:00Z",
      submitted: false,
      items: [{ id: "q1", kind: "choice", userAnswer: "A", correctAnswer: "B", correct: false }],
    };
    const first = await request(port, "POST", "/api/sessions", draft1);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.data.file, "sessions/exam-session-sess-keep-start.json");
    const path1 = path.join(root, first.data.file);
    assert.ok(fs.existsSync(path1));

    const draft2 = {
      ...draft1,
      startedAt: "2026-11-22T09:00:00Z",
      savedAt: "2026-11-22T08:02:00Z",
      items: [{ id: "q1", kind: "choice", userAnswer: "B", correctAnswer: "B", correct: true }],
    };
    const second = await request(port, "POST", "/api/sessions", draft2);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.file, first.data.file);
    assert.strictEqual(second.data.startedAt, startedAt);
    const afterDraft = JSON.parse(fs.readFileSync(path1, "utf8"));
    assert.strictEqual(afterDraft.startedAt, startedAt);
    assert.strictEqual(afterDraft.submitted, false);
    assert.strictEqual(afterDraft.items[0].userAnswer, "B");
    assert.strictEqual(isSubmitted(afterDraft), false);

    const submitted = {
      ...draft2,
      startedAt: "2026-11-22T10:00:00Z",
      savedAt: "2026-11-22T08:05:00Z",
      submitted: true,
      summary: { total: 1, scored: 1, correct: 1, accuracy: 1 },
    };
    const third = await request(port, "POST", "/api/sessions", submitted);
    assert.strictEqual(third.status, 200);
    assert.strictEqual(third.data.file, first.data.file);
    assert.strictEqual(third.data.submitted, true);
    assert.strictEqual(third.data.startedAt, startedAt);
    const afterSubmit = JSON.parse(fs.readFileSync(path1, "utf8"));
    assert.strictEqual(afterSubmit.submitted, true);
    assert.strictEqual(afterSubmit.startedAt, startedAt);
    assert.strictEqual(afterSubmit.summary.correct, 1);

    const laterDraft = {
      sessionId: "sess-keep-start",
      title: "练习",
      startedAt: "2026-11-22T11:00:00Z",
      savedAt: "2026-11-22T08:06:00Z",
      submitted: false,
      items: [{ id: "q1", kind: "choice", userAnswer: "A", correctAnswer: "B", correct: false }],
    };
    const fourth = await request(port, "POST", "/api/sessions", laterDraft);
    assert.strictEqual(fourth.status, 200);
    assert.ok(fourth.data.file.includes("draft"), "draft after submit must not overwrite the submitted file");
    assert.notStrictEqual(fourth.data.file, first.data.file);
    const stillSubmitted = JSON.parse(fs.readFileSync(path1, "utf8"));
    assert.strictEqual(stillSubmitted.submitted, true);
    assert.strictEqual(stillSubmitted.items[0].userAnswer, "B");
    assert.strictEqual(stillSubmitted.startedAt, startedAt);

    const fetched = await request(port, "GET", "/api/sessions/sess-keep-start");
    assert.strictEqual(fetched.status, 200);
    assert.strictEqual(fetched.data.session.submitted, true);
    assert.strictEqual(fetched.data.session.items[0].userAnswer, "B");
    assert.strictEqual(loadSessionById(root, "sess-keep-start").submitted, true);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testReuseRunningServer() {
  const root = tmpDir();
  const { server, port } = await startTestServer(root, 0);
  try {
    const child = spawn(process.execPath, [serverPath, "--port", String(port), "--data-dir", root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("reuse probe timed out"));
      }, 5000);
      const take = (buf) => { out += buf.toString(); };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
    assert.strictEqual(output.code, 0);
    assert.match(output.out, /已在运行/);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testConstantsAndTemplateKinds() {
  assert.strictEqual(DEFAULT_PORT, 17922);
  assert.strictEqual(SERVICE_NAME, "exam-assistant");
  assert.strictEqual(SERVICE_VERSION, "1.1.0");
  assert.strictEqual(DEFAULT_DATA_DIR, path.join(os.homedir(), ".exam-assistant"));
  const practice = fs.readFileSync(path.resolve(__dirname, "..", "templates", "practice.html"), "utf8");
  for (const kind of ["choice", "multi", "order", "fill", "essay"]) {
    assert.ok(practice.includes(`"${kind}"`) || practice.includes(`'${kind}'`) || practice.includes(`kind === "${kind}"`) || practice.includes(`"${kind}":`), `practice page should handle kind ${kind}`);
  }
  assert.ok(practice.includes("17922"));
  assert.ok(practice.includes("window.EXAM_SESSION"));
  assert.ok(!practice.toLowerCase().includes("gongkao"));
  assert.ok(!practice.includes("公考"));
  assert.ok(practice.includes("submit()"));
  assert.ok(practice.includes("left <= 0"));
  const home = fs.readFileSync(path.resolve(__dirname, "..", "templates", "home.html"), "utf8");
  assert.ok(home.includes("最近一次试卷"));
  assert.ok(home.includes("历史试卷"));
  assert.ok(home.includes("学习地图"));
  assert.ok(home.includes("/api/map"));
  assert.ok(home.includes("function modeLabel"));
  assert.ok(home.includes("新知练习"));
  assert.ok(home.includes("错题复习"));
  assert.ok(home.includes("定期复习"));
  assert.ok(home.includes("综合练习"));
  assert.ok(home.includes("指定范围"));
  assert.ok(home.includes("modeLabel(row.mode)"));
  assert.ok(practice.includes("function modeLabel"));
  assert.ok(practice.includes("新知练习"));
  assert.ok(practice.includes("错题复习"));
  assert.ok(practice.includes("定期复习"));
  assert.ok(practice.includes("综合练习"));
  assert.ok(practice.includes("指定范围"));
  assert.ok(!home.includes("能力地图"));
  assert.ok(!home.includes("公考"));
  assert.ok(!home.toLowerCase().includes("gongkao"));
  const source = fs.readFileSync(serverPath, "utf8");
  assert.ok(source.includes('listen(server, args.port, "127.0.0.1")') || source.includes('listen(server, args.port, \'127.0.0.1\')'));
  assert.ok(!source.includes("17813"));
  assert.ok(!source.includes("GONGKAO"));
}

async function testAtomicWriteAndNoUserDir() {
  const root = tmpDir();
  const target = path.join(root, "sessions", "exam-session-atomic.json");
  writeJson(target, { sessionId: "atomic", submitted: false, items: [] });
  assert.ok(fs.existsSync(target));
  assert.ok(!fs.existsSync(target + ".tmp"));
  assert.ok(!root.includes(DEFAULT_DATA_DIR));
  fs.rmSync(root, { recursive: true, force: true });
}


async function testMapEmptyDir() {
  const root = tmpDir();
  ensureDirs(root);
  const { server, port } = await startTestServer(root, 0);
  try {
    const res = await request(port, "GET", "/api/map");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    const map = res.data.map;
    assert.ok(map);
    assert.deepStrictEqual(map.topics, []);
    assert.deepStrictEqual(map.subjects, []);
    assert.strictEqual(map.summary.practiceCount, 0);
    assert.strictEqual(map.summary.pendingWrongCount, 0);
    assert.strictEqual(map.summary.dueCount, 0);
    assert.strictEqual(map.summary.byLevel["未练"], 0);
    assert.strictEqual(map.summary.byLevel["薄弱"], 0);
    assert.strictEqual(map.summary.byLevel["学习中"], 0);
    assert.strictEqual(map.summary.byLevel["掌握"], 0);
    assert.strictEqual(map.summary.accuracy, null);

    writeJson(path.join(root, "wrong-items.json"), {
      items: [{ id: "w1", topic: "孤立错题", status: "pending" }],
    });
    const stillEmpty = await request(port, "GET", "/api/map");
    assert.strictEqual(stillEmpty.data.map.topics.length, 0);
    assert.strictEqual(stillEmpty.data.map.summary.pendingWrongCount, 0);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testMapWithSampleArchive() {
  const root = tmpDir();
  ensureDirs(root);
  const { server, port } = await startTestServer(root, 0);
  try {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    writeJson(path.join(root, "state.json"), {
      updatedAt: new Date(now).toISOString(),
      topics: [
        { id: "t-new", topic: "新概念", subject: "科目甲", source: "材料A", mastery: "new", correct: 0, wrong: 0, last_seen: "" },
        { id: "t-weak-due", topic: "薄弱到期", subject: "科目甲", source: "材料A", mastery: "weak", correct: 1, wrong: 3, last_seen: iso(2 * day) },
        { id: "t-learn-fresh", topic: "学习中未到期", subject: "科目乙", source: "材料B", mastery: "learning", correct: 2, wrong: 1, last_seen: iso(3 * 60 * 60 * 1000) },
        { id: "t-learn-due", topic: "学习中到期", subject: "科目乙", source: "材料B", mastery: "learning", correct: 3, wrong: 2, last_seen: iso(2 * day) },
        { id: "t-master-fresh", topic: "已掌握未到期", subject: "科目甲", source: "材料A", mastery: "mastered", correct: 8, wrong: 1, last_seen: iso(3 * day) },
        { id: "t-master-due", topic: "已掌握到期", subject: "科目乙", source: "材料B", mastery: "mastered", correct: 6, wrong: 0, last_seen: iso(8 * day) },
        { id: "t-plain", topic: "未分科知识点", source: "材料C", mastery: "learning", correct: 1, wrong: 0, last_seen: iso(3 * 60 * 60 * 1000) },
      ],
      stats: { practiceCount: 4, questionCount: 20, answeredCount: 18, correctCount: 12 },
      sessions: [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }, { sessionId: "s4" }],
    });
    writeJson(path.join(root, "wrong-items.json"), {
      items: [
        { id: "w1", topicId: "t-weak-due", topic: "薄弱到期", status: "pending" },
        { id: "w2", topicId: "t-weak-due", topic: "薄弱到期", status: "待复习" },
        { id: "w3", topicId: "t-learn-due", topic: "学习中到期", status: "已掌握" },
        { id: "w4", topic: "未归档错题", status: "pending" },
      ],
    });

    const res = await request(port, "GET", "/api/map");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    const map = res.data.map;
    assert.strictEqual(map.summary.byLevel["未练"], 1);
    assert.strictEqual(map.summary.byLevel["薄弱"], 1);
    assert.strictEqual(map.summary.byLevel["学习中"], 3);
    assert.strictEqual(map.summary.byLevel["掌握"], 2);
    assert.strictEqual(map.summary.practiceCount, 4);
    assert.strictEqual(map.summary.answeredCount, 18);
    assert.strictEqual(map.summary.correctCount, 12);
    assert.strictEqual(map.summary.accuracy, Math.round((12 / 18) * 1000) / 1000);
    assert.strictEqual(map.summary.pendingWrongCount, 3);
    assert.strictEqual(map.summary.dueCount, 4);

    const byId = Object.fromEntries(map.topics.map((t) => [t.id, t]));
    assert.strictEqual(byId["t-new"].due, true);
    assert.strictEqual(byId["t-new"].level, "未练");
    assert.strictEqual(byId["t-weak-due"].due, true);
    assert.strictEqual(byId["t-weak-due"].pendingWrong, 2);
    assert.strictEqual(byId["t-learn-fresh"].due, false);
    assert.strictEqual(byId["t-learn-due"].due, true);
    assert.strictEqual(byId["t-learn-due"].pendingWrong, 0);
    assert.strictEqual(byId["t-master-fresh"].due, false);
    assert.strictEqual(byId["t-master-due"].due, true);

    const subjects = Object.fromEntries(map.subjects.map((s) => [s.name, s]));
    assert.ok(subjects["科目甲"]);
    assert.ok(subjects["科目乙"]);
    assert.strictEqual(subjects["科目甲"].topicCount, 3);
    assert.strictEqual(subjects["科目乙"].topicCount, 3);
    assert.ok(subjects["未分科目"]);
    assert.strictEqual(subjects["未分科目"].topicCount, 1);
    assert.strictEqual(subjects["未分科目"].topics[0].id, "t-plain");
    assert.strictEqual(subjects["未分科目"].topics[0].due, false);
    assert.strictEqual(subjects["科目甲"].pendingWrong, 2);
    assert.strictEqual(subjects["科目甲"].dueCount, 2);
    assert.strictEqual(subjects["科目乙"].dueCount, 2);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function collectRepoFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === ".git") continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...collectRepoFiles(full));
    else out.push(full);
  }
  return out;
}

function isProbablyText(file) {
  const ext = path.extname(file).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz"].includes(ext)) return false;
  return true;
}

async function testNoHardcodedUserHomeAndBranding() {
  const repoRoot = path.resolve(__dirname, "..");
  for (const file of collectRepoFiles(repoRoot)) {
    if (!isProbablyText(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const forbiddenHome = ["/Users", "songyanfei"].join("/");
    assert.ok(!text.includes(forbiddenHome), "hardcoded home path in " + path.relative(repoRoot, file));
    if (file.endsWith("home.html") || file.endsWith("practice.html") || file.endsWith("exam-server.js")) {
      assert.ok(!text.includes("公考"), "civil-service branding in " + path.relative(repoRoot, file));
      assert.ok(!text.toLowerCase().includes("gongkao"), "gongkao branding in " + path.relative(repoRoot, file));
    }
  }
  const home = fs.readFileSync(path.join(repoRoot, "templates", "home.html"), "utf8");
  assert.ok(home.includes("学习地图"));
  assert.ok(!home.includes("能力地图"));
}


async function testShouldReuse() {
  const root = path.resolve("/tmp/exam-assistant-reuse-a");
  const other = path.resolve("/tmp/exam-assistant-reuse-b");
  const base = {
    ok: true,
    runtime: "node",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    dataDir: root,
  };
  assert.strictEqual(shouldReuse(base, root), true);
  assert.strictEqual(shouldReuse({ ...base, dataDir: root + "/" }, root), true);
  assert.strictEqual(shouldReuse({ ...base, dataDir: other }, root), false);
  assert.strictEqual(shouldReuse({ ...base, version: "0.0.1" }, root), false);
  assert.strictEqual(shouldReuse({ ...base, version: undefined }, root), false);
  assert.strictEqual(shouldReuse({ ...base, service: "other" }, root), false);
  assert.strictEqual(shouldReuse(null, root), false);
}

async function testStartScriptOverwritesAndReuses() {
  const root = tmpDir();
  const staleServer = "console.log('stale-server-placeholder');\n";
  const staleHome = "<html><body>stale-home-placeholder</body></html>\n";
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "exam-server.js"), staleServer, "utf8");
  fs.writeFileSync(path.join(root, "home.html"), staleHome, "utf8");
  const port = await freePort();
  const env = {
    ...process.env,
    EXAM_ASSISTANT_DATA_DIR: root,
    EXAM_ASSISTANT_PORT: String(port),
  };
  const child = spawn("bash", [commandPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForOutput(child, /已启动/);
    const copiedServer = fs.readFileSync(path.join(root, "exam-server.js"), "utf8");
    const copiedHome = fs.readFileSync(path.join(root, "home.html"), "utf8");
    const srcServer = fs.readFileSync(serverPath, "utf8");
    const srcHome = fs.readFileSync(path.resolve(__dirname, "..", "templates", "home.html"), "utf8");
    assert.strictEqual(copiedServer, srcServer);
    assert.strictEqual(copiedHome, srcHome);
    assert.ok(!copiedServer.includes("stale-server-placeholder"));
    assert.ok(!copiedHome.includes("stale-home-placeholder"));
    const health = await request(port, "GET", "/api/health");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.data.version, SERVICE_VERSION);
    assert.strictEqual(health.data.dataDir, root);
    assert.strictEqual(health.data.service, SERVICE_NAME);

    const reuse = spawn("bash", [commandPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    const reuseOut = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        reuse.kill("SIGTERM");
        reject(new Error("reuse command timed out: " + out));
      }, 5000);
      const take = (buf) => { out += buf.toString(); };
      reuse.stdout.on("data", take);
      reuse.stderr.on("data", take);
      reuse.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
    assert.strictEqual(reuseOut.code, 0);
    assert.match(reuseOut.out, /已在运行/);
  } finally {
    await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRestartOnDataDirMismatch() {
  const rootA = tmpDir();
  const rootB = tmpDir();
  const port = await freePort();
  const childA = spawn(process.execPath, [serverPath, "--port", String(port), "--data-dir", rootA], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childB;
  try {
    await waitForOutput(childA, /已启动/);
    const first = await request(port, "GET", "/api/health");
    assert.strictEqual(first.data.dataDir, rootA);
    childB = spawn(process.execPath, [serverPath, "--port", String(port), "--data-dir", rootB], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForOutput(childB, /已启动/);
    const second = await request(port, "GET", "/api/health");
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.dataDir, rootB);
    assert.strictEqual(second.data.version, SERVICE_VERSION);
    const exitA = await new Promise((resolve) => {
      if (childA.exitCode != null) {
        resolve(childA.exitCode);
        return;
      }
      const timer = setTimeout(() => resolve("timeout"), 3000);
      childA.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.notStrictEqual(exitA, "timeout", "old process should exit after shutdown");
  } finally {
    await stopChild(childB);
    await stopChild(childA);
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
}

async function testShutdownEndpoint() {
  const root = tmpDir();
  ensureDirs(root);
  const { server, port } = await startTestServer(root, 0);
  try {
    const res = await request(port, "POST", "/api/shutdown", {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    const start = Date.now();
    let down = false;
    while (Date.now() - start < 3000) {
      const health = await tryConnect("127.0.0.1", port, "/api/health");
      if (!health.ok) {
        down = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(down, "server should close after /api/shutdown");
  } finally {
    try { await closeServer(server); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const tests = [
    ["constants and templates", testConstantsAndTemplateKinds],
    ["atomic write uses temp dir only", testAtomicWriteAndNoUserDir],
    ["no hardcoded user home or civil-service branding", testNoHardcodedUserHomeAndBranding],
    ["health and bind address", testHealthAndBind],
    ["assignments and home", testAssignmentsAndHome],
    ["session draft/submit overwrite rules", testSessionDraftSubmitRules],
    ["reuse running server", testReuseRunningServer],
    ["shouldReuse checks version and dataDir", testShouldReuse],
    ["start script overwrites templates and reuses", testStartScriptOverwritesAndReuses],
    ["restart when dataDir differs", testRestartOnDataDirMismatch],
    ["POST /api/shutdown", testShutdownEndpoint],
    ["/api/map empty dir", testMapEmptyDir],
    ["/api/map with sample archive", testMapWithSampleArchive],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("ok  - " + name);
    } catch (err) {
      failed += 1;
      console.error("fail - " + name);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  if (failed) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
}

main();
