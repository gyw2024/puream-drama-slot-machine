"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const SeedanceBridgePlugin = require("../plugin/lib/plugin/index");
const { BridgeClient, requestLocalBridge } = require("../app/bridge-client");

test("local bridge production transport has no hidden fetch response-header deadline", async t => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, taskId: "same-task" }));
    }, 80);
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  t.after(() => server.close());
  const address = server.address();
  const originalOrigin = `http://127.0.0.1:${address.port}`;
  const startedAt = Date.now();
  const response = await requestLocalBridge(originalOrigin, {}, originalOrigin);
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(await response.text()), { ok: true, taskId: "same-task" });
  assert.ok(Date.now() - startedAt >= 70, "the native client must keep waiting for delayed response headers");
  assert.match(requestLocalBridge.toString(), /http\.request/);
  assert.doesNotMatch(requestLocalBridge.toString(), /setTimeout|headersTimeout/);
});

test("local bridge preserves an authoritative retryable pre-task rejection", async t => {
  const fetchImpl = async () => new Response(JSON.stringify({
      ok: false,
      code: "SEEDANCE_SUBMISSION_BUSY",
      message: "操作频繁",
      retryable: true
    }), { status: 502, headers: { "content-type": "application/json" } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-local-retryable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new BridgeClient({ tokenPath: path.join(root, "bridge-token"), fetchImpl });
  client.configure({ kind: "local-xiangsu" });
  await assert.rejects(
    () => client.request("/v1/videos", { method: "POST", body: {} }),
    error => error?.code === "SEEDANCE_SUBMISSION_BUSY" && error?.retryable === true && !error?.taskId
  );
});

test("local multimedia upload waits for the reactive VID instead of failing after the early promise", async () => {
  const instance = {
    audioInfo: { _value: { uploadState: "Uploading", vid: "" } }
  };
  let polls = 0;
  const info = await SeedanceBridgePlugin.waitForReferenceMediaUpload(instance, "audio", {
    pollMs: 10,
    sleep: async () => {
      polls += 1;
      if (polls === 2) instance.audioInfo._value = { uploadState: "UploadSuccess", vid: "valid-audio-vid" };
    }
  });
  assert.equal(polls, 2);
  assert.equal(info.vid, "valid-audio-vid");
});

test("local multimedia upload still stops on an authoritative terminal rejection", async () => {
  const instance = {
    videoInfo: { _value: { uploadState: "AuditFailed", vid: "", message: "media audit rejected" } }
  };
  await assert.rejects(
    SeedanceBridgePlugin.waitForReferenceMediaUpload(instance, "video", { sleep: async () => {} }),
    error => error?.code === "MEDIA_UPLOAD_FAILED"
      && error?.uploadState === "AuditFailed"
      && /media audit rejected/.test(error.message)
  );
});

test("local multimedia upload releases a stalled native handshake for retry", async () => {
  const instance = {
    audioInfo: { _value: { uploadState: "Uploading", vid: "" } }
  };
  let now = 0;
  await assert.rejects(
    SeedanceBridgePlugin.waitForReferenceMediaUpload(instance, "audio", {
      pollMs: 10,
      stallMs: 1_000,
      now: () => now,
      sleep: async () => { now += 500; }
    }),
    error => error?.code === "MEDIA_UPLOAD_STALLED" && error?.retryable === true
  );
});

test("local native multimedia VID handshakes are serialized while video tasks stay concurrent", async () => {
  let active = 0;
  let maximum = 0;
  const order = [];
  const run = id => SeedanceBridgePlugin.runReferenceMediaUploadExclusive(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    order.push(`start-${id}`);
    await new Promise(resolve => setImmediate(resolve));
    order.push(`end-${id}`);
    active -= 1;
    return id;
  });
  assert.deepEqual(await Promise.all([run(1), run(2), run(3)]), [1, 2, 3]);
  assert.equal(maximum, 1);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});

test("identical reference media is coalesced by content instead of temporary path", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-media-content-cache-"));
  t.after(() => {
    SeedanceBridgePlugin.clearReferenceMediaUploadCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const firstPath = path.join(tempRoot, "first.wav");
  const secondPath = path.join(tempRoot, "second.wav");
  fs.writeFileSync(firstPath, "same-reference-audio", "utf8");
  fs.writeFileSync(secondPath, "same-reference-audio", "utf8");
  const firstKey = SeedanceBridgePlugin.referenceMediaContentKey("audio", firstPath);
  const secondKey = SeedanceBridgePlugin.referenceMediaContentKey("audio", secondPath);
  assert.equal(firstKey, secondKey);

  SeedanceBridgePlugin.clearReferenceMediaUploadCache();
  let uploads = 0;
  const factory = async () => {
    uploads += 1;
    await new Promise(resolve => setImmediate(resolve));
    return { uploadState: "UploadSuccess", vid: "v02f3eg10004da0i89q7dld53nr670vg" };
  };
  const results = await Promise.all([
    SeedanceBridgePlugin.cachedReferenceMediaUpload(firstKey, factory),
    SeedanceBridgePlugin.cachedReferenceMediaUpload(secondKey, factory)
  ]);
  assert.equal(uploads, 1);
  assert.deepEqual(results.map(item => item.vid), ["v02f3eg10004da0i89q7dld53nr670vg", "v02f3eg10004da0i89q7dld53nr670vg"]);
  const cached = await SeedanceBridgePlugin.cachedReferenceMediaUpload(firstKey, factory);
  assert.equal(uploads, 1);
  assert.equal(cached.cacheHit, true);
});

test("reference audio uses Xiangsu space upload and its audited VID", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-direct-reference-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const audioPath = path.join(tempRoot, "voice.wav");
  fs.writeFileSync(audioPath, Buffer.from("direct-reference-audio"));
  const calls = [];
  const result = await SeedanceBridgePlugin.uploadReferenceMediaDirect({
    uploadApi: {
      FileType: { Audio: 6, Video: 2 },
      async uploadToSpace(argument) {
        calls.push(argument);
        return { code: 0, data: { videoInfo: { vid: "v02f3eg10004da0i89q7dld53nr670vg" } } };
      }
    }
  }, "audio", { stagedPath: audioPath });
  assert.equal(result.vid, "v02f3eg10004da0i89q7dld53nr670vg");
  assert.equal(result.transport, "uploadToSpace");
  assert.deepEqual(calls, [{ filePath: audioPath, fileType: 6 }]);
});

test("raw image-storage keys can never enter audio/video review lists", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-invalid-reference-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const audioPath = path.join(tempRoot, "voice.wav");
  fs.writeFileSync(audioPath, Buffer.from("invalid-reference-audio"));
  await assert.rejects(() => SeedanceBridgePlugin.uploadReferenceMediaDirect({
    uploadApi: {
      FileType: { Audio: 6, Video: 2 },
      async uploadToSpace() {
        return { code: 0, data: { decryptedUri: "ies.fe.effect/not-a-media-vid" } };
      }
    }
  }, "audio", { stagedPath: audioPath }), error => error?.code === "REFERENCE_MEDIA_VID_INVALID");
  assert.throws(() => SeedanceBridgePlugin.buildSubmitParams({
    prompt: "剧情从第0秒直接开始",
    uploadedAudios: [{ vid: "ies.fe.effect/not-a-media-vid" }]
  }), error => error?.code === "REFERENCE_MEDIA_VID_INVALID");
});

