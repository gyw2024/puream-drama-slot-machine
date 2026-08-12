"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");

const root = path.resolve(__dirname, "..");
const source = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

test("every production stage exposes an explicit manual entry", () => {
  const html = source("app/renderer/workbench.html");
  for (const id of [
    "importScriptFile",
    "selectProductLibrary",
    "importStoryboardBatch",
    "importShotPromptsBatch",
    "importShotVideosBatch",
    "importFinalVideo"
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, `${id} must exist exactly once`);
  }
  for (const label of ["人物图", "场景图", "通用图片", "资产视频", "资产音频"]) assert.match(html, new RegExp(label));

  const renderer = source("app/renderer/workbench.js");
  for (const label of ["上传人物合板", "上传人物三视图", "上传人物介绍图", "上传人物视频", "上传音色", "上传服装图", "上传道具图", "上传场景空间锚图", "上传本镜视频"]) {
    assert.match(renderer, new RegExp(label));
  }
});

test("manual IPC routes are bridged and manual candidates become current", () => {
  const main = source("app/main.js");
  const preload = source("app/preload.js");
  for (const channel of [
    "workbench:import-batch-media",
    "workbench:import-shot-prompts",
    "workbench:import-final-video",
    "workbench:import-reusable-asset",
    "workbench:delete-reusable-asset",
    "workbench:bind-library-asset"
  ]) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(main, /candidate = store\.confirmCandidate\(projectId, candidate\.id, false\)/);
  assert.doesNotMatch(main, /await workflow\.remeshCharacterAsset\(projectId, candidate\.id\)/);
});

test("independent asset library accepts direct image video and audio uploads", t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-manual-library-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const sourceDir = path.join(tempRoot, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  const store = new WorkbenchStore(path.join(tempRoot, "workbench"));
  const cases = [
    { kind: "character", mediaType: "image", name: "role.png" },
    { kind: "scene", mediaType: "image", name: "scene.jpg" },
    { kind: "image", mediaType: "image", name: "prop.webp" },
    { kind: "video", mediaType: "video", name: "clip.mp4" },
    { kind: "audio", mediaType: "audio", name: "voice.wav" }
  ];
  const entries = cases.map((item, index) => {
    const filePath = path.join(sourceDir, item.name);
    fs.writeFileSync(filePath, `manual-${index}`);
    return store.importReusableAsset(filePath, item);
  });
  assert.equal(store.listReusableAssets().length, 5);
  assert.deepEqual(new Set(entries.map(item => item.kind)), new Set(cases.map(item => item.kind)));
  assert.ok(entries.every(item => fs.existsSync(item.filePath)));
  const touched = store.touchReusableAssetUse(entries[0].id);
  assert.equal(touched.useCount, 1);
  store.deleteReusableAsset(entries[4].id);
  assert.equal(store.listReusableAssets().length, 4);
});

test("replacing a product image retires product-dependent storyboard and video assets", t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-product-replace-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const workbenchRoot = path.join(tempRoot, "workbench");
  const filesRoot = path.join(tempRoot, "files");
  fs.mkdirSync(filesRoot, { recursive: true });
  const file = (name, content) => {
    const target = path.join(filesRoot, name);
    fs.writeFileSync(target, content);
    return target;
  };
  const oldProduct = file("old-product.png", "old-product");
  const newProduct = file("new-product.png", "new-product");
  const frame = file("frame.png", "frame");
  const video = file("video.mp4", "video");
  const store = new WorkbenchStore(workbenchRoot);
  const project = store.createProject("product dependency test");
  project.product.imagePath = oldProduct;
  project.shots = [{ id: "shot_1", number: 1, title: "带货镜头", productMention: "商品入镜" }];
  project.finalVideoPath = video;
  project.finalVideoStale = false;
  store.saveProject(project);
  const storyboard = store.addCandidate(project.id, {
    entityType: "shot", entityId: "shot_1", stage: "storyboard_start", filePath: frame, selected: true
  });
  const shotVideo = store.addCandidate(project.id, {
    entityType: "shot", entityId: "shot_1", stage: "shot_video", filePath: video, selected: true,
    qualityAudit: { ok: true }
  });
  const replaced = store.replaceProductAsset(project.id, { imagePath: newProduct, publicUrl: "" });
  assert.equal(replaced.candidates.find(item => item.id === storyboard.id).stale, true);
  assert.equal(replaced.candidates.find(item => item.id === shotVideo.id).stale, true);
  assert.equal(replaced.finalVideoStale, true);
  assert.match(replaced.finalVideoStaleReason, /商品参考图已替换/);
});

test("five minute script path fans out planning and formal units without extra review calls", () => {
  const workflow = source("app/workbench-workflow.js");
  assert.match(workflow, /const SCRIPT_FAST_TARGET_SECONDS = 300/);
  assert.match(workflow, /mapWithConcurrency\(planTasks, SCRIPT_FAST_CONCURRENCY/);
  assert.match(workflow, /mapWithConcurrency\(unitTasks, SCRIPT_FAST_CONCURRENCY/);
  assert.match(workflow, /useFastScriptPath\s*\?\s*\{/);
  assert.match(workflow, /path: useFastScriptPath \? "parallel-fast-v1"/);
  assert.match(workflow, /metTarget: scriptElapsedSeconds !== null \? scriptElapsedSeconds <= SCRIPT_FAST_TARGET_SECONDS/);
});
