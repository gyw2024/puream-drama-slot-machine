"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION,
  criticalPropContinuityLedger,
  h3AssetDirectSemanticFingerprint,
  promptReviewSourceFingerprint,
  renderApprovedVideoPromptChinese,
  resolveHailuoApiModeForStrategy
} = require("../app/workbench-workflow");
const { MATRIX, matrixEntry } = require("../app/production-mode-matrix");
const { completeMasterActionCoverage } = require("../app/hailuo-h3-natural-prompt");

test("an authored provider timeline is never supplemented with the shot summary a second time", () => {
  const segments = [
    { start: 0, end: 4, action: "C01 and C02 enter together; C03 approaches and stops." },
    { start: 4, end: 8, action: "C01 retrieves P02 from her handbag and holds it toward C03." }
  ];
  const compiled = completeMasterActionCoverage({
    actionEn: "C01 and C02 enter together; C03 approaches; C01 retrieves P02 from her handbag and displays it.",
    providerTimedDirections: [
      { start: 0, end: 4, actionEn: segments[0].action },
      { start: 4, end: 8, actionEn: segments[1].action }
    ]
  }, segments, [], []);

  assert.deepEqual(compiled, segments);
  const timeline = compiled.map(item => item.action).join("; ");
  assert.equal((timeline.match(/enter together/g) || []).length, 1);
  assert.equal((timeline.match(/retrieves P02/g) || []).length, 1);
});

test("completed H3 semantic output never changes its own cache fingerprint", () => {
  const authored = {
    characters: [{ id: "C01", name: "顾云舟" }],
    product: { name: "九宝茶" },
    assetLibraries: {
      props: [
        { id: "P01", name: "婚戒", units: ["S01"] },
        { id: "P02", name: "审计文件", units: [] }
      ]
    },
    shots: [{
      id: "S01",
      number: 1,
      duration: 8,
      characterIds: ["C01"],
      visibleCharacterIds: ["C01"],
      action: "顾云舟摘下婚戒握在掌心。",
      stateBefore: "婚戒仍在左手。",
      stateAfter: "婚戒已握在掌心。",
      dialogueTurns: [],
      subshots: [{ start: 0, end: 8, action: "顾云舟摘下婚戒。" }]
    }]
  };
  const compiled = structuredClone(authored);
  compiled.shots[0] = {
    ...compiled.shots[0],
    actionEn: "C01 removes P01 and closes his hand.",
    stateBeforeEn: "P01 remains on C01's left hand.",
    stateAfterEn: "P01 is enclosed in C01's palm.",
    providerTimedDirections: [{
      start: 0,
      end: 8,
      actionEn: "C01 glances toward an audit file, then removes P01.",
      stateBeforeEn: "The audit file is visible behind C01.",
      stateAfterEn: "C01 closes his hand around P01."
    }],
    providerSemanticCompileSource: "ai-batch"
  };
  assert.equal(h3AssetDirectSemanticFingerprint(compiled), h3AssetDirectSemanticFingerprint(authored));
});

