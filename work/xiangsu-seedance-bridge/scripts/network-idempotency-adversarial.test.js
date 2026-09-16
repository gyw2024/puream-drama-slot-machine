"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { generateImage, generateText } = require("../app/ai-provider");
const { BridgeClient } = require("../app/bridge-client");
const {
  buildCloudSubmit,
  createConcurrencyLimiter
} = require("../app/puream-video-adapters");
const { executeShotVideoBatch, videoSubmissionFingerprint } = require("../app/workbench-workflow");

function geminiConfig() {
  return {
    kind: "gemini-native",
    baseUrl: "https://gemini.test/v1beta",
    apiKey: "test-api-key",
    model: "gemini-3.7-flash"
  };
}

function geminiSuccess(text = "ok") {
  return new Response([
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      responseId: "gemini-response-one"
    })}`,
    ""
  ].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function geminiOptions(extra = {}) {
  return {
    sessionId: "native-gemini-adversarial-request",
    geminiAdmissionAttempts: 2,
    geminiAdmissionRetryBaseDelayMs: 1,
    __testOnlyGeminiMaximumAutomaticAdmissionWaitMs: 100,
    __testOnlyGeminiMaximumAutomaticAdmissionTotalWaitMs: 100,
    __testOnlyGeminiAdmissionSleep: async () => {},
    ...extra
  };
}

function remoteVideoConfig(mode = "reference_to_video") {
  return {
    kind: "puream-hailuo-h3",
    baseUrl: "https://puream.cn",
    apiKey: "puream-desktop:test-auth",
    storageMode: "managed",
    managedStorageBaseUrl: "https://puream.cn",
    hailuoApiMode: mode
  };
}

function videoPayload(outputDir, requestId, images = [], mode = "reference_to_video") {
  return {
    providerKind: "puream-hailuo-h3",
    clientRequestId: requestId,
    prompt: "A person turns naturally in a living room.",
    duration: 10,
    aspectRatio: "9:16",
    hailuoApiMode: mode,
    images,
    videos: [],
    videoAudios: [],
    audios: [],
    outputDir
  };
}

test("Electron main injects Chromium net.fetch into both production video bridges", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  assert.match(source, /remoteVideoFetch\s*=\s*\(url,\s*init\)\s*=>\s*net\.fetch\(url,\s*init\)/);
  assert.match(source, /createDesktopBridge\s*=\s*\(\)\s*=>\s*new BridgeClient\(\{\s*remoteFetchImpl:\s*remoteVideoFetch\s*\}\)/);
  assert.match(source, /const bridge\s*=\s*createDesktopBridge\(\)[\s\S]*const simpleBridge\s*=\s*createDesktopBridge\(\)/);
});

test("Gemini 200 response headers followed by a first-read failure is result-unknown and never replayed", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(new ReadableStream({
      start(controller) {
        controller.error(new TypeError("socket closed before the first stream frame"));
      }
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  try {
    await assert.rejects(
      () => generateText(geminiConfig(), [{ role: "user", content: "test" }], geminiOptions()),
      error => error?.code === "PROVIDER_STREAM_INTERRUPTED"
        && error?.noAutomaticRetry === true
    );
    assert.equal(calls, 1, "an accepted response with an unknown result must not replay the full prompt");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini generic TypeError before any observable response is ambiguous and never blindly replayed", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(
      () => generateText(geminiConfig(), [{ role: "user", content: "test" }], geminiOptions()),
      error => error?.name === "TypeError"
        && /fetch failed/i.test(String(error.message || ""))
        && error?.noAutomaticRetry === true
        && error?.requestDispatchUncertain === true
    );
    assert.equal(calls, 1, "generic fetch failure does not prove that the paid request was never accepted");
  } finally {
    global.fetch = originalFetch;
  }
});

test("remote BridgeClient requests use the injected Electron transport and preserve it across forks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-electron-remote-fetch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let remoteCalls = 0;
  const remoteFetchImpl = async (_url, options = {}) => {
    remoteCalls += 1;
    assert.equal(options.headers["idempotency-key"], "desktop-network-stack-request");
    return new Response(JSON.stringify({ task_id: "electron-net-task", status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const client = new BridgeClient({
    tokenPath: path.join(root, "bridge-token"),
    remoteFetchImpl
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("Node transport must not be used for remote desktop video"); };
  try {
    const fork = client.fork(remoteVideoConfig("text_to_video"));
    const result = await fork.submitScoped(
      videoPayload(root, "desktop-network-stack-request", [], "text_to_video"),
      { attempt: 1 }
    );
    assert.equal(result.taskId, "electron-net-task");
    assert.equal(remoteCalls, 1);
    assert.equal(fork.remoteFetchImpl, remoteFetchImpl);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a stalled completed-video download times out without creating another paid task", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-download-watchdog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCalls = 0;
  const remoteFetchImpl = async (_url, options = {}) => new Promise((resolve, reject) => {
    void resolve;
    fetchCalls += 1;
    options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), {
      name: "AbortError"
    })), { once: true });
  });
  const client = new BridgeClient({ tokenPath: path.join(root, "bridge-token"), remoteFetchImpl });
  client.configure(remoteVideoConfig("text_to_video"));
  client.saveRemoteTask("completed-remote-task", {
    outputDir: root,
    providerKind: "puream-hailuo-h3",
    submittedAt: new Date().toISOString()
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => client.downloadRemoteVideo("completed-remote-task", "", { __testOnlyDownloadTimeoutMs: 15 }),
    error => error?.code === "REMOTE_VIDEO_DOWNLOAD_RETRYABLE"
      && error?.retryable === true
      && error?.remoteGenerationCompleted === true
      && error?.transportCode === "ETIMEDOUT"
      && !/aborted|fetch failed/i.test(error.message)
  );
  assert.equal(fetchCalls, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a completed remote video with a transient download failure remains a resumable batch item", async () => {
  const result = await executeShotVideoBatch([{ id: "S01", number: 1 }], async () => {
    throw Object.assign(new Error("download socket failed"), {
      code: "REMOTE_VIDEO_DOWNLOAD_RETRYABLE",
      retryable: true,
      remoteGenerationCompleted: true
    });
  }, 1);
  assert.equal(result.batchFailures.length, 0);
  assert.equal(result.recoverablePending.length, 1);
  assert.equal(result.recoverablePending[0].shotId, "S01");
});

test("Gemini retries a provable DNS pre-connect ENOTFOUND once", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND gemini.test"), { code: "ENOTFOUND" });
    }
    return geminiSuccess("recovered");
  };
  try {
    const result = await generateText(
      geminiConfig(),
      [{ role: "user", content: "test" }],
      geminiOptions()
    );
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("native Gemini requests do not claim unsupported custom idempotency semantics", async () => {
  const originalFetch = global.fetch;
  let capturedHeaders = null;
  global.fetch = async (_url, options = {}) => {
    capturedHeaders = options.headers || {};
    return geminiSuccess();
  };
  try {
    assert.equal(await generateText(
      geminiConfig(),
      [{ role: "user", content: "test" }],
      geminiOptions({ geminiAdmissionAttempts: 1 })
    ), "ok");
    const headers = new Headers(capturedHeaders);
    assert.equal(headers.has("idempotency-key"), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("concurrent PureAM image draws carry unique identities and reject an upstream task-id collision", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-image-task-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  const submitHeaders = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/gpt-image-2/v1/images/generations")) {
      submitHeaders.push(new Headers(options.headers || {}));
      return new Response(JSON.stringify({
        task_id: "task-image-collision-regression",
        status: "completed",
        data: [{ url: "https://1.1.1.1/generated.png" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://1.1.1.1/generated.png") {
      return new Response(Buffer.from("valid-image-bytes"), { status: 200, headers: { "content-type": "image/png" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const config = {
    kind: "puream-relay",
    baseUrl: "https://puream.test",
    apiKey: "puream-desktop:test-auth",
    size: "9:16"
  };
  try {
    await generateImage(config, "character C10 portrait", path.join(root, "c10.png"));
    await assert.rejects(
      () => generateImage(config, "scene SRC_SC004 lobby", path.join(root, "scene.png")),
      error => error?.code === "IMAGE_TASK_ID_COLLISION"
        && error?.noAutomaticRetry === true
        && error?.taskId === "task-image-collision-regression"
    );
    assert.equal(submitHeaders.length, 2);
    const firstKey = submitHeaders[0].get("idempotency-key");
    const secondKey = submitHeaders[1].get("idempotency-key");
    assert.match(firstKey, /^drama-image-[a-f0-9]{40}$/);
    assert.match(secondKey, /^drama-image-[a-f0-9]{40}$/);
    assert.notEqual(firstKey, secondKey);
    assert.equal(submitHeaders[0].get("x-client-request-id"), firstKey);
    assert.equal(submitHeaders[1].get("x-client-request-id"), secondKey);
  } finally {
    global.fetch = originalFetch;
  }
});

test("five concurrent shot builds upload one identical SHA exactly once", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-inflight-upload-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "shared-reference.png");
  fs.writeFileSync(imagePath, "same-image");
  const cache = new Map();
  const limiter = createConcurrencyLimiter(3);
  let uploadCalls = 0;
  const fetchImpl = async url => {
    assert.match(String(url), /\/api\/desktop\/media\/upload$/);
    uploadCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ url: "https://cdn.puream.cn/references/shared-reference.png" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const builds = await Promise.all(Array.from({ length: 5 }, (_item, index) => buildCloudSubmit(
    remoteVideoConfig(),
    videoPayload(root, `drama-video-shot-${index + 1}`, [{ path: imagePath, sha256: "a".repeat(64) }]),
    fetchImpl,
    fs,
    { referenceUploadLimiter: limiter, referenceUrlCache: cache }
  )));
  assert.equal(uploadCalls, 1, "in-flight cache must collapse concurrent references, not only completed ones");
  assert.equal(new Set(builds.map(item => item.body.reference_images[0])).size, 1);
});

test("signed reference URL query rotation does not change the paid video idempotency fingerprint", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-fingerprint-query-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "character.png");
  fs.writeFileSync(imagePath, "character-image");
  const project = {
    id: "project-stable",
    productionRevision: "revision-one",
    generation: { aspectRatio: "9:16" }
  };
  const references = signature => ({
    aspectRatio: "9:16",
    images: [imagePath],
    imageRoles: [{
      type: "character",
      entityId: "C01",
      candidateId: "candidate-one",
      path: imagePath,
      remoteUrl: `https://oss.example.com/assets/character.png?Expires=${signature}&Signature=${signature}`
    }],
    videos: [],
    videoAudios: [],
    audios: []
  });
  const first = await videoSubmissionFingerprint(
    project, "puream-hailuo-h3", "shot", "S01", "shot_video", "same prompt",
    references("111"), 5, "image_to_video", "480"
  );
  const second = await videoSubmissionFingerprint(
    project, "puream-hailuo-h3", "shot", "S01", "shot_video", "same prompt",
    references("222"), 5, "image_to_video", "480"
  );
  assert.equal(second, first, "renewing only signed URL query parameters must reuse the unresolved paid request key");
});

