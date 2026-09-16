"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION,
  promptReviewSettingsFingerprint,
  promptReviewSourceFingerprint,
  candidateReady,
  assertShotReferenceBundle,
  renderApprovedVideoPrompt,
  resolveHailuoApiModeForStrategy,
  resolveShotVideoStrategy
} = require("../app/workbench-workflow");
const { importDramaAssetPackage, productionAuditFingerprint } = require("../app/drama-asset-package");
const { PRODUCTION_PACKAGE_MODE, matrixEntry } = require("../app/production-mode-matrix");
const { imageFileResponse } = require("../app/secure-asset-protocol");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zr0sAAAAASUVORK5CYII=", "base64");

function imageAsset(id, kind, entityId) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const color = crypto.createHash("sha256").update(id).digest().subarray(0, 3);
  const bitmap = Buffer.concat([PNG.subarray(0, 8), chunk("IHDR", Buffer.from("00000001000000010806000000", "hex")), chunk("IDAT", require("node:zlib").deflateSync(Buffer.concat([Buffer.from([0]), color, Buffer.from([255])]))), chunk("IEND", Buffer.alloc(0))]);
  return {
    id,
    kind,
    entityId,
    fileName: `${id}.png`,
    mimeType: "image/png",
    sha256: crypto.createHash("sha256").update(bitmap).digest("hex"),
    dataBase64: bitmap.toString("base64"),
    prompt: "A locked photorealistic identity reference."
  };
}