test("local bridge blocks sub-three-second H3 audio before a paid task is created", () => {
  assert.deepEqual(SeedanceBridgePlugin.validateReferenceAudioDurations([]), { ok: true, total: 0 });
  const rejected = SeedanceBridgePlugin.validateReferenceAudioDurations([{ duration: 1.491 }]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "REFERENCE_AUDIO_TOO_SHORT");
  assert.match(rejected.message, /3\.05/);
  assert.deepEqual(SeedanceBridgePlugin.validateReferenceAudioDurations([
    { duration: 3.2 },
    { duration: 4.8 },
    { duration: 4.8 }
  ]), { ok: true, total: 12.8 });
});

test("a fully consumed request body is not mistaken for a disconnected desktop client", () => {
  assert.equal(SeedanceBridgePlugin.clientConnectionClosed({
    aborted: false,
    destroyed: true,
    socket: { destroyed: false }
  }, {
    destroyed: false,
    closed: false,
    writableEnded: false
  }), false);
  assert.equal(SeedanceBridgePlugin.clientConnectionClosed({ aborted: true, socket: { destroyed: false } }, {}), true);
  assert.equal(SeedanceBridgePlugin.clientConnectionClosed({ aborted: false, socket: { destroyed: true } }, {}), true);
  assert.equal(SeedanceBridgePlugin.clientConnectionClosed({ aborted: false, socket: { destroyed: false } }, { destroyed: true }), true);
});