test("transport recovery reuses one video key while an explicit reroll receives a new key", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-reroll-fingerprint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "character.png");
  fs.writeFileSync(imagePath, "character-image");
  const project = {
    id: "project-reroll",
    productionRevision: "revision-one",
    generation: { aspectRatio: "9:16" }
  };
  const references = rerollNonce => ({
    aspectRatio: "9:16",
    rerollNonce,
    images: [imagePath],
    imageRoles: [{
      type: "character",
      entityId: "C01",
      candidateId: "candidate-one",
      path: imagePath,
      remoteUrl: "https://oss.example.com/assets/character.png?Expires=111&Signature=111"
    }],
    videos: [],
    videoAudios: [],
    audios: []
  });
  const initial = await videoSubmissionFingerprint(
    project, "puream-hailuo-h3", "shot", "S01", "shot_video", "same prompt",
    references(""), 5, "image_to_video", "480"
  );
  const transportRetry = await videoSubmissionFingerprint(
    project, "puream-hailuo-h3", "shot", "S01", "shot_video", "same prompt",
    references(""), 5, "image_to_video", "480"
  );
  const explicitReroll = await videoSubmissionFingerprint(
    project, "puream-hailuo-h3", "shot", "S01", "shot_video", "same prompt",
    references("user-reroll-one"), 5, "image_to_video", "480"
  );
  const sameExplicitRerollRecovery = await videoSubmissionFingerprint(
    project, "puream-hailuo-h3", "shot", "S01", "shot_video", "same prompt",
    references("user-reroll-one"), 5, "image_to_video", "480"
  );
  assert.equal(transportRetry, initial, "a network recovery must keep the original paid identity");
  assert.notEqual(explicitReroll, initial, "a deliberate reroll must not rediscover the prior terminal task");
  assert.equal(sameExplicitRerollRecovery, explicitReroll, "recovery of one deliberate reroll must remain idempotent");
});

