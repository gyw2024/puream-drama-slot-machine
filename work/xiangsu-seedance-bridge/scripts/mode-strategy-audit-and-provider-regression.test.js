"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BridgeClient } = require("../app/bridge-client");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, isQualityGatesEnabled } = require("../app/workbench-workflow");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("an unconfigured audit blueprint never enables any blocker", () => {
  const root = temporaryDirectory("puream-explicit-audit-");
  try {
    const settings = new WorkbenchStore(root).getSettings();
    assert.equal(settings.generation.qualityGatesEnabled, false);
    assert.equal(Object.values(settings.generation.qualityGateModules).some(Boolean), false);
    assert.equal(Object.values(settings.generation.blueprintAuditChecks).some(Boolean), false);
    for (const moduleName of ["script", "assets", "storyboards", "videos", "delivery"]) {
      assert.equal(isQualityGatesEnabled({}, moduleName), false);
      assert.equal(isQualityGatesEnabled({ generation: { qualityGatesEnabled: true } }, moduleName), false);
      assert.equal(isQualityGatesEnabled(settings, moduleName), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new-project and project-strategy contracts expose all three script modes and examples", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  for (const scope of ["newScriptFormat", "projectScriptFormat"]) {
    for (const format of ["production", "dialogue", "timed_storyboard"]) {
      assert.match(html, new RegExp(`name="${scope}" value="${format}"`));
    }
  }
  assert.match(renderer, /scriptFormatConfirmed: inputMode === "ai"/);
  assert.match(renderer, /scriptFormatConfirmed: nextInputMode === "ai"/);
  assert.match(renderer, /plan\.inputMode === "manual" \|\| plan\.scriptFormatConfirmed === true/);
  assert.match(renderer, /const firstExplicitEnable = enabled/);
  assert.ok((html.match(/data-script-format-example=/g) || []).length >= 9);
  assert.doesNotMatch(html, /id="qualityBlueprintMaster"[^>]*\schecked/);
  assert.doesNotMatch(html, /data-quality-module="[^"]+"[^>]*\schecked/);
  assert.doesNotMatch(html, /data-blueprint-check="[^"]+"[^>]*\schecked/);
});