function packageFixture() {
  const dialogueTurns = [{
    sourceDialogueId: "D001",
    speakerId: "C01",
    speaker: "林曼秋",
    listenerIds: ["C02"],
    subjectIndex: 1,
    start: 0.5,
    end: 9.23,
    text: "邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。",
    deliveryEn: "A restrained suspicious question, firm on the key noun and lowered at the ending.",
    vocalArcEn: "The voice begins low, stresses the invitation, then ends in a firm downward contour without trailing off.",
    facialPerformanceEn: "C01 narrows the eyes at C02 and holds the stare after the final syllable.",
    bodyActionEn: "C01 stays screen-left and raises the card without crossing the established axis.",
    listenerReactionEn: "C02 stays screen-right, keeps closed lips, and recoils once.",
    blockingEn: "C01 holds screen-left foreground while C02 remains screen-right midground on the established 180-degree axis.",
    speakerFacingEn: "C01 faces C02 in a readable three-quarter profile and never looks into the camera.",
    eyelineEn: "C01 looks screen-right toward C02 while C02 returns the eyeline screen-left."
  }];
  const payload = {
    format: "puream-drama-production-package",
    version: 2,
    project: {
      title: "独立资产包模式回归",
      script: "S01。林曼秋：邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。",
      aspectRatio: "9:16",
      generation: {
        mode: "production_package",
        referenceAudioMode: "image_only",
        videoApiMode: "reference_to_video"
      },
      productionAudit: {
        schemaVersion: 1,
        reviewer: "codex_semantic_review",
        reviewedAt: "2026-09-03T00:00:00.000Z",
        layer1Story: {
          status: "approved",
          openingExplainedBySecond: 7,
          openingHook: "林曼秋举起邀请券当面逼问哈桑，开场立即呈现信任危机。",
          corePremise: "林曼秋必须确认哈桑是否兑现入场承诺，哈桑退缩使合作裂痕公开。",
          protagonistId: "C01",
          relationshipMap: "林曼秋与哈桑是互相利用但缺乏信任的合作关系。",
          incitingEvent: "哈桑没有主动拿出承诺的邀请券，林曼秋当场追问。",
          primaryConflict: "林曼秋要求事实，哈桑试图回避承诺。",
          protagonistGoal: "林曼秋必须立刻确认邀请券是否到手。",
          stakes: "拿不到邀请券就会失去进入会场的机会。",
          innerCore: "信任必须由事实兑现，而不是由空头承诺维持。",
          irreversibleOpeningTurn: "林曼秋公开举券逼问，哈桑后退，隐瞒转为正面对峙。",
          openingEvidenceDialogueIds: ["D001"],
          reversalShotIds: ["S01"],
          causalChain: []
        },
        layer2Performance: { status: "approved", reviewedShotIds: ["S01"], noConflictConfirmed: true },
        layer3Alignment: {
          status: "approved",
          reviewedShotIds: ["S01"],
          reviewedAssetIds: ["asset_C01", "asset_C02", "asset_SC01"],
          noMismatchConfirmed: true
        }
      },
      sourceDialogueLedger: [{ id: "D001", speakerId: "C01", speaker: "林曼秋", text: "邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。" }],
      characters: [
        { id: "C01", name: "林曼秋", gender: "female", age: "61", ageBand: "older", castingTier: "lead", appearanceDescription: "One consistent elegant older woman.", assetId: "asset_C01" },
        { id: "C02", name: "哈桑", gender: "male", age: "49", ageBand: "middle_aged", castingTier: "supporting", appearanceDescription: "One consistent middle-aged man.", assetId: "asset_C02" }
      ],
      scenes: [{ id: "SC01", name: "玻璃长廊", description: "An empty glass corridor at night.", assetId: "asset_SC01" }],
      props: [],
      wardrobes: [],
      product: {},
      shots: [{
        id: "S01",
        number: 1,
        duration: 10,
        title: "邀请券逼问",
        sceneId: "SC01",
        characterIds: ["C01", "C02"],
        visibleCharacterIds: ["C01", "C02"],
        action: "林曼秋举起邀请券逼问哈桑。",
        actionEn: "C01 raises the invitation card and questions C02; C02 recoils once.",
        criticalActionEn: "C01 raises the invitation card and questions C02; C02 recoils once.",
        actionBeats: [{
          start: 0,
          end: 10,
          actionEn: "C01 raises the invitation card and questions C02; C02 recoils once.",
          cameraEn: "Hold the established medium two-shot and push slightly toward C01.",
          framingEn: "medium two-shot"
        }],
        dialogueTurns,
        references: [
          { assetId: "asset_SC01", type: "scene", entityId: "SC01", label: "SC01 location reference" },
          { assetId: "asset_C01", type: "character", entityId: "C01", label: "C01 identity reference" },
          { assetId: "asset_C02", type: "character", entityId: "C02", label: "C02 identity reference" }
        ],
        videoPromptEn: "",
        videoPromptZh: "【中文核对稿】林曼秋在左侧举券逼问，哈桑在右侧闭口后退。对白：林曼秋“邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。”"
      }]
    },
    assets: [
      imageAsset("asset_C01", "character", "C01"),
      imageAsset("asset_C02", "character", "C02"),
      imageAsset("asset_SC01", "scene", "SC01")
    ]
  };
  const sourceShot = payload.project.shots[0];
  const renderProject = {
    generation: { mode: PRODUCTION_PACKAGE_MODE, aspectRatio: "9:16" },
    characters: payload.project.characters,
    scenes: payload.project.scenes,
    assetLibraries: { props: [], wardrobes: [] },
    product: {},
    shots: []
  };
  const renderShot = {
    ...sourceShot,
    subshots: sourceShot.actionBeats.map((beat, index) => ({
      ...beat,
      number: index + 1,
      action: beat.actionEn,
      camera: beat.cameraEn,
      dialogueTurns
    }))
  };
  renderProject.shots = [renderShot];
  const renderReferences = {
    referenceAudioMode: "image_only",
    hailuoApiMode: "reference_to_video",
    images: ["scene.png", "c01.png", "c02.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [],
    videos: [],
    videoRoles: []
  };
  payload.project.shots[0].videoPromptEn = renderApprovedVideoPrompt(renderProject, renderShot, renderReferences);
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(payload);
  return payload;
}

function importedHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-package-mode-v128-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packagePath = path.join(root, "fixture.pdramapack");
  fs.writeFileSync(packagePath, JSON.stringify(packageFixture()));
  const store = new WorkbenchStore(path.join(root, "store"));
  const imported = importDramaAssetPackage(store, packagePath, {
    promptReviewVersion: PROMPT_REVIEW_BUNDLE_VERSION,
    promptReviewSourceFingerprint,
    promptReviewSettingsFingerprint
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  return { root, store, workflow, imported, project: store.getProject(imported.projectId) };
}

test("production package is a first-class mode, not asset-direct or a first-frame strategy", t => {
  const { project, workflow } = importedHarness(t);
  const shot = project.shots[0];
  const strategy = resolveShotVideoStrategy(project, shot);
  assert.equal(project.generation.mode, PRODUCTION_PACKAGE_MODE);
  assert.equal(strategy.strategy, PRODUCTION_PACKAGE_MODE);
  assert.equal(strategy.usePreviousVideo, false);
  assert.deepEqual(strategy.frameStages, []);
  assert.equal(shot.videoStrategy, PRODUCTION_PACKAGE_MODE);
  assert.deepEqual(shot.videoFrameStages, []);
  const references = workflow.shotReferences(project, shot, PRODUCTION_PACKAGE_MODE);
  assert.deepEqual(references.imageRoles.map(role => role.type), ["scene", "character", "character"]);
  assert.equal(references.referenceAudioMode, "image_only");
  assert.deepEqual(references.audios, []);
  assert.deepEqual(references.videos, []);
  assert.equal(references.importedReferenceOrderLocked, true);
  assert.equal(references.hailuoApiMode, "reference_to_video");
  assert.equal(references.officialImageOnlyMultiReference, true);
  assert.equal(resolveHailuoApiModeForStrategy(PRODUCTION_PACKAGE_MODE, "multimodal_to_video", false), "reference_to_video");
  assert.throws(
    () => resolveHailuoApiModeForStrategy(PRODUCTION_PACKAGE_MODE, "image_to_video", true),
    error => error?.code === "PRODUCTION_PACKAGE_AUDIO_FORBIDDEN"
  );
  assert.match(matrixEntry("cloud", PRODUCTION_PACKAGE_MODE).label, /Codex 资产包直抽/u);
  assert.notEqual(matrixEntry("cloud", PRODUCTION_PACKAGE_MODE).key, matrixEntry("cloud", "asset_direct").key);
});

test("package with separate imported assets is accepted without a derived shot anchor", t => {
  const { store, workflow, project } = importedHarness(t);
  const current = store.getProject(project.id);
  current.shots[0].promptReviewReferencePlan.images = [
    { index: 1, type: "scene", entityId: "SC01", assetId: "asset_SC01" },
    { index: 2, type: "character", entityId: "C01", assetId: "asset_C01" },
    { index: 3, type: "character", entityId: "C02", assetId: "asset_C02" }
  ];
  store.saveProject(current);
  const references = workflow.shotReferences(store.getProject(project.id), store.getProject(project.id).shots[0], PRODUCTION_PACKAGE_MODE);
  assert.deepEqual(references.imageRoles.map(role => role.type), ["scene", "character", "character"]);
  assert.equal(references.hailuoApiMode, "reference_to_video");
  assert.equal(references.audios.length, 0);
});

for (const legacyFlag of [false, undefined]) {
  test(`legacy package identity flag ${legacyFlag} is derived before the real submission gate`, async t => {
    const { store, workflow, project } = importedHarness(t);
    const current = store.getProject(project.id);
    for (const role of current.shots[0].promptReviewReferencePlan.images) {
      if (role.type === "character") {
        if (legacyFlag === undefined) delete role.identityOnly;
        else role.identityOnly = legacyFlag;
      }
    }
    store.saveProject(current);
    const snapshot = store.getProject(project.id);
    const originalPlan = JSON.stringify(snapshot.shots[0].promptReviewReferencePlan);
    const references = workflow.shotReferences(snapshot, snapshot.shots[0], PRODUCTION_PACKAGE_MODE);
    assert.deepEqual(references.imageRoles.map(role => role.identityOnly), [false, true, true]);
    assert.deepEqual(references.imageRoles.map(role => role.assetId), ["asset_SC01", "asset_C01", "asset_C02"]);
    assert.equal(JSON.stringify(snapshot.shots[0].promptReviewReferencePlan), originalPlan);
    assert.equal(assertShotReferenceBundle(snapshot, snapshot.shots[0], PRODUCTION_PACKAGE_MODE, references, null, store.getSettings()), true);
    await workflow.confirmAllPromptReview(project.id);
    const result = await workflow.generateAllShotVideos(project.id, { track: false, promptPrepared: true, preflightOnly: true });
    assert.equal(result.preflightOnly, true);
    assert.deepEqual(result.paidVideoStateBefore, result.paidVideoStateAfter);
    assert.equal(store.getProject(project.id).jobs.filter(job => job.type === "shot_video").length, 0);
    const invalid = structuredClone(references);
    invalid.imageRoles[1].type = "scene";
    assert.throws(() => assertShotReferenceBundle(snapshot, snapshot.shots[0], PRODUCTION_PACKAGE_MODE, invalid, null, store.getSettings()),
      error => error.code === "CHARACTER_SHEET_VIDEO_REFERENCE_FORBIDDEN");
  });
}

test("prompt-review refresh preserves imported asset ids and exact Picture order", async t => {
  const { store, workflow, project } = importedHarness(t);
  const before = store.getProject(project.id).shots[0].promptReviewReferencePlan.images;
  const beforeDialogue = store.getProject(project.id).shots.map(shot => (
    shot.dialogueTurns || []
  ).map(turn => [turn.sourceDialogueId, turn.speakerId, turn.text]));
  assert.deepEqual(before.map(item => item.assetId), ["asset_SC01", "asset_C01", "asset_C02"]);
  const refreshed = await workflow.preparePromptReviewBundle(project.id);
  const after = refreshed.shots[0].promptReviewReferencePlan.images;
  assert.deepEqual(after.map(item => item.assetId), ["asset_SC01", "asset_C01", "asset_C02"]);
  assert.deepEqual(after.map(item => item.entityId), ["SC01", "C01", "C02"]);
  assert.deepEqual(after.map(item => item.identityOnly), [false, true, true]);
  assert.deepEqual(refreshed.shots.map(shot => (
    shot.dialogueTurns || []
  ).map(turn => [turn.sourceDialogueId, turn.speakerId, turn.text])), beforeDialogue);
  const references = workflow.shotReferences(refreshed, refreshed.shots[0], PRODUCTION_PACKAGE_MODE);
  assert.deepEqual(references.imageRoles.map(item => item.assetId), ["asset_SC01", "asset_C01", "asset_C02"]);
  assert.deepEqual(references.imageRoles.map(item => item.identityOnly), [false, true, true]);
  assert.equal(references.importedReferenceOrderLocked, true);
});

test("package dependency preview and storyboard/asset stages are hard zero-generation", async t => {
  const { store, workflow, project } = importedHarness(t);
  const preview = workflow.generationDependencyPreview(project.id, ["S01"]);
  assert.equal(preview.lockedProductionPackage, true);
  assert.equal(preview.paidImageCount, 0);
  assert.deepEqual(preview.assets, []);
  assert.deepEqual(preview.storyboards, []);
  assert.deepEqual(await workflow.generateAllAssets(project.id, { track: false, promptPrepared: true }), []);
  assert.deepEqual(await workflow.generateAllStoryboards(project.id, { track: false, promptPrepared: true }), []);
  const after = store.getProject(project.id);
  assert.equal(after.jobs.filter(job => job.type === "image" || job.type === "character_video").length, 0);
});

test("zero-submit whole-project preflight keeps imported prompt and creates no video task", async t => {
  const { store, workflow, project } = importedHarness(t);
  await workflow.confirmAllPromptReview(project.id);
  const exactPrompt = project.shots[0].manualVideoPrompt;
  const result = await workflow.generateAllShotVideos(project.id, {
    track: false,
    promptPrepared: true,
    preflightOnly: true
  });
  assert.equal(result.preflightOnly, true);
  assert.equal(result.lockedProductionPackage, true);
  assert.equal(result.exactlyOnce, true);
  assert.equal(result.providerPlan.calls, 1);
  assert.equal(result.blocks[0].referenceCount, 3);
  assert.equal(result.blocks[0].importedReferenceOrderLocked, true);
  assert.equal(store.getProject(project.id).shots[0].manualVideoPrompt, exactPrompt);
  assert.deepEqual(result.paidVideoStateBefore, result.paidVideoStateAfter);
  assert.equal(store.getProject(project.id).jobs.filter(job => job.type === "shot_video").length, 0);
});

test("production-package batch preflight skips already materialized shot videos", async t => {
  const { store, workflow, project } = importedHarness(t);
  store.addCandidate(project.id, {
    entityType: "shot",
    entityId: "S01",
    stage: "shot_video",
    filePath: __filename,
    selected: true,
    stale: false,
    qualityAudit: { ok: true }
  });
  const current = store.getProject(project.id);
  current.shots[0].promptReviewReferencePlan.images = [];
  store.saveProject(current);
  const originalShotReferences = workflow.shotReferences.bind(workflow);
  await workflow.confirmAllPromptReview(project.id);
  workflow.shotReferences = (...args) => {
    if (args[1]?.id === "S01") throw new Error("materialized shot must not enter package dependency preflight");
    return originalShotReferences(...args);
  };
  const result = await workflow.generateAllShotVideos(project.id, {
    track: false,
    promptPrepared: true,
    preflightOnly: true
  });
  assert.equal(result.providerPlan.calls, 0);
  assert.deepEqual(result.blocks, []);
  assert.equal(store.getProject(project.id).jobs.filter(job => job.type === "shot_video").length, 0);
});

test("legacy imported projects migrate away from asset-direct and first-frame lineage", t => {
  const { store, project } = importedHarness(t);
  const filePath = store.projectPath(project.id);
  const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  legacy.generation.mode = "asset_direct";
  delete legacy.importedProductionPackage.workflowMode;
  legacy.shots[0].videoStrategy = "asset_direct";
  legacy.shots[0].videoFrameStages = ["storyboard_start"];
  fs.writeFileSync(filePath, JSON.stringify(legacy));
  const migrated = store.getProject(project.id);
  assert.equal(migrated.generation.mode, PRODUCTION_PACKAGE_MODE);
  assert.equal(migrated.importedProductionPackage.workflowMode, PRODUCTION_PACKAGE_MODE);
  assert.equal(migrated.shots[0].videoStrategy, PRODUCTION_PACKAGE_MODE);
  assert.deepEqual(migrated.shots[0].videoFrameStages, []);
  assert.equal(migrated.candidates.some(candidate => candidate.stage === "storyboard_start"), false);
});

test("package contract stays locked while an explicit user reroll can create one new task", async t => {
  const { store, workflow, project } = importedHarness(t);
  await workflow.confirmAllPromptReview(project.id);
  assert.throws(
    () => store.patchProject(project.id, { generation: { mode: "asset_direct" } }),
    error => error?.code === "PRODUCTION_PACKAGE_CONTRACT_LOCKED"
  );
  const withSubmission = store.getProject(project.id);
  withSubmission.jobs.push({
    id: "job-existing-paid-task",
    type: "shot_video",
    entityType: "shot",
    entityId: "S01",
    taskId: "provider-task-once",
    submissionAttemptCount: 1,
    status: "failed"
  });
  store.saveProject(withSubmission);
  await assert.rejects(
    () => workflow.generateShotVideo(project.id, "S01", PRODUCTION_PACKAGE_MODE, { track: false, promptPrepared: true }),
    error => error?.code === "PRODUCTION_PACKAGE_SHOT_ALREADY_SUBMITTED"
  );
  let submittedReferences = null;
  workflow.submitVideo = async (_projectId, _entityType, entityId, stage, _prompt, references) => {
    submittedReferences = references;
    return { id: "candidate-manual-reroll", entityType: "shot", entityId, stage, filePath: __filename };
  };
  const result = await workflow.generateShotVideo(project.id, "S01", PRODUCTION_PACKAGE_MODE, {
    track: false,
    promptPrepared: true,
    audit: false,
    rerollNonce: "manual-reroll-001"
  });
  assert.equal(result.id, "candidate-manual-reroll");
  assert.equal(submittedReferences.rerollNonce, "manual-reroll-001");
  assert.equal(submittedReferences.exactlyOnce, false);
});

test("a dialogue-ASR-retired package video cannot be silently reselected instead of rerolled", t => {
  const { store, project } = importedHarness(t);
  const retired = store.addCandidate(project.id, {
    entityType: "shot",
    entityId: "S01",
    stage: "shot_video",
    filePath: __filename,
    stale: true,
    staleCauseCode: "dialogue_asr_failure",
    staleReason: "ASR复核发现额外口头语，按用户要求仅重抽一次"
  });
  const persisted = store.getProject(project.id);
  const candidate = persisted.candidates.find(item => item.id === retired.id);
  candidate.selected = true;
  candidate.stale = true;
  candidate.staleCauseCode = "dialogue_asr_failure";
  store.saveProject(persisted);
  assert.equal(candidateReady(store.getProject(project.id), "shot", "S01", "shot_video", store.getSettings()), null);
});

test("single-shot package generation submits when the only historical file was retired by ASR", async t => {
  const { store, workflow, project } = importedHarness(t);
  await workflow.confirmAllPromptReview(project.id);
  const retired = store.addCandidate(project.id, {
    entityType: "shot",
    entityId: "S01",
    stage: "shot_video",
    filePath: __filename
  });
  const persisted = store.getProject(project.id);
  const candidate = persisted.candidates.find(item => item.id === retired.id);
  Object.assign(candidate, {
    selected: false,
    stale: true,
    staleCauseCode: "dialogue_asr_failure",
    staleReason: "ASR复核发现额外口头语，按用户要求仅重抽一次"
  });
  store.saveProject(persisted);
  let submitCount = 0;
  workflow.submitVideo = async (_projectId, _entityType, entityId, stage) => {
    submitCount += 1;
    return { id: "candidate-asr-replacement", entityType: "shot", entityId, stage, filePath: __filename };
  };
  const generated = await workflow.generateShotVideo(project.id, "S01", PRODUCTION_PACKAGE_MODE, {
    track: false,
    promptPrepared: true,
    audit: false
  });
  assert.equal(generated.id, "candidate-asr-replacement");
  assert.equal(submitCount, 1);
});

test("paused pre-submit package work resumes the same local job and stable provider key", async t => {
  const { root, store, workflow, project } = importedHarness(t);
  const calls = [];
  workflow.bridge = {
    submit: async (payload, options = {}) => {
      calls.push(payload.clientRequestId);
      if (calls.length === 1) {
        throw Object.assign(new Error("已暂停"), {
          code: "PIPELINE_PAUSED",
          noRemoteTaskCreated: true,
          remoteSubmissionUnknown: false
        });
      }
      await options.onPhase?.({ phase: "upstream_request_starting" });
      throw Object.assign(new Error("测试在第二次本地提交前停止"), { code: "TEST_STOP_AFTER_RECOVERY" });
    }
  };
  const shot = store.getProject(project.id).shots[0];
  const references = { ...workflow.shotReferences(store.getProject(project.id), shot, PRODUCTION_PACKAGE_MODE), exactlyOnce: true };
  await assert.rejects(
    () => workflow._submitVideoUnlocked(project.id, "shot", shot.id, "shot_video", shot.manualVideoPrompt, references, shot.duration),
    error => error?.code === "PIPELINE_PAUSED"
  );
  const afterPause = store.getProject(project.id);
  assert.equal(afterPause.jobs.filter(job => job.type === "shot_video").length, 1);
  assert.equal(afterPause.jobs[0].status, "paused");
  assert.equal(afterPause.jobs[0].upstreamSubmissionState, "not_created");
  assert.equal(afterPause.costLedger.entries.find(entry => entry.jobId === afterPause.jobs[0].id)?.status, "not_charged");

  await assert.rejects(
    () => workflow._submitVideoUnlocked(project.id, "shot", shot.id, "shot_video", shot.manualVideoPrompt, references, shot.duration),
    error => error?.code === "TEST_STOP_AFTER_RECOVERY"
  );
  const recovered = store.getProject(project.id);
  assert.equal(recovered.jobs.filter(job => job.type === "shot_video").length, 1, "recovery reuses the same local job");
  assert.equal(recovered.jobs[0].submissionPreparationAttemptCount, 2);
  assert.equal(recovered.jobs[0].submissionAttemptCount, 1);
  assert.equal(recovered.costLedger.entries.find(entry => entry.jobId === recovered.jobs[0].id)?.status, "pending");
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1], "provider recovery must reuse the exact same idempotency key");
  assert.equal(fs.existsSync(path.join(root, "requests", calls[0])), false, "staged request is cleaned after each attempt");
});

