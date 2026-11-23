#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const serverPath = path.resolve(__dirname, "..", "tools", "exam-server.js");
const {
  DEFAULT_PORT,
  SERVICE_NAME,
  DEFAULT_DATA_DIR,
  createHandler,
  ensureDirs,
  writeJson,
  loadSessionById,
  isSubmitted,
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
  const handler = createHandler(root, preferredPort || DEFAULT_PORT);
  const server = http.createServer(handler);
  let addr;
  try {
    addr = await listen(server, preferredPort || DEFAULT_PORT, "127.0.0.1");
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      addr = await listen(server, 0, "127.0.0.1");
      server.removeAllListeners("request");
      server.on("request", createHandler(root, addr.port));
    } else {
      throw err;
    }
  }
  return { server, port: addr.port, address: addr.address };
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
  assert.ok(!home.includes("能力地图"));
  assert.ok(!home.includes("公考"));
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

async function main() {
  const tests = [
    ["constants and templates", testConstantsAndTemplateKinds],
    ["atomic write uses temp dir only", testAtomicWriteAndNoUserDir],
    ["health and bind address", testHealthAndBind],
    ["assignments and home", testAssignmentsAndHome],
    ["session draft/submit overwrite rules", testSessionDraftSubmitRules],
    ["reuse running server", testReuseRunningServer],
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
