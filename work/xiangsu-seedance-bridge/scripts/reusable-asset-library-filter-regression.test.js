"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");

test("reusable assets and voice entries persist age, gender, and arbitrary tags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-reusable-filter-"));
  const imagePath = path.join(root, "character.png");
  const voicePath = path.join(root, "voice.wav");
  fs.writeFileSync(imagePath, "image");
  fs.writeFileSync(voicePath, "voice");
  const store = new WorkbenchStore(root);

  const image = store.importReusableAsset(imagePath, { kind: "character", mediaType: "image", tags: ["短发", "反派"] });
  const updatedImage = store.updateReusableAssetMetadata(image.id, { gender: "女", ageBand: "中年", tags: "短发，反派,职场" });
  assert.equal(updatedImage.gender, "female");
  assert.equal(updatedImage.ageBand, "middle");
  assert.deepEqual(updatedImage.tags, ["短发", "反派", "职场"]);

  store.upsertVoiceLibraryEntry({ id: "voice_filter_fixture", filePath: voicePath, label: "测试音色", tags: [] });
  const updatedVoice = store.updateReusableAssetMetadata("voice_filter_fixture", { gender: "男", ageBand: "老年", tags: "低沉，沙哑" });
  assert.equal(updatedVoice.kind, "voice");
  assert.equal(updatedVoice.gender, "male");
  assert.equal(updatedVoice.ageBand, "senior");
  assert.deepEqual(updatedVoice.tags, ["低沉", "沙哑"]);

  const reloaded = new WorkbenchStore(root);
  assert.equal(reloaded.readReusableAssetLibrary().find(item => item.id === image.id).ageBand, "middle");
  assert.equal(reloaded.getVoiceLibraryEntry("voice_filter_fixture").gender, "male");
  fs.rmSync(root, { recursive: true, force: true });
});

test("asset library renderer exposes kind, gender, age and tag filters with persistent editing", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "app", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  assert.match(renderer, /data-reusable-asset-filter="kind"/);
  assert.match(renderer, /data-reusable-asset-filter="gender"/);
  assert.match(renderer, /data-reusable-asset-filter="ageBand"/);
  assert.match(renderer, /edit-reusable-asset-metadata/);
  assert.match(preload, /updateReusableAssetMetadata/);
  assert.match(main, /workbench:update-reusable-asset-metadata/);
});
