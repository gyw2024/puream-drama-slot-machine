"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore, defaultSettings } = require("../app/workbench-store");
const { WorkbenchWorkflow, isQualityGatesEnabled, shotUsesManualVideoPrompt } = require("../app/workbench-workflow");

const root = path.resolve(__dirname, "..");
const source = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

test("every production stage exposes an explicit manual entry", () => {
  const html = source("app/renderer/workbench.html");
  for (const id of [
    "importScriptFile",
    "importDialogueRewrite",
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
  for (const label of ["上传人物合板", "上传人物三视图", "上传人物介绍图", "上传人物视频", "上传音色", "上传服装图", "上传道具图", "上传场景四视图", "上传本镜视频"]) {
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
    "workbench:bind-library-asset",
    "workbench:rewrite-dialogue-script"
  ]) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(main, /candidate = store\.confirmCandidate\(projectId, candidate\.id, false, \{ forceManualSelection: true \}\)/);
  assert.doesNotMatch(main, /await workflow\.remeshCharacterAsset\(projectId, candidate\.id\)/);
});

test("manual shot prompt is submitted verbatim and reroll is available inside the asset library", () => {
  const workflow = new WorkbenchWorkflow({
    store: { getSettings: () => defaultSettings() },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: ""
  });
  const project = { generation: { engine: "hailuo-h3", mode: "storyboard_sheet" }, shots: [] };
  const shot = {
    id: "S01",
    number: 1,
    duration: 8,
    promptMode: "manual",
    manualVideoPrompt: "林青山压着怒气对林宇义说：你到底瞒了我多久？"
  };
  assert.equal(shotUsesManualVideoPrompt(shot), true);
  assert.equal(workflow.buildShotPrompt(project, defaultSettings(), shot, "storyboard_sheet", { images: [], imageRoles: [], audios: [] }), shot.manualVideoPrompt);

  const renderer = source("app/renderer/workbench.js");
  assert.match(renderer, /data-action="reroll-shot-video"/);
  assert.match(renderer, /保存手动提示词并立即重抽/);
  assert.match(renderer, /action === "shot-video" \|\| action === "reroll-shot-video"/);
  assert.match(renderer, /关闭当前弹窗并返回主界面/);
  assert.doesNotMatch(renderer, /关闭当前弹窗，不保存尚未提交的修改/);
});

test("turning off the blueprint master disables every quality module globally", () => {
  const settings = {
    generation: {
      qualityGatesEnabled: false,
      qualityGateModules: { script: true, assets: true, storyboards: true, videos: true, delivery: true }
    }
  };
  for (const moduleName of ["script", "assets", "storyboards", "videos", "delivery"]) {
    assert.equal(isQualityGatesEnabled(settings, moduleName), false);
  }
  const workflowSource = source("app/workbench-workflow.js");
  assert.match(workflowSource, /!manualPromptActive && productionStructureGateEnabled\(settings, project\)/);
  assert.match(workflowSource, /if \(engine === "hailuo-h3" && !manualPromptActive\)/);
  assert.match(workflowSource, /if \(!shotUsesManualVideoPrompt\(activeShot\)\)/);
});

test("manual reroll reaches video submission even when the old storyboard audit failed", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-manual-reroll-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const sheetPath = path.join(tempRoot, "sheet.png");
  fs.writeFileSync(sheetPath, "manual-reroll-sheet");
  const shot = {
    id: "S01",
    number: 1,
    duration: 5,
    promptMode: "manual",
    manualVideoPrompt: "用户手动改写后的最终视频提示词",
    characterIds: [],
    visibleCharacterIds: [],
    dialogueTurns: []
  };
  const project = {
    id: "manual-reroll-project",
    productionRevision: "",
    productionPlan: { executionMode: "step" },
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true, shotDuration: 5, aspectRatio: "9:16" },
    product: { name: "" },
    characters: [],
    scenes: [],
    shots: [shot],
    candidates: [{
      id: "sheet-1",
      entityType: "shot",
      entityId: "S01",
      stage: "storyboard_sheet",
      filePath: sheetPath,
      selected: true,
      stale: false,
      productionRevision: "",
      qualityAudit: { ok: false, failures: [{ message: "旧审核失败" }] }
    }],
    jobs: [],
    automation: {}
  };
  const settings = defaultSettings();
  settings.generation.qualityGatesEnabled = true;
  const store = {
    getProject: () => project,
    getSettings: () => settings,
    saveProject: next => Object.assign(project, next)
  };
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: tempRoot });
  workflow.shotReferences = () => ({
    images: [sheetPath],
    imageRoles: [{
      type: "storyboard_sheet",
      label: "逐秒合图",
      path: sheetPath,
      sourceStage: "storyboard_sheet",
      candidateId: "sheet-1",
      entityType: "shot",
      entityId: "S01"
    }],
    audios: [],
    videos: [],
    videoRoles: [],
    videoAudios: []
  });
  let submittedPrompt = "";
  workflow.submitVideo = async (_projectId, _entityType, _entityId, _stage, prompt) => {
    submittedPrompt = prompt;
    return { id: "video-2", entityType: "shot", entityId: "S01", stage: "shot_video", filePath: path.join(tempRoot, "video.mp4") };
  };
  const result = await workflow.generateShotVideo(project.id, shot.id, project.generation.mode, { track: false, audit: false });
  assert.equal(result.id, "video-2");
  assert.equal(submittedPrompt, shot.manualVideoPrompt);
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
    { kind: "prop", mediaType: "image", name: "prop.webp" },
    { kind: "wardrobe", mediaType: "image", name: "wardrobe.png" },
    { kind: "product", mediaType: "image", name: "product.jpg" },
    { kind: "image", mediaType: "image", name: "storyboard.webp" },
    { kind: "video", mediaType: "video", name: "clip.mp4" },
    { kind: "audio", mediaType: "audio", name: "voice.wav" }
  ];
  const entries = cases.map((item, index) => {
    const filePath = path.join(sourceDir, item.name);
    fs.writeFileSync(filePath, `manual-${index}`);
    return store.importReusableAsset(filePath, item);
  });
  assert.equal(store.listReusableAssets().length, 8);
  assert.deepEqual(new Set(entries.map(item => item.kind)), new Set(cases.map(item => item.kind)));
  assert.ok(entries.every(item => fs.existsSync(item.filePath)));
  const touched = store.touchReusableAssetUse(entries[0].id);
  assert.equal(touched.useCount, 1);
  store.deleteReusableAsset(entries[7].id);
  assert.equal(store.listReusableAssets().length, 7);
});

