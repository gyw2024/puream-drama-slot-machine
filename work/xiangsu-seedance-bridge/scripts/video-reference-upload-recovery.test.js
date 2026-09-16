"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BridgeClient } = require("../app/bridge-client");
const { buildCloudSubmit, createConcurrencyLimiter, resolveReferenceUrl } = require("../app/puream-video-adapters");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, hasRecoverableScriptCheckpoint } = require("../app/workbench-workflow");

function remoteConfig() {
  return {
    kind: "puream-hailuo-h3",
    baseUrl: "https://puream.cn",
    apiKey: "puream-desktop:test-auth",
    storageMode: "managed",
    managedStorageBaseUrl: "https://puream.cn",
    hailuoApiMode: "reference_to_video"
  };
}

function videoPayload(root, images) {
  return {
    providerKind: "puream-hailuo-h3",
    clientRequestId: "drama-video-stable-network-test",
    prompt: "一名人物在客厅自然转身",
    duration: 10,
    aspectRatio: "9:16",
    hailuoApiMode: "reference_to_video",
    images,
    videos: [],
    videoAudios: [],
    audios: [],
    outputDir: root
  };
}

test("raw managed-upload fetch failure is a safe pre-task retry instead of a customer error", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-fetch-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "reference.png");
  fs.writeFileSync(imagePath, "image");
  const client = new BridgeClient({
    tokenPath: path.join(root, "bridge-token"),
    fetchImpl: async () => { throw new TypeError("fetch failed"); }
  });
  client.configure(remoteConfig());

  await assert.rejects(
    () => client.submitScoped(videoPayload(root, [{ path: imagePath, sha256: "a".repeat(64) }]), { attempt: 1 }),
    error => error?.code === "REFERENCE_MEDIA_UPLOAD_RETRYABLE"
      && error?.retryable === true
      && error?.noRemoteTaskCreated === true
      && error?.uploadPhase === "reference_upload"
      && !/fetch failed|TypeError/i.test(error.message)
  );
  const events = fs.readFileSync(client.providerEventsPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.at(-1).phase, "reference_upload_failed");
  assert.equal(events.at(-1).noRemoteTaskCreated, true);
  assert.doesNotMatch(JSON.stringify(events), /test-auth|puream\.cn|fetch failed/i);
});

test("managed upload classifies 503 as retryable and 403 as terminal", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "reference.png");
  fs.writeFileSync(imagePath, "image");
  for (const [status, retryable] of [[503, true], [403, false]]) {
    await assert.rejects(
      () => resolveReferenceUrl(remoteConfig(), { path: imagePath }, async () => new Response(JSON.stringify({ message: "upstream" }), {
        status,
        headers: { "content-type": "application/json", "retry-after": "1" }
      }), `request-${status}`, "image", 0, fs),
      error => error?.noRemoteTaskCreated === true
        && (retryable
          ? error?.code === "REFERENCE_MEDIA_UPLOAD_RETRYABLE" && error?.retryable === true && error?.retryAfterMs === 1000
          : error?.code === "PUREAM_MANAGED_MEDIA_UPLOAD_FAILED" && error?.retryable !== true)
    );
  }
});

test("a stalled reference upload is aborted at the upload watchdog and remains pre-task retryable", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-watchdog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "reference.png");
  fs.writeFileSync(imagePath, "image");
  const neverSettlesUntilAbort = async (_url, options = {}) => new Promise((resolve, reject) => {
    void resolve;
    options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), {
      name: "AbortError"
    })), { once: true });
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => resolveReferenceUrl(
      remoteConfig(),
      { path: imagePath, sha256: "f".repeat(64) },
      neverSettlesUntilAbort,
      "request-upload-timeout",
      "image",
      0,
      fs,
      null,
      15
    ),
    error => error?.code === "REFERENCE_MEDIA_UPLOAD_RETRYABLE"
      && error?.noRemoteTaskCreated === true
      && error?.transportCode === "ETIMEDOUT"
      && !/aborted|fetch failed/i.test(error.message)
  );
  assert.ok(Date.now() - startedAt < 1_000, "the test-only watchdog should deterministically abort the stalled socket");
});

