"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-asset-cost-"));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.videoProvider = {
    ...(settings.videoProvider || {}),
    kind: "puream-hailuo-h3",
    baseUrl: "https://puream.cn",
    model: "hailuo-h3",
    apiKey: ""
  };
  store.saveSettings(settings);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  workflow.ensureProjectShotScenes = () => {};
  workflow.syncReferenceLibraries = () => ({});
  workflow.restoreUnchangedScriptAssets = () => [];
  workflow.reconcileProductionContracts = () => ({ ok: true });
  workflow.authoritativeGenerationConcurrency = async () => ({ image: 32, video: 16, source: "test", authority: "test" });
  return { root, store, workflow };
}

function writeMedia(root, name, content = "media") {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test("three characters and three scenes submit exactly six paid images and no private portrait", async t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("六张图片成本合同", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    characters: ["C01", "C02", "C03"].map((id, index) => ({ id, name: `角色${index + 1}` })),
    scenes: ["SC01", "SC02", "SC03"].map((id, index) => ({ id, name: `场景${index + 1}` })),
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true }
  });
  const paidImageStages = [];
  workflow.generateImageCandidate = async (projectId, stage, entityId) => {
    paidImageStages.push(stage);
    const filePath = writeMedia(root, `${stage}-${entityId}.png`, `${stage}:${entityId}`);
    return store.addCandidate(projectId, {
      entityType: stage === "scene_asset" ? "scene" : "character",
      entityId,
      stage,
      filePath,
      selected: true,
      qualityAudit: { ok: true }
    });
  };
  workflow.generateQualityCharacterVideo = async (projectId, characterId) => {
    const filePath = writeMedia(root, `character-video-${characterId}.mp4`, `video:${characterId}`);
    return store.addCandidate(projectId, {
      entityType: "character",
      entityId: characterId,
      stage: "character_video",
      filePath,
      selected: true,
      qualityAudit: { ok: true }
    });
  };
  workflow.ensureCharacterVoice = async (projectId, characterId) => {
    const filePath = writeMedia(root, `character-voice-${characterId}.wav`, `voice:${characterId}`);
    return store.addCandidate(projectId, {
      entityType: "character",
      entityId: characterId,
      stage: "character_voice",
      filePath,
      selected: true,
      duration: 5,
      mediaProbeVerified: true,
      qualityAudit: { ok: true }
    });
  };

  await workflow.generateAllAssets(created.id, { track: false });

  assert.equal(paidImageStages.length, 6);
  assert.equal(paidImageStages.filter(stage => stage === "character_sheet").length, 3);
  assert.equal(paidImageStages.filter(stage => stage === "scene_asset").length, 3);
  assert.equal(paidImageStages.includes("character_intro"), false);
  const progress = store.getProject(created.id).automation.progress;
  assert.equal(progress.total, 12);
  assert.equal(progress.completed, 12);
});

test("missing video and voice files can never be reported ready", t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("真实文件合同", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    characters: [{ id: "C01", name: "周桂兰" }],
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true }
  });
  store.addCandidate(created.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_video",
    filePath: path.join(root, "missing-video.mp4"),
    selected: true,
    qualityAudit: { ok: true }
  });
  store.addCandidate(created.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_voice",
    filePath: path.join(root, "missing-voice.wav"),
    selected: true,
    qualityAudit: { ok: true }
  });
  const plan = workflow.buildAssetBatchPlan(created.id);
  assert.equal(plan.find(item => item.kind === "character_video").status, "queued");
  assert.equal(plan.find(item => item.kind === "character_voice").status, "queued");
});

