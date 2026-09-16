"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveReferenceUrl } = require("../app/puream-video-adapters");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function settings() {
  return {
    videoProvider: {
      kind: "puream-hailuo-h3",
      apiKey: "puream-desktop:test-auth",
      storageMode: "managed",
      managedStorageBaseUrl: "https://puream.cn"
    },
    imageProvider: { kind: "puream-relay" }
  };
}

test("managed upload percent-encodes a Chinese filename before Fetch validates header bytes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-chinese-header-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "七味堂植物泡泡染发膏.png");
  fs.writeFileSync(filePath, "image");
  let capturedName = "";
  const url = await resolveReferenceUrl(settings().videoProvider, { path: filePath }, async (_url, options) => {
    capturedName = String(options.headers["x-puream-file-name"] || "");
    assert.match(capturedName, /^[\x20-\x7e]+$/);
    return new Response(JSON.stringify({ url: "https://cdn.puream.cn/task-temp/product.png" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }, "unicode-product", "image", 0, fs);
  assert.equal(decodeURIComponent(capturedName), path.basename(filePath));
  assert.equal(url, "https://cdn.puream.cn/task-temp/product.png");
});

test("a local asset overrides its stale historical remote URL and is freshly uploaded", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-local-authoritative-ref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "product.png");
  fs.writeFileSync(filePath, "local-product-image");
  const expiredUrl = "https://oss.example.com/task-temp/yesterday/product.png";
  let uploadCalls = 0;
  const url = await resolveReferenceUrl(settings().videoProvider, {
    path: filePath,
    url: expiredUrl,
    sha256: "a".repeat(64)
  }, async requestUrl => {
    uploadCalls += 1;
    assert.match(String(requestUrl), /\/api\/desktop\/media\/upload$/);
    return new Response(JSON.stringify({ url: "https://cdn.puream.cn/task-temp/fresh-product.png" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }, "fresh-product-reference", "image", 0, fs);
  assert.equal(uploadCalls, 1);
  assert.equal(url, "https://cdn.puream.cn/task-temp/fresh-product.png");
  assert.notEqual(url, expiredUrl);
});

test("a remote-only reference remains usable when no local asset exists", async () => {
  const remoteUrl = "https://cdn.puream.cn/task-temp/remote-only.png";
  let uploadCalls = 0;
  const url = await resolveReferenceUrl(settings().videoProvider, { url: remoteUrl }, async () => {
    uploadCalls += 1;
    throw new Error("remote-only references must not upload");
  }, "remote-only-reference", "image", 0, fs);
  assert.equal(uploadCalls, 0);
  assert.equal(url, remoteUrl);
});

test("concurrent storyboard references share one upload promise and recover a pre-connect failure", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-image-ref-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "同一商品图.png");
  fs.writeFileSync(filePath, "same-product-image");
  let calls = 0;
  const workflow = new WorkbenchWorkflow({
    store: {},
    bridge: {},
    remoteFetch: async (_url, options) => {
      calls += 1;
      assert.match(String(options.headers["x-puream-file-name"] || ""), /^[\x20-\x7e]+$/);
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ url: "https://cdn.puream.cn/task-temp/shared-product.png" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    referenceUploadSleep: async () => {}
  });
  const inputs = await Promise.all(Array.from({ length: 6 }, () => workflow.resolveHttpsReferenceInputs(settings(), [{
    path: filePath,
    label: "商品包装基准",
    entityType: "product",
    sourceStage: "product"
  }])));
  assert.equal(calls, 2, "one shared promise should perform one failed attempt and one recovery attempt");
  assert.equal(new Set(inputs.map(items => items[0].url)).size, 1);
});