test("the bundled bridge installs its declared version and detects a running stale plugin", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-plugin-version-"));
  const previousRoot = process.env.XIANGSU_PLUGIN_ROOT;
  try {
    const localSlot = path.join(tempRoot, "v9.1.2", "Local");
    fs.mkdirSync(localSlot, { recursive: true });
    process.env.XIANGSU_PLUGIN_ROOT = tempRoot;
    const client = new BridgeClient({
      tokenPath: path.join(tempRoot, "state", "bridge-token"),
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        ready: true,
        sessionReady: true,
        version: "0.2.0"
      }), { status: 200, headers: { "content-type": "application/json" } })
    });
    const installation = client.ensurePluginInstalled();
    assert.equal(installation.version, "0.2.13");
    assert.equal(fs.existsSync(path.join(localSlot, "SeedanceBridge@0.2.13", "lib", "plugin", "index.js")), true);
    const config = JSON.parse(fs.readFileSync(path.join(localSlot, "plugins.config.json"), "utf8"));
    assert.deepEqual(config.plugins, [{ name: "SeedanceBridge", version: "0.2.13", loadOnStartup: true }]);
    assert.equal(client.ensurePluginInstalled().updated, false, "an unchanged bridge must not be recopied on every health poll");

    const health = await client.health();
    assert.equal(health.ok, false);
    assert.equal(health.ready, false);
    assert.equal(health.code, "XIANGSU_PLUGIN_RESTART_REQUIRED");
    assert.equal(health.runningVersion, "0.2.0");
    assert.equal(health.expectedVersion, "0.2.13");
    assert.equal(health.restartRequired, true);
  } finally {
    if (previousRoot === undefined) delete process.env.XIANGSU_PLUGIN_ROOT;
    else process.env.XIANGSU_PLUGIN_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("desktop task metadata repairs a post-restart plugin mapping and reuses the original task", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-plugin-resume-"));
  const previousTokenPath = process.env.SEEDANCE_BRIDGE_TOKEN_PATH;
  try {
    process.env.SEEDANCE_BRIDGE_TOKEN_PATH = path.join(tempRoot, "plugin-state", "bridge-token");
    const tasks = new Map();
    const taskId = "wf12026081604004639779672470530";
    const outputDir = path.join(tempRoot, "project", "videos");
    const recovered = SeedanceBridgePlugin.recoverTaskOutputMapping(tasks, taskId, outputDir);
    assert.equal(recovered.outputDir, path.resolve(outputDir));
    assert.equal(recovered.recoveredFromDesktopRegistry, true);
    assert.equal(tasks.get(taskId), recovered);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tempRoot, "plugin-state", "xiangsu-tasks.json"), "utf8"))[taskId].outputDir, path.resolve(outputDir));

    let requestedUrl = "";
    const client = new BridgeClient({
      tokenPath: path.join(tempRoot, "desktop-state", "bridge-token"),
      fetchImpl: async url => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ ok: true, taskId, status: "running" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    client.configure({ kind: "local-xiangsu" });
    client.saveRemoteTask(taskId, { providerKind: "local-xiangsu", outputDir });
    await client.query(taskId);
    const request = new URL(requestedUrl);
    assert.equal(request.pathname, `/v1/videos/${taskId}`);
    assert.equal(request.searchParams.get("outputDir"), outputDir);
  } finally {
    if (previousTokenPath === undefined) delete process.env.SEEDANCE_BRIDGE_TOKEN_PATH;
    else process.env.SEEDANCE_BRIDGE_TOKEN_PATH = previousTokenPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("local task registry finds a prior paid task by stable client request id", () => {
  const tasks = new Map([
    ["wf12026081604004639779672470530", { clientRequestId: "drama-video-stable-001", outputDir: "C:\\output" }]
  ]);
  assert.deepEqual(SeedanceBridgePlugin.findTaskByClientRequestId(tasks, "drama-video-stable-001"), {
    taskId: "wf12026081604004639779672470530",
    task: tasks.get("wf12026081604004639779672470530")
  });
  assert.equal(SeedanceBridgePlugin.findTaskByClientRequestId(tasks, "different-request"), null);
});

test("a terminal busy task is preserved in history but released for a fresh retry", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-terminal-task-retry-"));
  const previousTokenPath = process.env.SEEDANCE_BRIDGE_TOKEN_PATH;
  t.after(() => {
    if (previousTokenPath === undefined) delete process.env.SEEDANCE_BRIDGE_TOKEN_PATH;
    else process.env.SEEDANCE_BRIDGE_TOKEN_PATH = previousTokenPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  process.env.SEEDANCE_BRIDGE_TOKEN_PATH = path.join(tempRoot, "bridge-token");
  const taskId = "wf12026081610070639804242995714";
  const tasks = new Map([[taskId, { clientRequestId: "drama-video-stable-busy", outputDir: tempRoot }]]);
  const reusable = await SeedanceBridgePlugin.resolveReusableTask({
    aiEffectApi: {
      async queryAIGCResult() {
        return { code: 0, data: { status: 3, errorCode: 803085005, message: "AI is busy" } };
      }
    }
  }, tasks, "drama-video-stable-busy");
  assert.equal(reusable, null);
  assert.equal(tasks.get(taskId).terminalStatus, "failed");
  assert.equal(tasks.get(taskId).terminalErrorCode, 803085005);
  assert.equal(SeedanceBridgePlugin.findTaskByClientRequestId(tasks, "drama-video-stable-busy"), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempRoot, "xiangsu-tasks.json"), "utf8"))[taskId].terminalStatus, "failed");
});