test("an explicit 云端算力节点 quarantine response is preserved instead of mislabeled as an unknown submission", async () => {
  const root = temporaryDirectory("puream-cloud-node-code-");
  try {
    const client = new BridgeClient({
      tokenPath: path.join(root, "bridge-token"),
      fetchImpl: async () => jsonResponse({ code: "PROVIDER_QUARANTINED", message: "云端算力节点 服务已隔离" }, 503)
    });
    client.configure({ kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", apiKey: "test-activation", hailuoApiMode: "text_to_video" });
    await assert.rejects(() => client.submit({
      providerKind: "puream-hailuo-h3",
      clientRequestId: "quarantine-contract-test",
      prompt: "A person speaks to camera.",
      duration: 10,
      hailuoApiMode: "text_to_video",
      aspectRatio: "9:16",
      images: [], videos: [], videoAudios: [], audios: [],
      outputDir: root
    }), error => {
      assert.equal(error.code, "PROVIDER_QUARANTINED");
      assert.equal(error.remoteSubmissionUnknown, undefined);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy project engine requests are normalized to H3 and default to image-only prerequisites", () => {
  const root = temporaryDirectory("puream-character-provider-matrix-");
  try {
    const store = new WorkbenchStore(root);
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
    const local = store.createProject("旧引擎迁移", { engine: "retired", mode: "keyframe" });
    store.patchProject(local.id, { characters: [{ id: "C01", name: "林梅" }], generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true } });
    const localKinds = workflow.buildAssetBatchPlan(local.id).map(item => item.kind);
    assert.equal(store.getProject(local.id).generation.engine, "hailuo-h3");
    assert.equal(store.getProject(local.id).generation.videoProviderKind, "puream-hailuo-h3");
    assert.equal(localKinds.includes("character_video"), false);
    assert.equal(localKinds.includes("character_voice"), false);

    const cloud = store.createProject("云端算力", { engine: "hailuo-h3", mode: "storyboard_sheet" });
    store.patchProject(cloud.id, { characters: [{ id: "C01", name: "林梅" }], generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true } });
    const cloudKinds = workflow.buildAssetBatchPlan(cloud.id).map(item => item.kind);
    assert.equal(cloudKinds.includes("character_video"), false);
    assert.equal(cloudKinds.includes("character_voice"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loading a materialized legacy project migrates its complete video contract to H3", () => {
  const root = temporaryDirectory("puream-provider-video-only-switch-");
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("平滑切 H3", { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe" });
    const project = store.getProject(created.id);
    project.generation = { ...project.generation, engine: "retired", videoProviderKind: "retired", durationContract: { providerKind: "retired", targetSeconds: 10 } };
    project.productionRevision = "revision_active";
    project.characters = [{ id: "C01", name: "林秀兰" }];
    project.scenes = [{ id: "SC01", name: "客厅" }];
    project.shots = [{ id: "S01", number: 1, sceneId: "SC01", dialogueTurns: [{ speakerId: "C01", speaker: "林秀兰", text: "我回来了。" }] }];
    const stages = ["character_sheet", "storyboard_start", "storyboard_end", "character_voice", "character_video", "shot_video"];
    project.candidates = stages.map((stage, index) => ({
      id: `candidate_${index}`,
      entityType: stage.startsWith("storyboard") || stage === "shot_video" ? "shot" : "character",
      entityId: stage.startsWith("storyboard") || stage === "shot_video" ? "S01" : "C01",
      stage,
      productionRevision: project.productionRevision,
      selected: true,
      stale: false
    }));
    project.promptReview = { version: "old", status: "approved", items: [] };
    project.finalVideoPath = path.join(root, "old-final.mp4");
    fs.writeFileSync(store.projectPath(created.id), JSON.stringify(project, null, 2));
    const switched = store.getProject(created.id);
    assert.equal(switched.generation.engine, "hailuo-h3");
    assert.equal(switched.generation.videoProviderKind, "puream-hailuo-h3");
    assert.equal(switched.generation.durationContract?.providerKind, "puream-hailuo-h3");
    assert.equal(switched.productionRevision, "revision_active");
    assert.equal(switched.characters.length, 1);
    assert.equal(switched.scenes.length, 1);
    assert.equal(switched.shots.length, 1);
    for (const stage of ["character_sheet", "storyboard_start", "storyboard_end", "character_voice"]) {
      const candidate = switched.candidates.find(item => item.stage === stage);
      assert.equal(candidate.stale, false, `${stage} should remain reusable`);
      assert.equal(candidate.selected, true, `${stage} should stay selected`);
    }
    assert.equal(switched.promptReview.status, "approved");
    assert.equal(switched.finalVideoPath, path.join(root, "old-final.mp4"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renderer and settings expose one cloud video engine only", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  assert.match(renderer, /kind: "puream-hailuo-h3"/);
  assert.match(renderer, /model: "hailuo-h3"/);
  assert.match(renderer, /云端视频（锁定）/);
  assert.doesNotMatch(renderer, /videoProviderEngine\(kind\) ===/);
  assert.match(html, /asset_direct/);
});

test("image-only generation never queues a character-video outage and completes independent visual assets", async () => {
  const root = temporaryDirectory("puream-asset-dependency-");
  try {
    const store = new WorkbenchStore(root);
    const settings = store.getSettings();
    settings.videoProvider = { ...settings.videoProvider, kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", model: "hailuo-h3", apiKey: "" };
    store.saveSettings(settings);
    const created = store.createProject("依赖分层", { engine: "hailuo-h3", mode: "smart" });
    // The prompt-review boundary is compiled from the screenplay. Without a
    // shot this project yields zero review items, so confirmAllPromptReview
    // (correctly) refuses with PROMPT_REVIEW_REQUIRED before any asset work
    // can be observed. Supply the single speaking shot this case is about.
    store.patchProject(created.id, {
      characters: [{ id: "C01", name: "林梅" }],
      scenes: [{ id: "SC01", name: "客厅" }],
      shots: [{
        id: "S01",
        number: 1,
        sceneId: "SC01",
        characterIds: ["C01"],
        visibleCharacterIds: ["C01"],
        focusCharacterId: "C01",
        duration: 6,
        dialogueTurns: [{ speakerId: "C01", text: "测试台词。" }],
        subshots: [{
          number: 1,
          start: 0,
          end: 6,
          visibleCharacterIds: ["C01"],
          dialogueTurns: [{ speakerId: "C01", text: "测试台词。" }]
        }]
      }],
      generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "smart", modeConfirmed: true }
    });
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
    workflow.ensureProjectShotScenes = () => {};
    workflow.syncReferenceLibraries = () => ({});
    workflow.reconcileProductionContracts = () => ({ ok: true });
    const addImage = (stage, entityId) => {
      const filePath = path.join(root, `${stage}-${entityId}.png`);
      fs.writeFileSync(filePath, Buffer.from("image"));
      // entityType must match the stage's owner: a scene_asset registered as a
      // character candidate is rejected by the batch as a type/ID/stage
      // mismatch, which would surface as ASSET_BATCH_PARTIAL_FAILED instead of
      // the completion this case is asserting.
      // This case asserts that image-only mode completes its independent
      // visual assets and reports progress.failed === 0, so the stub must also
      // return a passing audit rather than one recorded as failed.
      const entityType = stage === "scene_asset" ? "scene" : "character";
      return store.addCandidate(created.id, { entityType, entityId, stage, filePath, selected: true, qualityAudit: { ok: true } });
    };
    workflow.generateImageCandidate = async (_projectId, stage, entityId) => addImage(stage, entityId);
    workflow.generateQualityCharacterVideo = async () => {
      throw Object.assign(new Error("云端算力节点 服务已隔离"), { code: "PROVIDER_QUARANTINED" });
    };
    await workflow.preparePromptReviewBundle(created.id, { compileProviderSemantics: false });
    const review = store.getProject(created.id).promptReview;
    await workflow.confirmAllPromptReview(created.id, review.items.map(item => ({
      id: item.id,
      prompt: item.displayPrompt || item.prompt
    })));
    const results = await workflow.generateAllAssets(created.id, { track: false, promptPrepared: true });
    assert.ok(results.some(item => item.stage === "character_sheet"));
    assert.equal(results.some(item => item.stage === "character_intro"), false);
    assert.equal(workflow.buildAssetBatchPlan(created.id).some(item => item.kind === "character_intro"), false);
    const progress = store.getProject(created.id).automation.progress;
    assert.equal(progress.items.some(item => item.kind === "character_video"), false);
    assert.equal(progress.items.some(item => item.kind === "character_voice"), false);
    assert.equal(progress.failed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