test("character video reuses the existing four-view image", async t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("四视图复用", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    characters: [{ id: "C01", name: "周桂兰", signatureLine: "你好" }],
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true }
  });
  const sheetPath = writeMedia(root, "character-sheet.png", "four-view");
  const sheet = store.addCandidate(created.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_sheet",
    filePath: sheetPath,
    selected: true,
    qualityAudit: { ok: true }
  });
  let submittedResources = null;
  workflow.resolveCharacterVideoPrompt = () => "A fictional Chinese adult speaks naturally to camera.";
  workflow.submitVideo = async (projectId, entityType, entityId, stage, prompt, resources) => {
    submittedResources = resources;
    const filePath = writeMedia(root, "character-video.mp4", "video");
    return store.addCandidate(projectId, { entityType, entityId, stage, prompt, filePath, selected: true, qualityAudit: { ok: true } });
  };

  await workflow.generateCharacterVideo(created.id, "C01", "", { track: false, audit: false });

  assert.deepEqual(submittedResources.images, [sheetPath]);
  assert.equal(submittedResources.imageRoles[0].candidateId, sheet.id);
  assert.equal(submittedResources.imageRoles[0].sourceStage, "character_sheet");
});

test("missing speaker voice performs one targeted asset recovery", async t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("单次音色恢复", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    characters: [{ id: "C01", name: "周桂兰" }],
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true }
  });
  let recoveryCalls = 0;
  workflow.generateAllAssets = async projectId => {
    recoveryCalls += 1;
    const filePath = writeMedia(root, "recovered-voice.wav", "voice");
    store.addCandidate(projectId, {
      entityType: "character",
      entityId: "C01",
      stage: "character_voice",
      filePath,
      selected: true,
      duration: 5,
      mediaProbeVerified: true,
      qualityAudit: { ok: true }
    });
    return [];
  };
  const supervisor = { repairs: 0, scriptRewrites: 0, transientRetries: 0, textProviderOverride: null, failuresByCode: new Map() };
  const error = Object.assign(new Error("镜头 S01 的说话角色缺少音色文件"), {
    code: "SHOT_SPEAKER_VOICE_REQUIRED",
    shotId: "S01",
    characterId: "C01"
  });

  assert.equal(await workflow.recoverAutonomousPipelineFailure(created.id, error, supervisor), true);
  assert.equal(await workflow.recoverAutonomousPipelineFailure(created.id, error, supervisor), false);
  assert.equal(recoveryCalls, 1);
});

test("startup reconciliation makes a false-complete legacy project resumable without submitting work", t => {
  const { root, store } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("旧进度恢复", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  const sheetPath = writeMedia(root, "ready-sheet.png", "sheet");
  let project = store.getProject(created.id);
  project.characters = [{ id: "C01", name: "周桂兰" }];
  project.candidates = [{
    id: "sheet",
    entityType: "character",
    entityId: "C01",
    stage: "character_sheet",
    filePath: sheetPath,
    selected: true,
    stale: false,
    productionRevision: project.productionRevision || ""
  }];
  project.automation = {
    ...project.automation,
    operation: "idea_to_full_pipeline",
    status: "failed",
    errorCode: "AUTONOMOUS_PIPELINE_REPAIR_EXHAUSTED",
    progress: {
      kind: "asset_batch",
      total: 4,
      completed: 4,
      failed: 0,
      queued: 0,
      running: [],
      percent: 100,
      items: [
        { key: "character_sheet:C01", kind: "character_sheet", entityId: "C01", status: "skipped", label: "人物四视图" },
        { key: "character_intro:C01", kind: "character_intro", entityId: "C01", status: "skipped", label: "旧正脸图" },
        { key: "character_video:C01", kind: "character_video", entityId: "C01", status: "skipped", label: "人物视频" },
        { key: "character_voice:C01", kind: "character_voice", entityId: "C01", status: "skipped", label: "音色" }
      ]
    }
  };
  store.saveProject(project);

  project = store.getProject(created.id);
  assert.equal(project.automation.status, "paused");
  assert.equal(project.automation.stage, "assets");
  assert.equal(project.automation.recoverableFailure, true);
  assert.equal(project.automation.progress.total, 3);
  assert.equal(project.automation.progress.items.some(item => item.kind === "character_intro"), false);
  assert.equal(project.automation.progress.items.find(item => item.kind === "character_video").status, "queued");
  assert.equal(project.automation.progress.items.find(item => item.kind === "character_voice").status, "queued");
});