test("ordinary asset-direct projects retain their distinct no-storyboard strategy", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-asset-direct-distinct-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(path.join(root, "store"));
  const project = store.createProject("普通资产直投", { mode: "asset_direct", modeConfirmed: true });
  project.shots = [{ id: "S01", number: 1, sceneId: "SC01" }];
  const strategy = resolveShotVideoStrategy(project, project.shots[0]);
  assert.equal(strategy.strategy, "asset_direct");
  assert.notEqual(strategy.strategy, PRODUCTION_PACKAGE_MODE);
  assert.deepEqual(strategy.frameStages, []);
});

test("renderer reuses an unchanged imported product preview instead of aborting image decode", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.match(renderer, /const existingProductPreview = productButton\.querySelector\("\.preview-product"\)/);
  assert.match(renderer, /if \(image\.getAttribute\("src"\) !== productImageUrl\) image\.src = productImageUrl/);
  assert.match(renderer, /manualStoryboardEntry\.hidden = packageDirect/);
  assert.match(renderer, /videoStatusApi\.hasCreatedUpstreamTask\(job\)/);
  assert.match(renderer, /videoStatusApi\.canResumeStableSubmission\(job\)/);
  assert.match(renderer, /继续原任务 · 不会重抽/);
  assert.doesNotMatch(renderer, /已生成一次 · 不可重抽/);
  assert.match(renderer, /video\?\.filePath \|\| packageSubmissionConsumed\s*\? "再抽一次"/);
  assert.doesNotMatch(renderer, /packageSubmissionConsumed \|\| submitting \|\| drawing \? "disabled"/);
  assert.doesNotMatch(renderer, /querySelectorAll\("\.preview-product"\)\.forEach\(node => node\.remove\(\)\)/);
});

test("secure asset protocol serves verified Windows image paths without file-transport fallback", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-image-response-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, "深层目录", "商品参考图.png");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, PNG);
  const response = imageFileResponse(nested, "GET");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
});