test("global character scene and voice assets bind into a different project without touching the source", t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-cross-project-library-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const sourceDir = path.join(tempRoot, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourceCharacter = path.join(sourceDir, "global-character.png");
  const sourceScene = path.join(sourceDir, "global-scene.png");
  const sourceVoice = path.join(sourceDir, "global-voice.wav");
  fs.writeFileSync(sourceCharacter, "global-character");
  fs.writeFileSync(sourceScene, "global-scene");
  fs.writeFileSync(sourceVoice, "global-voice");
  const store = new WorkbenchStore(path.join(tempRoot, "workbench"));
  const characterAsset = store.importReusableAsset(sourceCharacter, { kind: "character", mediaType: "image", stage: "character_sheet", label: "全局人物" });
  const sceneAsset = store.importReusableAsset(sourceScene, { kind: "scene", mediaType: "image", stage: "scene_asset", label: "全局场景" });
  const voiceEntry = store.upsertVoiceLibraryEntry({
    id: "voice-global-test",
    label: "全局音色",
    filePath: sourceVoice,
    fileUrl: "",
    duration: 6,
    audioAudit: { ok: true, source: "manual-import" },
    mediaProbeVerified: true,
    useCount: 0
  });
  const target = store.createProject("全局资产目标项目");
  target.characters = [{ id: "C01", name: "目标人物" }];
  target.scenes = [{ id: "SC01", name: "目标场景" }];
  store.saveProject(target);
  const boundCharacter = store.bindReusableAsset(target.id, "character", "C01", characterAsset.id);
  const boundScene = store.bindReusableAsset(target.id, "scene", "SC01", sceneAsset.id);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: tempRoot });
  const boundVoice = workflow.bindCharacterVoiceLibrary(target.id, "C01", voiceEntry.id);
  const saved = store.getProject(target.id);
  assert.equal(boundCharacter.selected, true);
  assert.equal(boundScene.selected, true);
  assert.equal(boundVoice.selected, true);
  assert.ok([boundCharacter, boundScene, boundVoice].every(item => fs.existsSync(item.filePath)));
  assert.equal(saved.characters[0].visualAssetLibraryId, characterAsset.id);
  assert.equal(saved.characters[0].voiceLibraryId, voiceEntry.id);
  assert.equal(saved.scenes[0].visualAssetLibraryId, sceneAsset.id);
  assert.equal(store.getVoiceLibraryEntry(voiceEntry.id).useCount, 1);
  assert.equal(fs.readFileSync(sourceCharacter, "utf8"), "global-character");
  assert.equal(fs.readFileSync(sourceScene, "utf8"), "global-scene");
  assert.equal(fs.readFileSync(sourceVoice, "utf8"), "global-voice");
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

