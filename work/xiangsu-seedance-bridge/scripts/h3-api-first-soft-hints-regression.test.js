"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { buildCloudSubmit } = require("../app/puream-video-adapters");
const { normalizeVideoProvider } = require("../app/video-provider-policy");

test("legacy instance tuning is normalized away before an H3 submission", async () => {
  const config = normalizeVideoProvider({
    kind: "puream-hailuo-h3",
    baseUrl: "https://puream.cn",
    apiKey: "puream-desktop:test-only",
    storageMode: "managed",
    hailuoApiMode: "multimodal_to_video",
    hailuoRefImageSize: "max",
    hailuoSeed: "42"
  });

  assert.equal(config.hailuoRefImageSize, "match");
  assert.equal(config.hailuoSeed, "");

  assert.doesNotThrow(() => require("../app/puream-video-adapters").validateProviderConfig({
    ...config,
    hailuoRefImageSize: "max",
    hailuoSeed: "legacy-nonnumeric-value"
  }));

  const submission = await buildCloudSubmit(config, {
    clientRequestId: "api-first-soft-hints",
    prompt: "short drama dialogue",
    duration: 13,
    aspectRatio: "9:16",
    hailuoApiMode: "multimodal_to_video",
    images: [
      { url: "https://cdn.puream.cn/ref-1.png" },
      { url: "https://cdn.puream.cn/ref-2.png" },
      { url: "https://cdn.puream.cn/ref-3.png" },
      { url: "https://cdn.puream.cn/ref-4.png" }
    ],
    videos: [],
    videoAudios: [],
    audios: [
      { url: "https://cdn.puream.cn/ref-1.mp3" },
      { url: "https://cdn.puream.cn/ref-2.mp3" }
    ]
  }, async () => {
    throw new Error("public reference URLs must not be uploaded again");
  }, fs);

  assert.equal(submission.body.mode, "multimodal_to_video");
  assert.equal(submission.body.duration, 13);
  assert.equal(submission.body.authorization_code, "puream-desktop:test-only");
  assert.equal(submission.body.ref_image_size, "match");
  assert.equal(Object.hasOwn(submission.body, "seed"), false);
  assert.equal(submission.body.reference_images.length, 4);
  assert.equal(submission.body.reference_audios.length, 2);
});

test("settings surface keeps instance-only hints locked to official API behavior", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "app", "renderer", "workbench.js"), "utf8");
  assert.match(html, /id="hailuoRefImageSize" disabled[^>]*>[\s\S]*?<option value="match">官方 API 优先<\/option>/);
  assert.doesNotMatch(html, /id="hailuoSeed"/);
  assert.doesNotMatch(html, /<option value="max">/);
  assert.match(renderer, /hailuoRefImageSize: "match"/);
  assert.match(renderer, /hailuoSeed: ""/);
});
