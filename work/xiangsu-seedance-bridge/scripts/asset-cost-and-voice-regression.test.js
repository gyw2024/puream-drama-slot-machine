"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, buildCharacterSpeechScript } = require("../app/workbench-workflow");

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

function directSpeakingShots(characters, scenes) {
  return characters.map((character, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    number: index + 1,
    sceneId: scenes[index]?.id || scenes[0]?.id || "SC01",
    characterIds: [character.id],
    visibleCharacterIds: [character.id],
    focusCharacterId: character.id,
    duration: 6,
    dialogueTurns: [{ speakerId: character.id, text: `测试台词${index + 1}。` }],
    subshots: [{
      number: 1,
      start: 0,
      end: 6,
      visibleCharacterIds: [character.id],
      dialogueTurns: [{ speakerId: character.id, text: `测试台词${index + 1}。` }]
    }]
  }));
}

async function approveAllPrompts(workflow, store, projectId) {
  await workflow.preparePromptReviewBundle(projectId, { compileProviderSemantics: false });
  const review = store.getProject(projectId).promptReview;
  await workflow.confirmAllPromptReview(projectId, review.items.map(item => ({
    id: item.id,
    prompt: item.displayPrompt || item.prompt
  })));
}

test("optional timbre seed never copies screenplay or signature dialogue", () => {
  const signatureLine = "你敢再碰我妈一下，我今天就跟你拼了。";
  const sample = buildCharacterSpeechScript({
    signatureLine,
    voiceDescription: "中年女性，克制而坚定"
  }, 5);
  assert.doesNotMatch(sample, /你敢再碰我妈|跟你拼了/);
  assert.match(sample, /校准声音/);
});

test("three characters and three scenes submit exactly six paid images and no private portrait", async t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("六张图片成本合同", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  const characters = ["C01", "C02", "C03"].map((id, index) => ({ id, name: `角色${index + 1}` }));
  const scenes = ["SC01", "SC02", "SC03"].map((id, index) => ({ id, name: `场景${index + 1}` }));
  store.patchProject(created.id, {
    characters,
    scenes,
    shots: directSpeakingShots(characters, scenes),
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

  await approveAllPrompts(workflow, store, created.id);
  await workflow.generateAllAssets(created.id, { track: false, promptPrepared: true });

  assert.equal(paidImageStages.length, 6);
  assert.equal(paidImageStages.filter(stage => stage === "character_sheet").length, 3);
  assert.equal(paidImageStages.filter(stage => stage === "scene_asset").length, 3);
  assert.equal(paidImageStages.includes("character_intro"), false);
  const progress = store.getProject(created.id).automation.progress;
  assert.equal(progress.total, 6);
  assert.equal(progress.completed, 6);
});

test("image-only mode ignores missing legacy video and voice rows but still requires a direct speaker identity", t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("真实文件合同", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    characters: [{ id: "C01", name: "周桂兰" }],
    scenes: [{ id: "SC01", name: "客厅" }],
    shots: directSpeakingShots([{ id: "C01", name: "周桂兰" }], [{ id: "SC01", name: "客厅" }]),
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
  assert.equal(plan.some(item => item.kind === "character_video"), false);
  assert.equal(plan.some(item => item.kind === "character_voice"), false);
  assert.equal(plan.find(item => item.kind === "character_sheet").status, "queued");
});

test("image-only mode excludes uploaded voices from readiness and keeps only six required images", t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("已上传音色只补六张图片", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  const characters = ["C01", "C02", "C03"].map((id, index) => ({ id, name: `角色${index + 1}` }));
  const scenes = ["SC01", "SC02", "SC03"].map((id, index) => ({ id, name: `场景${index + 1}` }));
  store.patchProject(created.id, {
    characters,
    scenes,
    shots: directSpeakingShots(characters, scenes),
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true }
  });
  for (const character of characters) {
    store.addCandidate(created.id, {
      entityType: "character",
      entityId: character.id,
      stage: "character_voice",
      filePath: writeMedia(root, `uploaded-${character.id}.wav`, `voice:${character.id}`),
      selected: true,
      duration: 5,
      mediaProbeVerified: true,
      qualityAudit: { ok: true }
    });
  }

  const plan = workflow.buildAssetBatchPlan(created.id);
  const ready = plan.filter(item => ["completed", "skipped"].includes(item.status));
  const missing = plan.filter(item => !["completed", "skipped"].includes(item.status));

  assert.equal(plan.length, 6);
  assert.equal(ready.length, 0);
  assert.equal(missing.length, 6);
  assert.deepEqual([...new Set(missing.map(item => item.kind))].sort(), ["character_sheet", "scene_asset"]);
  assert.equal(plan.some(item => item.kind === "character_video"), false);
  assert.equal(plan.some(item => item.kind === "character_voice"), false);
});

test("image-only mode leaves a bound library voice untouched and never submits character videos", async t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("库音色直接复用", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  const voicePath = writeMedia(root, "bound-library-voice.wav", "bound voice");
  const entry = store.upsertVoiceLibraryEntry({
    id: "voice-bound-C01",
    label: "周桂兰音色",
    characterName: "周桂兰",
    filePath: voicePath,
    fileUrl: `file://${voicePath}`,
    duration: 5,
    mediaProbeVerified: true,
    audioAudit: { ok: true, source: "manual-import" }
  });
  store.patchProject(created.id, {
    characters: [{ id: "C01", name: "周桂兰", voiceLibraryId: entry.id }],
    scenes: [{ id: "SC01", name: "客厅" }],
    shots: directSpeakingShots([{ id: "C01", name: "周桂兰" }], [{ id: "SC01", name: "客厅" }]),
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true }
  });
  const staleVoice = store.addCandidate(created.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_voice",
    source: "voice-library",
    voiceLibraryId: entry.id,
    filePath: voicePath,
    selected: false,
    stale: true,
    staleReason: "identity was replaced"
  });
  const generatedStages = [];
  workflow.generateImageCandidate = async (projectId, stage, entityId) => {
    generatedStages.push(stage);
    return store.addCandidate(projectId, {
      entityType: stage === "scene_asset" ? "scene" : "character",
      entityId,
      stage,
      filePath: writeMedia(root, `${stage}-${entityId}.png`, `${stage}:${entityId}`),
      selected: true,
      qualityAudit: { ok: true }
    });
  };
  workflow.generateQualityCharacterVideo = async () => {
    throw new Error("bound voice must not submit a character video");
  };

  await approveAllPrompts(workflow, store, created.id);
  await workflow.generateAllAssets(created.id, { track: false, promptPrepared: true });

  const project = store.getProject(created.id);
  const voices = project.candidates.filter(item => item.entityType === "character" && item.entityId === "C01" && item.stage === "character_voice");
  assert.equal(voices.length, 1);
  assert.equal(voices[0].id, staleVoice.id, "image-only generation must not mutate an unused voice binding");
  assert.equal(voices[0].stale, true);
  assert.deepEqual(generatedStages.sort(), ["character_sheet", "scene_asset"]);
  assert.equal(project.candidates.some(item => item.stage === "character_video"), false);
  assert.equal(project.automation.progress.total, 2);
  assert.equal(project.automation.progress.completed, 2);
});