test("prompt approval fingerprint ignores equivalent dialogue metadata storage shapes", () => {
  const base = {
    productionRevision: "revision_prompt_shape",
    characters: [{ id: "C01", name: "林曼秋" }, { id: "C02", name: "哈桑" }],
    scenes: [{ id: "SC01", name: "玻璃长廊" }],
    assetLibraries: { props: [], wardrobes: [], voices: [] },
    product: { name: "九宝茶" },
    generation: { mode: "asset_direct" },
    script: { raw: "原稿", sourceDialogueLedger: [{ id: "D001", sourceShotId: "S01", speakerId: "C01", speaker: "林曼秋", tone: "低声", text: "邀请券带了吗？" }] },
    shots: [{
      id: "S01",
      number: 1,
      duration: 8,
      sceneId: "SC01",
      visibleCharacterIds: ["C01", "C02"],
      sourceDialogueIds: ["D001"],
      sourceDialogueBindings: [{ sourceDialogueId: "D001", listenerIds: ["C02"], subshotNumber: 1, intent: "低声", delivery: "确保整句说完", body: "看着哈桑" }],
      action: "林曼秋低声询问哈桑。",
      dialogueTurns: [{
        sourceDialogueId: "D001",
        speakerId: "C01",
        speaker: "林曼秋",
        listenerIds: ["C02"],
        text: "邀请券带了吗？",
        startSecond: 0,
        endSecond: 2,
        metadata: {
          sourceTone: "低声",
          intent: "低声",
          delivery: "低声；确保整句说完",
          body: "看着哈桑",
          listenerBeat: "哈桑闭口点头",
          deliveryEn: "quiet and testing",
          startSecond: 0,
          endSecond: 2
        }
      }],
      subshots: [{ start: 0, end: 8, sourceDialogueIds: ["D001"], dialogue: "林曼秋：邀请券带了吗？", dialogueTurns: [] }]
    }]
  };
  const normalized = structuredClone(base);
  normalized.shots[0].dialogueTurns[0] = {
    sourceDialogueId: "D001",
    sourceTone: "低声",
    speakerId: "C01",
    speaker: "林曼秋",
    listenerIds: ["C02"],
    text: "邀请券带了吗？",
    intent: "低声",
    delivery: "低声；确保整句说完",
    body: "看着哈桑",
    listenerBeat: "哈桑闭口点头",
    deliveryEn: "quiet and testing",
    startSecond: 0,
    endSecond: 2,
    metadata: { deliveryEn: "quiet and testing" }
  };
  assert.equal(promptReviewSourceFingerprint(normalized), promptReviewSourceFingerprint(base));
});

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-h3-asset-direct-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("H3资产直投三分钟测试", { engine: "hailuo-h3", mode: "asset_direct" });
  const project = store.getProject(created.id);
  project.productionRevision = "revision_h3_asset_direct";
  project.generation = {
    ...project.generation,
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "asset_direct",
    modeConfirmed: true,
    aspectRatio: "9:16",
    targetDurationSeconds: 180
  };
  project.characters = [
    { id: "C01", name: "林岚", description: "四十五岁母亲，短发，深蓝针织衫", voiceDescription: "中低音，克制但有力量", signatureLine: "这份尊严，我自己拿回来。", promptOverrides: {} },
    { id: "C02", name: "周强", description: "四十八岁男人，灰色夹克，神情强硬", voiceDescription: "偏低粗粝，急促强硬", signatureLine: "你别在这里装清高。", promptOverrides: {} }
  ];
  project.scenes = [{ id: "SC01", name: "老旧客厅", description: "傍晚，旧沙发与木茶几，门在画面右侧，宾客虚化", promptOverrides: {} }];
  project.assetLibraries = {
    props: [{ id: "P01", name: "牛皮纸档案袋", description: "边角磨损，封口完整", coreStory: true, promptOverrides: {} }],
    wardrobes: [],
    voices: []
  };
  project.product = { name: "暖心阅读灯", sellingPoints: "柔和照明，触控调光", imagePath: "", publicUrl: "" };
  project.script = { raw: "完整三分钟剧本测试原稿", sourceFingerprint: "script-fixture" };
  project.shots = [{
    id: "S01",
    number: 1,
    duration: 12,
    sceneId: "SC01",
    sceneName: "老旧客厅",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    videoReferenceCharacterIds: ["C01", "C02"],
    action: "林岚把档案袋按在茶几上，周强伸手去抢，林岚按住不退。",
    stateBefore: "档案袋在林岚手中，周强站在茶几对面。",
    stateAfter: "档案袋被压在茶几上，周强的手停在半空。",
    visualReserveSeconds: 2.2,
    durationRationale: "两句攻防后保留抢夺动作、听者反应和档案袋特写。",
    productMention: true,
    videoReferenceIncludeProduct: true,
    propBindings: [{ propId: "P01", holderBeforeCharacterId: "C01", holderAfterCharacterId: "", holderCharacterId: "C01", hand: "right", locationBefore: "C01 right hand", locationAfter: "coffee table", stateBefore: "sealed", stateAfter: "pressed_on_table", transferAction: "C01 presses P01 from her right hand onto the coffee table" }],
    dialogueTurns: [
      {
        sourceDialogueId: "D001",
        speakerId: "C01",
        speaker: "林岚",
        listenerIds: ["C02"],
        text: "这份证据，你今天必须看清楚！",
        delivery: "压住怒火起句，重咬必须，尾音抬高",
        emotionPeak: "克制被逼到决绝",
        volume: "由低到高",
        pace: "先慢后紧",
        stressWord: "必须",
        breath: "起句前短吸气",
        body: "右手按住档案袋，肩背前压",
        listenerBeat: "周强闭口，伸出的手顿住",
        plannedSpeechSeconds: 3.1,
        plannedAfterBeatSeconds: 0.5,
        onScreen: true
      },
      {
        sourceDialogueId: "D002",
        speakerId: "C02",
        speaker: "周强",
        listenerIds: ["C01"],
        text: "你以为一张纸就能翻案？",
        delivery: "虚张声势地顶回去，翻案二字压重",
        emotionPeak: "强硬里露出慌乱",
        volume: "偏高后骤降",
        pace: "急促",
        stressWord: "翻案",
        breath: "句中一次短促换气",
        body: "手指停在半空，下颌绷紧",
        listenerBeat: "林岚闭口直视，不松开档案袋",
        plannedSpeechSeconds: 2.8,
        plannedAfterBeatSeconds: 0.6,
        onScreen: true
      }
    ],
    subshots: [
      { start: 0, end: 4.5, framing: "林岚中近景", camera: "稳定前推到说话人", action: "林岚按下档案袋" },
      { start: 4.5, end: 8.0, framing: "周强中近景", camera: "按说话人硬切反打", action: "周强伸手后停住" },
      { start: 8.0, end: 12, framing: "档案袋与两人反应近景", camera: "下摇到证据再回到林岚", action: "动作落到双方僵持的清晰结果" }
    ],
    promptOverrides: {}
  }];
  store.saveProject(project);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  return { root, store, workflow, projectId: created.id };
}

test("asset-direct is an H3-only no-storyboard production contract", () => {
  assert.equal(matrixEntry("cloud", "asset_direct"), MATRIX["cloud:asset_direct"]);
  assert.equal(matrixEntry("legacy", "asset_direct").providerFamily, "cloud");
  assert.equal(resolveHailuoApiModeForStrategy("asset_direct", "auto", true), "multimodal_to_video");
  assert.equal(resolveHailuoApiModeForStrategy("asset_direct", "auto", false), "reference_to_video");
  assert.deepEqual(Object.keys(MATRIX).every(key => key.startsWith("cloud:")), true);
});

test("asset-direct reuses a current selected four-view identity instead of buying a portrait", t => {
  const { root, store, workflow, projectId } = createFixture(t);
  const filePath = path.join(root, "reusable-current-four-view.png");
  fs.writeFileSync(filePath, "current reusable identity");
  const candidate = store.addCandidate(projectId, {
    entityType: "character",
    entityId: "C01",
    stage: "character_sheet",
    filePath,
    selected: false,
    qualityAudit: { ok: true }
  });
  store.confirmCandidate(projectId, candidate.id, false);
  const plan = workflow.buildAssetBatchPlan(projectId);
  assert.equal(plan.find(item => item.key === "character_intro:C01")?.status, "skipped");
});