test("cloud response loss recovers the same task with the same idempotency key", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-cloud-submit-idempotency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = [];
  const createdByKey = new Map();
  let loseFirstResponse = true;
  const fetchImpl = async (_url, options = {}) => {
    const key = String(options.headers?.["idempotency-key"] || "");
    keys.push(key);
    if (!createdByKey.has(key)) createdByKey.set(key, `task-${createdByKey.size + 1}`);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw Object.assign(new TypeError("response socket lost"), { code: "ECONNRESET" });
    }
    return new Response(JSON.stringify({ task_id: createdByKey.get(key), status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const client = new BridgeClient({ tokenPath: path.join(root, "bridge-token"), fetchImpl });
  client.configure(remoteVideoConfig("text_to_video"));
  const payload = videoPayload(root, "drama-video-stable-cloud-submit", [], "text_to_video");

  await assert.rejects(
    () => client.submitScoped(payload, { attempt: 1 }),
    error => error?.code === "VIDEO_SUBMISSION_RESPONSE_UNKNOWN"
      && error?.remoteSubmissionUnknown === true
      && error?.idempotencyKey === payload.clientRequestId
  );
  const recovered = await client.submitScoped(payload, { attempt: 2 });
  assert.equal(recovered.taskId, "task-1");
  assert.deepEqual(keys, [payload.clientRequestId, payload.clientRequestId]);
  assert.equal(createdByKey.size, 1, "the simulated cloud creates one paid task for one stable key");
});

test("pause before the HTTP submit boundary is conclusively not-created", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-cloud-submit-pre-boundary-pause-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCalls = 0;
  const client = new BridgeClient({
    tokenPath: path.join(root, "bridge-token"),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run after a pre-boundary pause");
    }
  });
  client.configure(remoteVideoConfig("text_to_video"));
  const payload = videoPayload(root, "drama-video-paused-before-http", [], "text_to_video");
  const controller = new AbortController();
  controller.abort(Object.assign(new Error("已暂停"), { code: "PIPELINE_PAUSED" }));
  await assert.rejects(
    () => client.submitScoped(payload, { signal: controller.signal, attempt: 1 }),
    error => error?.code === "PIPELINE_PAUSED"
      && error?.noRemoteTaskCreated === true
      && error?.remoteSubmissionUnknown !== true
  );
  assert.equal(fetchCalls, 0);
});