test("an authoritative pre-task busy response is retryable without inventing a task id", () => {
  const failure = SeedanceBridgePlugin.submitFailure({
    body: { code: 0, data: { code: 803085005, bizMsg: "操作频繁" } }
  });
  assert.equal(failure.code, "SEEDANCE_SUBMISSION_BUSY");
  assert.equal(failure.retryable, true);
  assert.equal(failure.result.upstreamCode, 0);
});

test("a local daily generation limit is terminal and never disguised as bridge retry", () => {
  const failure = SeedanceBridgePlugin.submitFailure({
    body: { code: 0, data: { code: 2038, hasNoQuota: true, bizMsg: "Seedance2.0mini 模型今日已达使用次数上限" } }
  });
  assert.equal(failure.code, "SEEDANCE_DAILY_QUOTA_EXHAUSTED");
  assert.notEqual(failure.retryable, true);
  assert.equal(failure.result.hasNoQuota, true);
});

test("local submission relaunches once only when the TCP connection was never accepted", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-local-submit-recovery-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const client = new BridgeClient({ tokenPath: path.join(tempRoot, "bridge-token"), fetchImpl: async () => new Response("{}") });
  client.configure({ kind: "local-xiangsu" });
  const readiness = [];
  let requests = 0;
  client.ensureLocalSubmissionBridge = async options => {
    readiness.push(options || {});
    return { ok: true, ready: true, sessionReady: true };
  };
  client.request = async () => {
    requests += 1;
    if (requests === 1) throw Object.assign(new Error("offline before connect"), { code: "ECONNREFUSED" });
    return { ok: true, taskId: "wf12026081604004639779672470531", status: "running" };
  };
  const result = await client.submitScoped({
    ability: "SD_2.0_MINI",
    clientRequestId: "drama-video-stable-002",
    prompt: "A direct story scene.",
    outputDir: tempRoot
  });
  assert.equal(result.taskId, "wf12026081604004639779672470531");
  assert.equal(requests, 2);
  assert.equal(readiness.length, 2);
  assert.equal(readiness[1].forceLaunch, true);
});

test("local submission never blindly duplicates an unknown post-connect response", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-local-submit-unknown-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const client = new BridgeClient({ tokenPath: path.join(tempRoot, "bridge-token"), fetchImpl: async () => new Response("{}") });
  client.configure({ kind: "local-xiangsu" });
  client.ensureLocalSubmissionBridge = async () => ({ ok: true, ready: true, sessionReady: true });
  let requests = 0;
  client.request = async () => {
    requests += 1;
    throw Object.assign(new Error("socket reset after connect"), { code: "ECONNRESET" });
  };
  await assert.rejects(() => client.submitScoped({
    ability: "SD_2.0_MINI",
    clientRequestId: "drama-video-stable-003",
    prompt: "A direct story scene.",
    outputDir: tempRoot
  }), error => error?.code === "VIDEO_SUBMISSION_RESPONSE_UNKNOWN"
    && error?.remoteSubmissionUnknown === true
    && error?.clientRequestId === "drama-video-stable-003");
  assert.equal(requests, 1);
});