test("one project character materializes the same library voice only once", t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("voice materialization is idempotent", { engine: "hailuo-h3", mode: "asset_direct" });
  const voicePath = path.join(root, "library-source.wav");
  fs.copyFileSync(path.join(__dirname, "..", "app", "assets", "builtin-voices", "voice-01.wav"), voicePath);
  const entry = store.upsertVoiceLibraryEntry({
    id: "voice-idempotent-C01",
    label: "senior male fixture",
    characterName: "C01",
    gender: "male",
    ageBand: "老年",
    filePath: voicePath,
    duration: 4.32,
    mediaProbeVerified: true,
    profileVerified: true,
    audioAudit: { ok: true, source: "manual-import" }
  });
  store.patchProject(created.id, {
    characters: [{ id: "C01", name: "C01", gender: "male", ageBand: "老年", voiceLibraryId: entry.id }]
  });

  const first = workflow.materializeVoiceFromLibrary(created.id, "C01", entry.id);
  const second = workflow.materializeVoiceFromLibrary(created.id, "C01", entry.id);
  const voices = store.getProject(created.id).candidates.filter(candidate => (
    candidate.entityType === "character"
    && candidate.entityId === "C01"
    && candidate.stage === "character_voice"
    && candidate.source === "voice-library"
    && candidate.voiceLibraryId === entry.id
  ));
  assert.equal(second.id, first.id);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].selected, true);
});

test("character video reuses the existing four-view image", async t => {
  const { root, store, workflow } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = store.createProject("四视图复用", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  // Prompt review is now driven by the screenplay: a character-only fixture
  // compiles to zero review items and confirmAllPromptReview correctly refuses
  // with PROMPT_REVIEW_REQUIRED. Supply the shot the four-view reuse depends on.
  const characters = [{ id: "C01", name: "周桂兰", signatureLine: "你好" }];
  const scenes = [{ id: "SC01", name: "堂屋" }];
  store.patchProject(created.id, {
    characters,
    scenes,
    shots: directSpeakingShots(characters, scenes),
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

  await workflow.preparePromptReviewBundle(created.id, { autoApprove: false });
  await workflow.confirmAllPromptReview(created.id);
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

  const migration = store.migrateAssetProgressContracts();
  assert.equal(migration.migrated, 1);
  assert.deepEqual(migration.failures, []);
  project = store.getProject(created.id);
  assert.equal(project.automation.status, "paused");
  assert.equal(project.automation.stage, "assets");
  assert.equal(project.automation.recoverableFailure, true);
  assert.equal(project.automation.progress.total, 3);
  assert.equal(project.automation.progress.items.some(item => item.kind === "character_intro"), false);
  assert.equal(project.automation.progress.items.find(item => item.kind === "character_video").status, "queued");
  assert.equal(project.automation.progress.items.find(item => item.kind === "character_voice").status, "queued");
});