test("pause while persisting the upstream-starting phase still cannot open the POST", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-cloud-submit-phase-pause-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCalls = 0;
  const client = new BridgeClient({
    tokenPath: path.join(root, "bridge-token"),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run after the phase callback pauses the operation");
    }
  });
  client.configure(remoteVideoConfig("text_to_video"));
  const payload = videoPayload(root, "drama-video-paused-in-phase", [], "text_to_video");
  const controller = new AbortController();
  const phases = [];
  await assert.rejects(
    () => client.submitScoped(payload, {
      signal: controller.signal,
      attempt: 1,
      onPhase: phase => {
        phases.push(phase.phase);
        controller.abort(Object.assign(new Error("已暂停"), { code: "PIPELINE_PAUSED" }));
      }
    }),
    error => error?.code === "PIPELINE_PAUSED"
      && error?.noRemoteTaskCreated === true
      && error?.remoteSubmissionUnknown !== true
  );
  assert.deepEqual(phases, ["upstream_request_starting"]);
  assert.equal(fetchCalls, 0);
});

test("an HTTP success without taskId is response-unknown and keeps the same key", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-cloud-submit-missing-task-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = [];
  const client = new BridgeClient({
    tokenPath: path.join(root, "bridge-token"),
    fetchImpl: async (_url, init) => {
      keys.push(init.headers["idempotency-key"]);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: "queued" }) };
    }
  });
  client.configure(remoteVideoConfig("text_to_video"));
  const payload = videoPayload(root, "drama-video-missing-task-id", [], "text_to_video");
  await assert.rejects(
    () => client.submitScoped(payload, { attempt: 1 }),
    error => error?.code === "VIDEO_SUBMISSION_RESPONSE_UNKNOWN"
      && error?.remoteSubmissionUnknown === true
      && error?.idempotencyKey === payload.clientRequestId
  );
  assert.deepEqual(keys, [payload.clientRequestId]);
});