test("five to ten minute script path matches the relay's two slots and has a local SLA fallback", () => {
  const workflow = source("app/workbench-workflow.js");
  assert.match(workflow, /const SCRIPT_FAST_TARGET_SECONDS = 600/);
  assert.match(workflow, /const SCRIPT_FAST_CONCURRENCY = 8/);
  assert.match(workflow, /const SCRIPT_FAST_PUREAM_MODEL = "gpt-5-6-sol"/);
  assert.match(workflow, /const SCRIPT_DIRECT_SEGMENT_UNITS = 5/);
  assert.match(workflow, /const SCRIPT_DIRECT_MAX_CONCURRENCY = 2/);
  assert.match(workflow, /const SCRIPT_TEXT_REQUEST_TIMEOUT_MS = 60_000/);
  assert.match(workflow, /const SCRIPT_WRITING_SLA_MS = 9 \* 60_000/);
  assert.match(workflow, /model: SCRIPT_FAST_PUREAM_MODEL/);
  assert.match(workflow, /directFastSegmentRanges\(unitCount, SCRIPT_DIRECT_SEGMENT_UNITS\)/);
  assert.match(workflow, /mapWithConcurrency\(pending, SCRIPT_DIRECT_MAX_CONCURRENCY/);
  assert.match(workflow, /directFastSegments:/);
  assert.match(workflow, /buildDirectFastFallbackSegment/);
  assert.match(workflow, /mapWithConcurrency\(planTasks, SCRIPT_FAST_CONCURRENCY/);
  assert.match(workflow, /mapWithConcurrency\(unitTasks, SCRIPT_FAST_CONCURRENCY/);
  assert.match(workflow, /useFastScriptPath\s*\?\s*\{/);
  assert.match(workflow, /path: useFastScriptPath \? "parallel-fast-v2"/);
  assert.match(workflow, /metTarget: scriptElapsedSeconds !== null \? scriptElapsedSeconds <= SCRIPT_FAST_TARGET_SECONDS/);
});

test("storyboard sheet mode never schedules or reports a tail-frame wave", () => {
  const workflow = source("app/workbench-workflow.js");
  const renderer = source("app/renderer/workbench.js");
  assert.match(workflow, /const sheetMode = normalizeProjectMode\(project\.generation\?\.mode\) === "storyboard_sheet"/);
  assert.match(workflow, /const endPending = \(sheetMode \? \[\] : pending\.filter/);
  assert.match(workflow, /if \(sheetMode\) return results/);
  assert.match(workflow, /本模式没有首帧或尾帧/);
  assert.match(renderer, /本模式不生成首帧或尾帧/);
  assert.match(renderer, /本模式不检查尾帧/);
});

test("step execution runs only the requested stage and explicit full pipeline may cross stages", () => {
  const workflow = source("app/workbench-workflow.js");
  const renderer = source("app/renderer/workbench.js");
  const manifest = JSON.parse(source("package.json"));
  assert.match(workflow, /const stepExecution = project\.productionPlan\?\.executionMode !== "full" && options\.allowCrossStage !== true/);
  assert.match(workflow, /stepExecution\s*\? order\.indexOf\(stage\) === start\s*:\s*order\.indexOf\(stage\) >= start/);
  assert.match(workflow, /runTrackedOperation\(projectId, "full_pipeline"/);
  assert.match(workflow, /allowCrossStage: true/);
  assert.match(workflow, /await this\.generateCompleteScript\(projectId, \{ track: false \}\)/);
  assert.match(renderer, /pipeline_from_stage: "当前阶段续跑"/);
  assert.match(renderer, /不会自动提交视频/);
  assert.match(renderer, /不会自动拼接/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("step storyboard continuation cannot call video generation or stitching", async () => {
  const project = {
    id: "step-gate-project",
    productionPlan: { executionMode: "step" },
    generation: { mode: "storyboard_sheet", modeConfirmed: true, engine: "seedance", videoProviderKind: "local-xiangsu" },
    script: { raw: "完整剧本" },
    shots: [{ id: "shot-1", number: 1, duration: 8 }],
    automation: {}
  };
  const calls = [];
  const store = {
    getProject: () => project,
    getSettings: () => ({ videoProvider: { kind: "local-xiangsu" } }),
    saveProject: next => Object.assign(project, next)
  };
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: "" });
  workflow.generateAllStoryboards = async () => { calls.push("storyboards"); return []; };
  workflow.generateAllShotVideos = async () => { calls.push("videos"); return []; };
  workflow.stitchProject = async () => { calls.push("stitch"); return {}; };

  await workflow.runPipelineFromStage(project.id, "shots", { track: false });
  assert.deepEqual(calls, ["storyboards"]);

  const fullCalls = [];
  workflow.runPipelineFromStage = async (...args) => { fullCalls.push(args); return {}; };
  await WorkbenchWorkflow.prototype.runFullPipeline.call(workflow, project.id, { track: false });
  assert.equal(fullCalls.length, 1);
  assert.equal(fullCalls[0][1], "script");
  assert.equal(fullCalls[0][2].allowCrossStage, true);
});

test("different projects can run concurrently while the renderer locks only the active project", async () => {
  const projects = new Map([
    ["project-a", { id: "project-a", automation: {} }],
    ["project-b", { id: "project-b", automation: {} }]
  ]);
  const store = {
    getProject: id => projects.get(id),
    saveProject: project => projects.set(project.id, project)
  };
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: "" });
  let releaseA;
  const gateA = new Promise(resolve => { releaseA = resolve; });
  const runningA = workflow.runTrackedOperation("project-a", "topic_ideation", "", () => gateA);
  await new Promise(resolve => setImmediate(resolve));
  const runningB = workflow.runTrackedOperation("project-b", "topic_ideation", "", async () => "b-done");
  assert.equal(workflow.hasActiveOperation("project-a"), true);
  assert.equal(workflow.hasActiveOperation("project-b"), true);
  assert.equal(await runningB, "b-done");
  assert.equal(workflow.hasActiveOperation("project-a"), true);
  releaseA("a-done");
  assert.equal(await runningA, "a-done");

  const renderer = source("app/renderer/workbench.js");
  assert.match(renderer, /activeJobs: new Map\(\)/);
  assert.match(renderer, /projectBusyCounts: new Map\(\)/);
  assert.match(renderer, /const projectId = state\.project\?\.id \|\| ""/);
  assert.match(renderer, /if \(state\.project\?\.id === projectId\)/);
  assert.match(renderer, /原项目继续在后台运行；已切换查看另一个项目/);
  assert.doesNotMatch(renderer, /切换项目不会停止后台任务，只是切换查看界面。确定切换/);
});

test("historical project deletion is recoverable and preserves other projects and shared libraries", t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-project-delete-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const store = new WorkbenchStore(path.join(tempRoot, "workbench"));
  const first = store.createProject("准备删除的历史项目");
  const second = store.createProject("必须保留的项目");
  const marker = path.join(store.projectDir(first.id), "delete-scope-marker.txt");
  fs.writeFileSync(marker, "recoverable", "utf8");
  const sharedMarker = path.join(store.reusableAssetLibraryDir, "shared-marker.txt");
  fs.writeFileSync(sharedMarker, "keep", "utf8");

  const result = store.deleteProject(first.id);
  assert.equal(result.recoverable, true);
  assert.equal(store.listProjects().some(item => item.id === first.id), false);
  assert.equal(store.listProjects().some(item => item.id === second.id), true);
  assert.equal(fs.existsSync(store.projectDir(first.id)), false);
  assert.equal(fs.readFileSync(path.join(result.archivedPath, "delete-scope-marker.txt"), "utf8"), "recoverable");
  assert.equal(fs.readFileSync(sharedMarker, "utf8"), "keep");

  const main = source("app/main.js");
  const preload = source("app/preload.js");
  const html = source("app/renderer/workbench.html");
  assert.match(main, /workbench:delete-project/);
  assert.match(preload, /deleteProject: projectId => ipcRenderer\.invoke\("workbench:delete-project"/);
  assert.match(html, /id="deleteProject"/);
});

test("fresh installs and projects default to PUREAM cloud while local Xiangsu remains selectable", t => {
  const defaults = defaultSettings();
  assert.equal(defaults.videoProvider.kind, "puream-hailuo-h3");
  assert.equal(defaults.videoProvider.baseUrl, "https://puream.cn");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-default-cloud-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const store = new WorkbenchStore(path.join(tempRoot, "workbench"));
  const project = store.createProject("fresh default project");
  assert.equal(project.generation.videoProviderKind, "puream-hailuo-h3");
  assert.equal(project.generation.engine, "hailuo-h3");
  assert.equal(store.getSettings().videoProvider.kind, "puream-hailuo-h3");

  const html = source("app/renderer/workbench.html");
  assert.match(html, /value="puream-hailuo-h3"/);
  assert.match(html, /value="local-xiangsu"/);
  assert.match(html, /纯梦云端算力/);
  assert.match(html, /本地像塑/);
});