test("asset-direct never revives a visually rejected stale library identity", t => {
  const { root, store, workflow, projectId } = createFixture(t);
  const filePath = path.join(root, "rejected-library-identity.png");
  fs.writeFileSync(filePath, "wrong age and role styling");
  const candidate = store.addCandidate(projectId, {
    entityType: "character",
    entityId: "C01",
    stage: "character_sheet",
    filePath,
    selected: false,
    qualityAudit: { ok: true }
  });
  store.confirmCandidate(projectId, candidate.id, false);
  store.updateCandidate(projectId, candidate.id, {
    selected: false,
    stale: true,
    staleReason: "真实视觉复核不适配本剧"
  });
  const plan = workflow.buildAssetBatchPlan(projectId);
  assert.equal(plan.find(item => item.key === "character_intro:C01")?.status, "queued");
});

test("asset-direct image-only review contains identity, scene, object and H3 video prompts but no audio, storyboard or character-video task", async t => {
  const { store, workflow, projectId } = createFixture(t);
  // The fixture project is already authored (shots/dialogue are defined
  // explicitly), so prompt-review bundle compilation must not re-run the
  // auth-gated screenplay separation. Skip it for this offline unit test.
  workflow.analyzeScript = async () => workflow.store.getProject(projectId);
  const plan = workflow.buildAssetBatchPlan(projectId);
  const kinds = plan.map(item => item.kind);
  assert.ok(kinds.includes("character_intro"));
  assert.ok(!kinds.includes("character_voice"));
  assert.ok(kinds.includes("scene_asset"));
  assert.ok(kinds.includes("prop_asset"));
  assert.ok(!kinds.includes("character_sheet"));
  assert.ok(!kinds.includes("character_video"));

  const prepared = await workflow.preparePromptReviewBundle(projectId, { compileProviderSemantics: false });
  assert.equal(prepared.promptReview.version, PROMPT_REVIEW_BUNDLE_VERSION);
  assert.equal(prepared.promptReview.status, "ready");
  assert.equal(prepared.promptReview.productionRevision, prepared.productionRevision);
  const stableRevision = prepared.productionRevision;
  const stablePromptIds = prepared.promptReview.items.map(item => item.id);
  workflow.reconcileProjectCharacterReferences(projectId);
  workflow.ensureProjectShotScenes(projectId);
  workflow.syncReferenceLibraries(projectId);
  workflow.restoreUnchangedScriptAssets(projectId);
  workflow.reconcileProductionContracts(projectId, { markScriptFailed: false });
  const stabilizedAgain = store.getProject(projectId);
  assert.equal(stabilizedAgain.productionRevision, stableRevision, "post-approval dependency preparation must be idempotent");
  assert.equal(workflow.promptReviewIsCurrent(stabilizedAgain), true);
  assert.deepEqual(stabilizedAgain.promptReview.items.map(item => item.id), stablePromptIds);
  assert.equal(stabilizedAgain.shots.every(shot => stabilizedAgain.scenes.some(scene => scene.id === shot.sceneId)), true);
  const stages = prepared.promptReview.items.map(item => item.stage);
  assert.ok(stages.includes("character_intro"));
  assert.ok(!stages.includes("character_voice"));
  assert.ok(stages.includes("scene_asset"));
  assert.ok(stages.includes("prop_asset"));
  assert.ok(stages.includes("shot_video"));
  assert.ok(!stages.includes("character_video"));
  assert.ok(!stages.some(stage => /^storyboard_/.test(stage)));
  assert.equal(prepared.promptReview.counts.storyboards, 0);

  const propItem = prepared.promptReview.items.find(item => item.stage === "prop_asset");
  assert.match(propItem.prompt, /写实影视道具资产图/);
  assert.match(propItem.prompt, /牛皮纸档案袋/);
  assert.doesNotMatch(propItem.prompt, /单张分镜关键帧/);
  const sceneItem = prepared.promptReview.items.find(item => item.stage === "scene_asset");
  assert.match(sceneItem.prompt, /宾客虚化/,'uncompiled preview preserves supplied meaning; only the design Agent may extract an empty set');
  assert.match(sceneItem.prompt, /无人空镜|严禁出现任何真人/);

  const videoItem = prepared.promptReview.items.find(item => item.stage === "shot_video");
  assert.ok(videoItem);
  for (const line of ["这份证据，你今天必须看清楚！", "你以为一张纸就能翻案？"]) {
    assert.equal((videoItem.displayPrompt.match(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
    assert.equal((videoItem.prompt.match(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  }
  assert.match(videoItem.displayPrompt, /^\u3010/);
  assert.doesNotMatch(videoItem.displayPrompt, /精确剧情首帧|精确剧情尾帧|有序剧情分镜合图/);
  assert.match(videoItem.displayPrompt, /压住怒火起句，重咬必须，尾音抬高/);
  assert.match(videoItem.displayPrompt, /画面左侧/);
  assert.match(videoItem.displayPrompt, /180度视线轴/);
  assert.match(videoItem.displayPrompt, /右手按住档案袋，肩背前压/);
  assert.match(videoItem.displayPrompt, /闭口/);
  assert.match(videoItem.displayPrompt, /\d{2}:\d{2}\.\d{3}|\d+(?:\.\d+)?\s*秒/, "Chinese review exposes executable timing rather than the old slow authored windows");
  assert.doesNotMatch(videoItem.prompt, /<Audio\s+\d+>/, "image-only actual submission may not retain phantom voice references from stale IR");
  assert.match(videoItem.displayPrompt, /镜头1|镜头 1/);
  const executionVideoPrompt = videoItem.prompt;
  assert.match(executionVideoPrompt, /<Subject\s+\d+>/);
  assert.match(executionVideoPrompt, /moves the lips for this line/);
  assert.match(executionVideoPrompt, /direct hard cut|cut to <Subject \d+>'s established visible speaking face without changing that person's identity|cut only to the next authored on-screen speaker's established face; identity never changes inside a face/);
  assert.doesNotMatch(executionVideoPrompt, /<Audio\s+\d+>/);
  assert.doesNotMatch(executionVideoPrompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);

  let paidImageCalls = 0;
  workflow._generateImageCandidateUnlocked = async () => {
    paidImageCalls += 1;
    return { id: "should-only-run-after-approval" };
  };
  await assert.rejects(
    () => workflow.generateImageCandidate(projectId, "character_intro", "C01", "", { promptPrepared: true }),
    error => error?.code === "PROMPT_REVIEW_REQUIRED"
  );
  assert.equal(paidImageCalls, 0);
  const approved = await workflow.confirmAllPromptReview(projectId);
  assert.equal(approved.promptReview.status, "approved");
  await workflow.generateImageCandidate(projectId, "character_intro", "C01", "", { promptPrepared: true });
  assert.equal(paidImageCalls, 1);
  assert.equal(store.getProject(projectId).promptReview.status, "approved");
});

test("asset-direct initial identity and scene anchors need no impossible predecessor, while rerolls preserve the selected anchor", async t => {
  const { store, workflow, projectId } = createFixture(t);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  settings.imageProvider = {
    ...settings.imageProvider,
    kind: "fixture-image-provider",
    model: "fixture-image-model"
  };
  store.saveSettings(settings);

  await workflow.preparePromptReviewBundle(projectId, { compileProviderSemantics: false });
  await workflow.confirmAllPromptReview(projectId);

  const calls = [];
  workflow.executeAdaptiveCapability = async (capability, _providerKind, payload, context) => {
    assert.equal(capability, "image");
    const references = payload?.options?.referenceInputs || [];
    calls.push({ stage: context?.stage, entityId: context?.entityId, references });
    fs.mkdirSync(path.dirname(payload.targetPath), { recursive: true });
    fs.writeFileSync(payload.targetPath, `fixture-${calls.length}`);
    return { remoteUrl: "", raw: { referenceCount: references.length } };
  };

  const firstIdentity = await workflow.generateImageCandidate(projectId, "character_intro", "C01", "", { promptPrepared: true });
  assert.equal(calls.at(-1).references.length, 0, "the first identity portrait is the anchor and cannot require itself");
  const secondIdentity = await workflow.generateImageCandidate(projectId, "character_intro", "C01", "", { promptPrepared: true });
  assert.equal(calls.at(-1).references.length, 1, "a reroll must preserve the already selected identity");
  assert.equal(calls.at(-1).references[0].candidateId, firstIdentity.id);
  assert.notEqual(secondIdentity.id, firstIdentity.id);

  const firstScene = await workflow.generateImageCandidate(projectId, "scene_asset", "SC01", "", { promptPrepared: true });
  assert.equal(calls.at(-1).references.length, 0, "the first scene board establishes its own spatial anchor");
  await workflow.generateImageCandidate(projectId, "scene_asset", "SC01", "", { promptPrepared: true });
  assert.equal(calls.at(-1).references.length, 1, "a scene reroll must preserve the selected set topology");
  assert.equal(calls.at(-1).references[0].candidateId, firstScene.id);

  const latest = store.getProject(projectId);
  latest.generation.mode = "keyframe";
  store.saveProject(latest);
  const beforeRejectedCall = calls.length;
  await assert.rejects(
    () => workflow._generateImageCandidateUnlocked(projectId, "character_intro", "C02", "", { promptPrepared: true }),
    error => error?.code === "CONTINUITY_REFERENCE_REQUIRED"
  );
  assert.equal(calls.length, beforeRejectedCall, "non-asset-direct identity derivation still stops before a reference-free provider call");
});

test("an approved prompt boundary cannot be silently rewritten by video dependency preflight", async t => {
  const { store, workflow, projectId } = createFixture(t);
  await workflow.preparePromptReviewBundle(projectId, { compileProviderSemantics: false });
  await workflow.confirmAllPromptReview(projectId);
  const project = store.getProject(projectId);
  project.script.sourceFingerprint = "intentionally-stale-test-fingerprint";
  store.saveProject(project);
  assert.equal(workflow.promptReviewIsCurrent(store.getProject(projectId), "approved"), true);

  let analysisCalls = 0;
  let assetScope = null;
  workflow.analyzeScript = async () => { analysisCalls += 1; throw new Error("approved prompt must not be reanalysed"); };
  workflow.generateAllAssets = async (_projectId, options) => { assetScope = options; return []; };
  workflow.generateAllStoryboards = async () => [];
  await workflow.ensureStageDependencies(projectId, "videos", { shotIds: ["S01"] });
  assert.equal(analysisCalls, 0);
  assert.deepEqual(assetScope?.requiredCharacterIds?.sort(), ["C01", "C02"]);
  assert.ok(assetScope?.assetKeys?.every(key => !key.includes("SC99")));
  assert.equal(workflow.promptReviewIsCurrent(store.getProject(projectId), "approved"), true);
});

test("asset-direct compiles one bounded semantic batch once and reuses it before review", async t => {
  const { store, workflow, projectId } = createFixture(t);
  const legacySettings=store.getSettings();legacySettings.generation.agentDecisionAuthority=false;store.saveSettings(legacySettings); // Explicit legacy transport coverage.
  let calls = 0;
  workflow.generateText = async (_config, messages, options) => {
    calls += 1;
    assert.match(String(options?.sessionId || ""), /^h3-asset-direct-semantics-/);
    assert.match(messages[0].content, /never let a prop teleport/i);
    const semanticSource = JSON.parse(messages[1].content);
    assert.match(semanticSource.contractVersion, /source-opening-state-v6/);
    assert.equal(semanticSource.shots[0].dialogue[0].text, '这份证据，你今天必须看清楚！');
    assert.ok(semanticSource.shots[0].dialogue[0].calculatedSpeechWindow.minSeconds>0);
    assert.equal(semanticSource.propContinuityLedger[0].appearances[0].holderBeforeCharacterId, "C01");
    assert.equal(semanticSource.propContinuityLedger[0].appearances[0].holderAfterCharacterId, "");
    assert.equal(semanticSource.propContinuityLedger[0].appearances[0].locationAfter, "coffee table");
    assert.equal(semanticSource.shots[0].propBindings[0].transferAction, "C01 presses P01 from her right hand onto the coffee table");
    const response = {
      items: [{
        shotId: "S01",
        actionEn: "C01 presses P01 onto the table; C02 reaches for P01; C01 pins P01 down without retreating.",
        stateBeforeEn: "C01 holds P01 while C02 stands across the table.",
        stateAfterEn: "P01 is pinned to the table and C02's reaching hand stops in midair.",
        segments: [
          { index: 0, actionZh: "林岚用右手把档案袋按到桌面。", framingZh: "林岚中近景。", cameraZh: "稳定缓慢前推林岚。", stateBeforeZh: "林岚手持档案袋。", stateAfterZh: "档案袋落到桌面。", actionEn: "C01 plants P01 on the table with her right hand.", framingEn: "Medium close-up on C01.", cameraEn: "Stable restrained push-in on C01.", stateBeforeEn: "C01 holds P01.", stateAfterEn: "P01 reaches the tabletop.", soundEn: "Continuous room tone and a synchronized paper impact." },
          { index: 1, actionZh: "周强伸手去拿档案袋，在碰到前停住。", framingZh: "周强中近景。", cameraZh: "说话人切换时硬切周强。", stateBeforeZh: "周强开始伸手。", stateAfterZh: "周强的手停在半空。", actionEn: "C02 reaches for P01 and freezes before touching it.", framingEn: "Medium close-up on C02.", cameraEn: "HARD CUT to C02 at the speaker change.", stateBeforeEn: "C02's hand begins to extend.", stateAfterEn: "C02's hand stops in midair.", soundEn: "Continuous room tone and sleeve movement." },
          { index: 2, actionZh: "林岚继续按住档案袋，两人落到紧张僵持状态。", framingZh: "证据与反应近景。", cameraZh: "下摇档案袋后落回林岚。", stateBeforeZh: "两人保持紧张。", stateAfterZh: "档案袋被按住，周强的手仍停在半空。", actionEn: "C01 keeps P01 pinned while both bodies settle into a tense standoff.", framingEn: "Evidence and reaction close-up.", cameraEn: "Tilt to P01, then settle on C01.", stateBeforeEn: "Both characters remain tense.", stateAfterEn: "P01 stays pinned and C02's hand remains suspended.", soundEn: "Continuous room tone and quiet breathing." }
        ],
        dialogue: [
          { sourceDialogueId: "D001", startSecond: 0, endSecond: 3.1, deliveryEn: "Begin with restrained anger, rise in volume, stress must, and finish on one controlled breath.", expressionEn: "C01's brows draw down, eyes lock on C02, and jaw sets decisively.", bodyEn: "C01 presses P01 with her right hand and leans her shoulders forward." },
          { sourceDialogueId: "D002", startSecond: 6.0, endSecond: 8.8, deliveryEn: "Answer with false bravado, stress overturn the case, then let the volume drop abruptly.", expressionEn: "C02's hard stare flickers with panic and his lower jaw tightens.", bodyEn: "C02's reaching fingers stop in midair while his chin locks." }
        ]
      }]
    };
    for (const segment of response.items[0].segments) {
      Object.assign(segment, {
        blockingZh: "\u89d2\u8272\u5206\u7ad9\u753b\u9762\u5de6\u53f3\u4e24\u4fa7\uff0c\u76ee\u5149\u6cbf\u540c\u4e00\u8f74\u7ebf\u76f8\u5bf9\u3002",
        soundZh: "\u8fde\u7eed\u5ba4\u5185\u73af\u5883\u58f0\u548c\u5f53\u524d\u52a8\u4f5c\u7684\u540c\u6b65\u58f0\u97f3\u3002",
        blockingEn: "C01 and C02 hold opposite screen sides, face each other, and preserve one 180-degree eyeline axis."
      });
    }
    for (const turn of response.items[0].dialogue) {
      const sourceTurn=semanticSource.shots[0].dialogue.find(t=>t.sourceDialogueId===turn.sourceDialogueId);
      const i=response.items[0].dialogue.indexOf(turn),ds=semanticSource.shots[0].dialogue,gap=(12-ds.reduce((n,d)=>n+d.calculatedSpeechWindow.targetSeconds,0))/(ds.length+1);turn.startSecond=gap*(i+1)+ds.slice(0,i).reduce((n,d)=>n+d.calculatedSpeechWindow.targetSeconds,0);turn.endSecond=turn.startSecond+sourceTurn.calculatedSpeechWindow.targetSeconds;
      Object.assign(turn, {
        deliveryZh: "\u514b\u5236\u4f46\u6709\u660e\u786e\u538b\u529b\u7684\u8bf4\u8bdd\u610f\u56fe\u3002",
        vocalArcZh: "\u5f00\u5934\u538b\u4f4e\u97f3\u91cf\uff0c\u5173\u952e\u8bcd\u62ac\u9ad8\u97f3\u8c03\u5e76\u52a0\u91cd\uff0c\u7ed3\u5c3e\u653e\u6162\u5e76\u7528\u4e00\u53e3\u53d7\u63a7\u547c\u5438\u6536\u4f4f\u3002",
        vocalArcEn: "Open at restrained volume and low pitch, rise and stress the pressure word, then slow down and close on one controlled breath.",
        expressionZh: "\u773c\u795e\u9501\u5b9a\u5bf9\u65b9\uff0c\u7709\u5fc3\u6536\u7d27\uff0c\u4e0b\u988c\u5728\u7ed3\u5c3e\u5b9a\u4f4f\u3002",
        expressionArcEn: "Eyes lock first, brows tighten through the stressed word, and the jaw sets at the ending breath.",
        bodyZh: "\u53f3\u624b\u6267\u884c\u9053\u5177\u52a8\u4f5c\uff0c\u80a9\u7ebf\u5411\u5bf9\u65b9\u5fae\u538b\u3002",
        blockingZh: "\u8bf4\u8bdd\u4eba\u7ad9\u753b\u9762\u5de6\u4fa7\uff0c\u542c\u8005\u5728\u53f3\u4fa7\u3002",
        blockingEn: "The speaker holds screen left and the listener holds screen right on the established axis.",
        speakerFacingZh: "\u8138\u90e8\u3001\u80f8\u53e3\u4e0e\u89c6\u7ebf\u90fd\u671d\u5411\u5bf9\u65b9\u3002",
        speakerFacingEn: "Face, torso and eyeline stay directed toward the listener across the established axis.",
        listenerReactionZh: "\u542c\u8005\u95ed\u53e3\uff0c\u773c\u795e\u4e0e\u624b\u90e8\u505a\u51fa\u9488\u5bf9\u5f53\u53e5\u7684\u65e0\u58f0\u53cd\u5e94\u3002",
        listenerReactionEn: "The listener keeps lips still and gives a line-specific silent eye and hand reaction."
      });
    }
    return response;
  };
  const compiled = await workflow.compileH3AssetDirectSemanticsBatch(projectId, store.getSettings());
  assert.equal(calls, 1);
  assert.equal(compiled.h3AssetDirectSemanticCompile.status, "completed");
  assert.equal(compiled.shots[0].dialogueTurns.every(turn => turn.deliveryEn && turn.expressionEn && turn.bodyEn), true);
  assert.match(compiled.shots[0].dialogueTurns[0].expressionZh || "", /眼神锁定对方，眉心收紧，下颌在结尾定住/);
  for(const [index,turn] of compiled.shots[0].dialogueTurns.entries()){
    assert.equal(require('../app/shot-performance-contract').silenceFailures(compiled.shots[0].dialogueTurns,12).length,0);
    const bounds=require('../app/drama-timing').speechWindowBounds(turn.text,turn);
    assert.ok(turn.endSecond-turn.startSecond>=bounds.minSeconds-0.02&&turn.endSecond-turn.startSecond<=bounds.maxSeconds+0.02);
  }
  const reused = await workflow.compileH3AssetDirectSemanticsBatch(projectId, store.getSettings());
  assert.equal(calls, 1, "same semantic fingerprint must reuse the compiled batch without another paid call");
  assert.match(reused.shots[0].dialogueTurns[0].expressionZh || "", /眼神锁定对方，眉心收紧，下颌在结尾定住/);
  assert.equal(reused.shots[0].providerTimedDirections.length, 3);
  const prepared = await workflow.preparePromptReviewBundle(projectId, { compileProviderSemantics: false });
  const preparedVideo = prepared.promptReview.items.find(item => item.stage === "shot_video");
  const executionPrompt = preparedVideo?.prompt || "";
  const prompt = preparedVideo?.displayPrompt || "";
  assert.match(prompt, /林岚用右手把档案袋按到桌面/);
  assert.match(prompt, /眼神锁定对方，眉心收紧，下颌在结尾定住/);
  assert.match(prompt, /C01/);
  assert.match(executionPrompt, /<Subject 1> presses <Subject 4> with her right hand/);
  assert.match(executionPrompt, /Eyes lock first, brows tighten/);
  assert.match(executionPrompt, /<Subject 1>/);
  assert.doesNotMatch(executionPrompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
  assert.doesNotMatch(executionPrompt, /advance the authored causal action|face\/body follow|emotionally specific Chinese delivery/i);
  assert.equal((preparedVideo?.displayPrompt.match(/林岚用右手把档案袋按到桌面/g) || []).length, 1);
  assert.equal((preparedVideo?.displayPrompt.match(/周强伸手去拿档案袋，在碰到前停住/g) || []).length, 1);
  assert.equal((preparedVideo?.displayPrompt.match(/林岚继续按住档案袋，两人落到紧张僵持状态/g) || []).length, 1);
});

function completeSemanticResponse(source) {
  return {
    items: (source.shots || []).map(shot => ({
      shotId: shot.shotId,
      actionEn: `${shot.shotId} preserves the authored causal action with explicit actor and receiver IDs.`,
      stateBeforeEn: `${shot.shotId} begins from the supplied physical before-state.`,
      stateAfterEn: `${shot.shotId} ends at the supplied visible after-state.`,
      segments: (shot.subshots || []).map((segment, index) => ({
        index,
        startSecond: Number(segment.start) || 0,
        endSecond: Number(segment.end) || Number(shot.duration) || 12,
        actionZh: "\u6309\u539f\u5267\u672c\u6267\u884c\u5f53\u524d\u52a8\u4f5c\uff0c\u660e\u786e\u52a8\u4f5c\u53d1\u8d77\u4eba\u4e0e\u627f\u53d7\u4eba\u3002",
        framingZh: "\u4e2d\u8fd1\u666f\u4e0e\u5fc5\u8981\u7684\u53cd\u5e94\u5207\u955c\u3002",
        cameraZh: "\u6cbf\u65e2\u5b9a\u8f74\u7ebf\u5207\u6362\u5e76\u56de\u5230\u8bf4\u8bdd\u4eba\u3002",
        blockingZh: "\u4e3b\u89d2\u5206\u7ad9\u753b\u9762\u5de6\u53f3\u4e24\u4fa7\uff0c\u9762\u671d\u5bf9\u65b9\u3002",
        backgroundActionZh: "\u542c\u8005\u95ed\u53e3\u5e76\u505a\u51fa\u5bf9\u5e94\u7684\u65e0\u58f0\u53cd\u5e94\u3002",
        stateBeforeZh: "\u4fdd\u7559\u5f53\u524d\u6bb5\u843d\u524d\u7684\u7269\u7406\u72b6\u6001\u3002",
        stateAfterZh: "\u5b8c\u6210\u5f53\u524d\u6bb5\u843d\u7684\u53ef\u89c1\u7ed3\u679c\u3002",
        soundZh: "\u8fde\u7eed\u73af\u5883\u58f0\u4e0e\u5f53\u524d\u52a8\u4f5c\u7684\u540c\u6b65\u97f3\u6548\u3002",
        actionEn: `${shot.shotId} executes timed authored action ${index + 1} with explicit actor and receiver IDs.`,
        framingEn: "A motivated medium close-up with a reaction insert.",
        cameraEn: "Cut on the established axis and return to the active speaker.",
        blockingEn: "C01 holds screen left and C02 screen right, facing each other across one 180-degree axis.",
        backgroundActionEn: "The listener keeps lips still and gives the authored silent reaction.",
        stateBeforeEn: "Preserve the supplied segment before-state.",
        stateAfterEn: "Reach the supplied visible segment after-state.",
        soundEn: "Continuous room tone and the synchronized sound caused by the visible action."
      })),
      dialogue: (shot.dialogue || []).map((turn, index) => ({
        sourceDialogueId: turn.sourceDialogueId,
        startSecond: (12-shot.dialogue.reduce((n,d)=>n+d.calculatedSpeechWindow.targetSeconds,0))/(shot.dialogue.length+1)*(index+1)+shot.dialogue.slice(0,index).reduce((n,d)=>n+d.calculatedSpeechWindow.targetSeconds,0),
        endSecond: (12-shot.dialogue.reduce((n,d)=>n+d.calculatedSpeechWindow.targetSeconds,0))/(shot.dialogue.length+1)*(index+1)+shot.dialogue.slice(0,index).reduce((n,d)=>n+d.calculatedSpeechWindow.targetSeconds,0)+turn.calculatedSpeechWindow.targetSeconds,
        deliveryZh: "\u514b\u5236\u8d77\u53e5\uff0c\u5728\u538b\u529b\u8bcd\u63d0\u9ad8\u5f3a\u5ea6\uff0c\u7ed3\u5c3e\u6536\u4f4f\u3002",
        deliveryEn: "Open with restraint, intensify on the pressure word, and contain the ending.",
        vocalArcZh: "\u4f4e\u97f3\u91cf\u4f4e\u97f3\u8c03\u8d77\u53e5\uff0c\u5173\u952e\u8bcd\u62ac\u9ad8\u5e76\u52a0\u91cd\uff0c\u653e\u6162\u540e\u4e00\u53e3\u6c14\u6536\u5c3e\u3002",
        vocalArcEn: "Start low and restrained, raise pitch and stress on the key word, then slow and close on one controlled breath.",
        expressionZh: "\u773c\u795e\u9501\u5b9a\uff0c\u7709\u5fc3\u9010\u6b65\u6536\u7d27\uff0c\u7ed3\u5c3e\u4e0b\u988c\u5b9a\u4f4f\u3002",
        expressionEn: "The eyes lock, brows tighten, and the jaw settles at the ending beat.",
        expressionArcEn: "Eyes lock at the opening, brows tighten through the key word, and the jaw sets on the final breath.",
        bodyZh: "\u80a9\u7ebf\u671d\u5411\u542c\u8005\uff0c\u53cc\u624b\u6267\u884c\u539f\u5267\u672c\u52a8\u4f5c\u3002",
        bodyEn: "The speaker angles both shoulders toward the listener and executes the authored hand action.",
        blockingZh: "\u8bf4\u8bdd\u4eba\u5728\u753b\u9762\u5de6\u4fa7\uff0c\u542c\u8005\u5728\u53f3\u4fa7\u3002",
        blockingEn: "The speaker holds screen left while the listener holds screen right.",
        speakerFacingZh: "\u8138\u3001\u80f8\u53e3\u548c\u89c6\u7ebf\u90fd\u671d\u5411\u542c\u8005\u3002",
        speakerFacingEn: "Face, torso and eyeline all remain directed toward the listener.",
        listenerReactionZh: "\u542c\u8005\u95ed\u53e3\uff0c\u7528\u773c\u795e\u4e0e\u624b\u90e8\u505a\u51fa\u9488\u5bf9\u8be5\u53e5\u7684\u65e0\u58f0\u53cd\u5e94\u3002",
        listenerReactionEn: "The listener keeps lips still and gives a line-specific silent eye and hand reaction."
      }))
    }))
  };
}

test("a fourteen-shot semantic compile resumes after the failed batch without paying to repeat completed batches", async t => {
  const { root, store, workflow, projectId } = createFixture(t);
  const legacySettings=store.getSettings();legacySettings.generation.agentDecisionAuthority=false;store.saveSettings(legacySettings); // Explicit legacy transport coverage.
  const project = store.getProject(projectId);
  const template = project.shots[0];
  project.shots = Array.from({ length: 14 }, (_, index) => {
    const shot = JSON.parse(JSON.stringify(template));
    shot.id = `S${String(index + 1).padStart(2, "0")}`;
    shot.number = index + 1;
    shot.dialogueTurns = shot.dialogueTurns.map((turn, turnIndex) => ({
      ...turn,
      sourceDialogueId: `D${String(index * 2 + turnIndex + 1).padStart(3, "0")}`
    }));
    return shot;
  });
  store.saveProject(project);
  const firstCalls = [];
  workflow.generateText = async (_config, messages) => {
    const source = JSON.parse(messages.at(-1).content);
    firstCalls.push(source.batchRequest.batchNumber);
    if (source.batchRequest.batchNumber === 2) throw Object.assign(new Error("simulated provider interruption"), { code: "PROVIDER_STREAM_INTERRUPTED" });
    return completeSemanticResponse(source);
  };
  await assert.rejects(() => workflow.compileH3AssetDirectSemanticsBatch(projectId, store.getSettings()), /simulated provider interruption/);
  const interrupted = store.getProject(projectId);
  assert.deepEqual(firstCalls.slice().sort(), [1, 2, 3]);
  assert.equal(interrupted.shots.slice(0, 5).every(shot => shot.providerSemanticCompileSource === "ai-batch"), true);
  assert.equal(interrupted.shots.slice(5,10).some(shot => shot.providerSemanticCompileSource === "ai-batch"), false);
  assert.equal(interrupted.shots.slice(10).every(shot => shot.providerSemanticCompileSource === "ai-batch"), true);

  const resumedWorkflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  const resumedCalls = [];
  resumedWorkflow.generateText = async (_config, messages) => {
    const source = JSON.parse(messages.at(-1).content);
    resumedCalls.push(source.batchRequest.batchNumber);
    return completeSemanticResponse(source);
  };
  const completed = await resumedWorkflow.compileH3AssetDirectSemanticsBatch(projectId, store.getSettings());
  assert.deepEqual(resumedCalls, [2], "both concurrently completed batches must be reused without another paid request");
  assert.equal(completed.h3AssetDirectSemanticCompile.status, "completed");
  assert.equal(completed.h3AssetDirectSemanticCompile.totalBatches, 3);
  assert.equal(completed.h3AssetDirectSemanticCompile.completedBatches, 3);
  assert.equal(completed.h3AssetDirectSemanticCompile.localFallbackCount, 0);
  assert.equal(completed.shots.every(shot => shot.providerSemanticCompileSource === "ai-batch"), true);
});

test("asset-direct prop continuity ledger preserves explicit empty holders and exact cross-shot handoffs", t => {
  const { store, projectId } = createFixture(t);
  const project = store.getProject(projectId);
  project.shots.push({
    ...project.shots[0],
    id: "S02",
    number: 2,
    action: "林岚从茶几拿回档案袋并装进手包。",
    stateBefore: "档案袋仍在茶几上。",
    stateAfter: "档案袋已在林岚手包内。",
    propBindings: [{
      propId: "P01",
      holderBeforeCharacterId: "",
      holderAfterCharacterId: "C01",
      holderCharacterId: "C01",
      locationBefore: "coffee table",
      locationAfter: "C01 handbag",
      stateBefore: "pressed_on_table",
      stateAfter: "packed",
      transferAction: "C01 retrieves P01 from the coffee table and packs it into her handbag"
    }]
  });
  const ledger = criticalPropContinuityLedger(project);
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].appearances.map(item => [item.shotId, item.holderBeforeCharacterId, item.holderAfterCharacterId]), [
    ["S01", "C01", ""],
    ["S02", "", "C01"]
  ]);
  assert.equal(ledger[0].appearances[1].locationBefore, ledger[0].appearances[0].locationAfter);
  assert.equal(ledger[0].appearances[1].stateBefore, ledger[0].appearances[0].stateAfter);
});

test("asset-direct visual copy removes display digits and music cues without changing spoken dialogue", () => {
  const prompt = renderApprovedVideoPromptChinese({
    generation: { mode: "asset_direct", aspectRatio: "9:16" },
    characters: [{ id: "C01", name: "苏梅" }, { id: "C02", name: "林倩" }]
  }, {
    id: "S08",
    number: 8,
    duration: 10,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    action: "手机计时停在十八分钟，婚礼音乐响起，林倩替母亲冲洗擦干。",
    dialogueTurns: [{
      speakerId: "C02",
      listenerIds: ["C01"],
      text: "十八分钟到了。",
      delivery: "轻快提醒",
      body: "看一眼手机计时后掀开浴帽",
      plannedSpeechSeconds: 2,
      plannedAfterBeatSeconds: 0.5
    }],
    subshots: [{ start: 0, end: 10, framing: "双人中景", camera: "稳定跟拍", action: "手机计时停在十八分钟，婚礼音乐响起，开始冲洗" }]
  }, { imageRoles: [{type:"character",entityId:"C01"},{type:"character",entityId:"C02"}], audios: [{ characterId: "C02" }] });
  assert.equal((prompt.match(/十八分钟到了/g) || []).length, 1);
  assert.doesNotMatch(prompt.replace("十八分钟到了", ""), /手机(?:屏幕)?|计时(?:器|数字)?|婚礼音乐|BGM|十八分钟/);
  assert.match(prompt, /等待结束|现场仪式正式开始/);
});

test("asset-direct image-only binds only current scene, visible identities and needed object/product", async t => {
  const { root, store, workflow, projectId } = createFixture(t);
  const projectBefore = store.getProject(projectId);
  const productPath = path.join(root, "product.png");
  fs.writeFileSync(productPath, Buffer.from("product-image"));
  projectBefore.product.imagePath = productPath;
  store.saveProject(projectBefore);

  const add = (entityType, entityId, stage, fileName, extra = {}) => {
    const filePath = path.join(root, fileName);
    if (stage === "character_voice") fs.writeFileSync(filePath, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)]));
    else fs.writeFileSync(filePath, Buffer.from(`image-${fileName}`));
    return store.addCandidate(projectId, { entityType, entityId, stage, filePath, selected: true, ...extra });
  };
  add("character", "C01", "character_intro", "c01.png");
  add("character", "C02", "character_intro", "c02.png");
  add("scene", "SC01", "scene_asset", "scene.png");
  add("library", "P01", "prop_asset", "prop.png");
  add("character", "C01", "character_voice", "c01.mp3", { duration: 5, mediaProbeVerified: true });
  add("character", "C02", "character_voice", "c02.mp3", { duration: 5, mediaProbeVerified: true });

  const project = store.getProject(projectId);
  const references = workflow.shotReferences(project, project.shots[0], "asset_direct");
  const types = references.imageRoles.map(item => item.type);
  assert.deepEqual(types.filter(type => type === "character").length, 2);
  assert.ok(types.includes("scene"));
  assert.ok(types.includes("prop"));
  assert.ok(types.includes("product"));
  assert.ok(!types.some(type => /^storyboard_/.test(type)));
  assert.deepEqual(references.audios, []);
  assert.equal(references.referenceAudioMode, "image_only");
  assert.equal(references.videos, undefined);
});
