"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveReferenceUrl } = require("../app/puream-video-adapters");
const { isRetryableStoryboardFailure } = require("../app/workbench-workflow");

test("managed PureAM storage turns local storyboard references into public URLs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drama-reference-"));
  const filePath = path.join(root, "scene.png");
  fs.writeFileSync(filePath, "image");
  let uploadCalls = 0;
  try {
    const url = await resolveReferenceUrl({
      kind: "puream-hailuo-h3",
      apiKey: "TEST-AUTH",
      storageMode: "managed",
      managedStorageBaseUrl: "https://puream.cn"
    }, { path: filePath }, fetchStub, "request-1", "image", 0, fs);
    assert.equal(url, "https://cdn.puream.cn/references/scene.png");
    assert.equal(uploadCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  async function fetchStub(url) {
    uploadCalls += 1;
    assert.equal(url, "https://puream.cn/api/desktop/media/upload");
    return new Response(JSON.stringify({ url: "https://cdn.puream.cn/references/scene.png" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});

test("storyboard reference/configuration failures are not retried as upstream jitter", () => {
  assert.equal(isRetryableStoryboardFailure({ code: "CONTINUITY_REFERENCE_REQUIRED", message: "缺少当前镜头参考" }), false);
  assert.equal(isRetryableStoryboardFailure({ code: "STORYBOARD_SCENE_REFERENCE_REQUIRED", message: "缺少场景四视图" }), false);
  assert.equal(isRetryableStoryboardFailure({ code: "PUREAM_AUTH_REQUIRED", message: "授权失效" }), false);
  assert.equal(isRetryableStoryboardFailure({ code: "PROVIDER_TIMEOUT", message: "网关超时" }), true);
  assert.equal(isRetryableStoryboardFailure({ code: "PROVIDER_HTTP_ERROR", status: 503, message: "Service Unavailable" }), true);
});