test("upload recovery waits for siblings, reuses completed URLs and submits one paid task with the same request key", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstPath = path.join(root, "first.png");
  const secondPath = path.join(root, "second.png");
  fs.writeFileSync(firstPath, "first");
  fs.writeFileSync(secondPath, "second");
  const uploadCounts = new Map();
  const requestIds = [];
  const submitKeys = [];
  let secondUploadSettled = false;
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith("/api/desktop/media/upload")) {
      const name = String(options.headers["x-puream-file-name"] || "");
      uploadCounts.set(name, (uploadCounts.get(name) || 0) + 1);
      requestIds.push(String(options.headers["x-puream-request-id"] || ""));
      if (name === "first.png" && uploadCounts.get(name) === 1) {
        throw new TypeError("fetch failed");
      }
      if (name === "second.png" && uploadCounts.get(name) === 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        secondUploadSettled = true;
      }
      return new Response(JSON.stringify({ url: `https://cdn.puream.cn/reference/${name}` }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    submitKeys.push(String(options.headers["idempotency-key"] || ""));
    return new Response(JSON.stringify({ task_id: "paid-task-one", status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const client = new BridgeClient({ tokenPath: path.join(root, "bridge-token"), fetchImpl });
  client.configure(remoteConfig());
  const payload = videoPayload(root, [
    { path: firstPath, sha256: "1".repeat(64) },
    { path: secondPath, sha256: "2".repeat(64) }
  ]);

  await assert.rejects(() => client.submitScoped(payload, { attempt: 1 }), error => error?.retryable === true);
  assert.equal(secondUploadSettled, true, "the failed build must wait for every sibling upload to settle");
  const result = await client.submitScoped(payload, { attempt: 2 });
  assert.equal(result.taskId, "paid-task-one");
  assert.equal(uploadCounts.get("first.png"), 2);
  assert.equal(uploadCounts.get("second.png"), 1, "the successful sibling URL is reused");
  assert.equal(submitKeys.length, 1);
  assert.equal(submitKeys[0], payload.clientRequestId);
  assert.equal(new Set(requestIds).size, 1);
  assert.equal(requestIds[0], payload.clientRequestId);
});

test("one shared upload limiter caps concurrent shot builds at three sockets", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-global-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = Array.from({ length: 6 }, (_item, index) => {
    const filePath = path.join(root, `image-${index}.png`);
    fs.writeFileSync(filePath, `image-${index}`);
    return filePath;
  });
  const limiter = createConcurrencyLimiter(3);
  let active = 0;
  let maximum = 0;
  const fetchImpl = async (_url, options) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return new Response(JSON.stringify({ url: `https://cdn.puream.cn/${options.headers["x-puream-file-name"]}` }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  await Promise.all([0, 1].map(batch => buildCloudSubmit(remoteConfig(), videoPayload(root,
    files.slice(batch * 3, batch * 3 + 3).map((filePath, index) => ({ path: filePath, sha256: `${batch}${index}`.padEnd(64, "0") }))
  ), fetchImpl, fs, { referenceUploadLimiter: limiter, referenceUrlCache: new Map() })));
  assert.equal(maximum, 3);
});

test("tracked operations preserve video and partial-script checkpoints without raw transport text", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-recoverable-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const videoProject = store.createProject("视频上传恢复");
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: async () => ({}) });
  await assert.rejects(() => workflow.runTrackedOperation(videoProject.id, "shot_videos", "", async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      code: "REFERENCE_MEDIA_UPLOAD_RETRYABLE",
      retryable: true,
      noRemoteTaskCreated: true
    });
  }));
  const savedVideo = store.getProject(videoProject.id);
  assert.equal(savedVideo.automation.status, "paused_remote");
  assert.equal(savedVideo.automation.recoverableFailure, true);
  assert.equal(savedVideo.automation.autoResume, true);
  assert.ok(Date.parse(savedVideo.automation.retryAt) > Date.now());
  assert.equal(savedVideo.automation.errorCode, "");
  assert.doesNotMatch(savedVideo.automation.message, /fetch failed|TypeError/i);

  const scriptProject = store.createProject("Gemini 局部断点恢复");
  const partial = store.getProject(scriptProject.id);
  partial.script = {
    ...(partial.script || {}),
    generationCheckpoint: {
      directFastSpine: { c: [{ n: "人物" }], sc: [], b: [] },
      semanticShotSchedule: Array.from({ length: 25 }, (_item, index) => ({ i: index + 1 }))
    }
  };
  store.saveProject(partial);
  assert.equal(hasRecoverableScriptCheckpoint(store.getProject(scriptProject.id)), true);
  await assert.rejects(() => workflow.runTrackedOperation(scriptProject.id, "idea_script", "", async () => {
    throw Object.assign(new Error("quota raw provider text"), {
      code: "PROVIDER_DAILY_QUOTA_EXHAUSTED",
      retryable: true,
      retryRequiresExplicitResume: true,
      noAutomaticRetry: true
    });
  }));
  const savedScript = store.getProject(scriptProject.id);
  assert.equal(savedScript.automation.status, "paused_account");
  assert.equal(savedScript.automation.resumeAfterAccountSwitch, true);
  assert.equal(savedScript.automation.recoverableFailure, true);
  assert.equal(savedScript.automation.autoResume, false);
  assert.doesNotMatch(savedScript.automation.message, /quota raw provider text/i);
});
