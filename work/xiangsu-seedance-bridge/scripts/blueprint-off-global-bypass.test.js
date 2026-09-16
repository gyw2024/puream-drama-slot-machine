"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const videoStatus = require("../app/workbench-status");
const { stageCounts } = require("../app/project-overview");

test("blueprint master off accepts old media and delegates missing prompt authoring to the Agent", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-blueprint-global-off-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("关闭审核全局旁路", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true },
    characters: [{ id: "C01", name: "林晓梅" }],
    scenes: [{ id: "SC01", name: "客厅" }],
    shots: [{ id: "S01", number: 1, title: "开门", duration: 10, sceneId: "SC01", characterIds: ["C01"], visibleCharacterIds: ["C01"], offscreenSpeakerIds: [], dialogueTurns: [{ speakerId: "C01", speaker: "林晓梅", text: "住手！你凭什么这么做？" }], subshots: [{ number: 1, start: 0, end: 10, action: "林晓梅开门质问", visibleCharacterIds: ["C01"], dialogueTurns: [{ speakerId: "C01", text: "住手！你凭什么这么做？" }] }] }]
  });
  const files = {};
  for (const name of ["scene", "sheet", "video"]) {
    files[name] = path.join(root, `${name}.${name === "video" ? "mp4" : "png"}`);
    fs.writeFileSync(files[name], name);
  }
  const scene = store.addCandidate(created.id, { entityType: "scene", entityId: "SC01", stage: "scene_asset", filePath: files.scene, qualityAudit: { ok: false, failures: [{ code: "OLD_SCENE_QC" }] } });
  const sheet = store.addCandidate(created.id, { entityType: "shot", entityId: "S01", stage: "storyboard_sheet", filePath: files.sheet, qualityAudit: { ok: false, failures: [{ code: "OLD_SHEET_QC" }] } });
  const video = store.addCandidate(created.id, { entityType: "shot", entityId: "S01", stage: "shot_video", filePath: files.video, qualityAudit: { ok: false, failures: [{ code: "OLD_VIDEO_QC" }] } });

  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: async () => { throw new Error("text provider must not run"); } });
  const reusableScene = store.depositReusableAssetFromCandidate(created.id, scene.id);
  assert.equal(reusableScene.kind, "scene", "blueprint off must not block global-library deposit because of an old audit result");
  const sceneAudit = await workflow.auditSceneAssetCandidate(created.id, "SC01", scene.id);
  assert.equal(sceneAudit.skipped, true);
  assert.equal((await workflow.auditStoryboardCandidate(created.id, "S01", sheet.id)).skipped, true);
  const selected = store.confirmCandidate(created.id, video.id, false);
  assert.equal(selected.selected, true);
  assert.equal(selected.qualityAudit, null);
  assert.equal(selected.qualityAuditHistory[0].ok, false);
  const project = store.getProject(created.id);
  assert.equal(videoStatus.summarizeShotVideos(project, store.getSettings()).allReady, true);
  const counts = stageCounts(project, store.getSettings());
  assert.equal(counts.scenes.ready, 1);
  assert.equal(counts.storyboards.ready, 1);
  assert.equal(counts.videos.ready, 1);
  let authorCalls=0;
  workflow.authorAgentProductionDecisions=async(id,options)=>{authorCalls++;assert.deepEqual(options.shotIds,['S01']);const p=store.getProject(id);p.shots[0].finalPromptEditing={status:'authored',detailedDescriptionEn:'Agent authored source performance'};p.shots[0].finalPromptEditing.fingerprint=require('../app/h3-final-prompt-editor').fingerprint(p.shots[0]);store.saveProject(p);return p;};
  const spec = await workflow.ensureHailuoPromptSpec(created.id, "S01", "storyboard_sheet", store.getSettings());
  assert.equal(authorCalls,1);assert.equal(spec.detailedDescriptionEn,'Agent authored source performance');
});

test("blueprint master off runs production without video audits or audit-triggered rerolls", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-blueprint-zero-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  settings.generation.qualityGateModules = { script: true, assets: true, storyboards: true, videos: true, delivery: true };
  store.saveSettings(settings);
  const created = store.createProject("zero-audit", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true },
    characters: [{ id: "C01", name: "Lead" }],
    scenes: [{ id: "SC01", name: "Room", description: "empty room" }],
    shots: [{ id: "S01", number: 1, title: "Beat", duration: 8, sceneId: "SC01", characterIds: ["C01"], visibleCharacterIds: ["C01"], dialogueTurns: [] }]
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "ffmpeg", stagingRoot: root, textGenerator: async () => { throw new Error("text provider must not run"); } });
  let auditCalls = 0;
  let technicalAuditCalls = 0;
  for (const name of ["auditSceneAssetCandidate", "auditCharacterIntroCandidate", "auditStoryboardCandidate", "auditCharacterVideoCandidate", "auditShotCandidate"]) {
    workflow[name] = async () => {
      auditCalls += 1;
      throw new Error(`${name} must not run while blueprint is off`);
    };
  }
  workflow.imagePrompt = () => "deterministic image prompt";
  workflow.generateImageCandidate = async (projectId, stage, entityId) => {
    const filePath = path.join(root, `${stage}-${entityId}.png`);
    fs.writeFileSync(filePath, stage);
    return store.addCandidate(projectId, {
      entityType: stage === "scene_asset" ? "scene" : (stage === "character_intro" ? "character" : "shot"),
      entityId,
      stage,
      filePath
    });
  };
  workflow.generateCharacterVideo = async (projectId, characterId) => {
    const filePath = path.join(root, `character-${characterId}.mp4`);
    fs.writeFileSync(filePath, "video");
    return store.addCandidate(projectId, { entityType: "character", entityId: characterId, stage: "character_video", filePath });
  };
  workflow.generateShotVideo = async (projectId, shotId) => {
    const filePath = path.join(root, `shot-${shotId}.mp4`);
    fs.writeFileSync(filePath, "video");
    return store.addCandidate(projectId, { entityType: "shot", entityId: shotId, stage: "shot_video", filePath });
  };
  workflow.auditTechnicalShotCandidate = async () => {
    technicalAuditCalls += 1;
    return { ok: true, version: "test", checkedAt: new Date().toISOString(), mandatory: true, failures: [], repairDirective: "" };
  };
  workflow.technicalVideoAuditIsCurrent = () => false;

  const localPlan = await workflow.ensureAgentCameraTakePlan(created.id, "S01", "storyboard_sheet", store.getSettings());
  assert.equal(localPlan.authoredBy, "deterministic-local-production-plan");
  await workflow.ensureSceneAssetCandidate(created.id, "SC01");
  await workflow.ensureCharacterIntroCandidate(created.id, "C01");
  await workflow.ensureStoryboardCandidate(created.id, "storyboard_sheet", "S01");
  await workflow.generateQualityCharacterVideo(created.id, "C01");
  await workflow.generateQualityShotVideo(created.id, store.getProject(created.id).shots[0], "storyboard_sheet", { force: true });
  const recoveredPath = path.join(root, "recovered.mp4");
  fs.writeFileSync(recoveredPath, "video");
  const recovered = store.addCandidate(created.id, { entityType: "shot", entityId: "S01", stage: "shot_video", filePath: recoveredPath });
  await workflow.auditRecoveredVideoCandidate(created.id, recovered);

  assert.equal(auditCalls, 0, "master off must prevent audit invocation, not merely return a skipped result from inside the auditor");
  assert.equal(technicalAuditCalls, 0, "production-only mode must not invoke video audits after the master switch is off");
});
