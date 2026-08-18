"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, promptReviewReferencePlan, PROMPT_REVIEW_BUNDLE_VERSION } = require("../app/workbench-workflow");

test("prompt review bundle is complete before paid asset generation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("提示词预生成回归", { engine: "seedance", mode: "keyframe" });
  store.patchProject(created.id, {
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true },
    productionPlan: { ...(created.productionPlan || {}), executionMode: "full", inputMode: "manual", scriptFormatConfirmed: true },
    characters: [{
      id: "C01", name: "张三", description: "中年男人，深色夹克", identitySignature: "右眉上有浅疤",
      voiceDescription: "低沉克制，后半句压着怒气", signatureLine: "你先听我说完。", promptOverrides: {}
    }, {
      id: "C02", name: "李四", description: "中年女人，浅色外套", identitySignature: "短发",
      voiceDescription: "语速偏快，带哭腔", signatureLine: "我没有骗你。", promptOverrides: {}
    }],
    scenes: [{ id: "SC01", name: "客厅", description: "固定木桌与门口轴线" }],
    assetLibraries: {
      props: [{ id: "P01", name: "证据文件袋", description: "推动剧情的唯一核心道具", promptOverrides: {} }],
      wardrobes: [{ id: "W01", name: "张三深色夹克", description: "全剧不换装", characterId: "C01", promptOverrides: {} }]
    },
    shots: [{
      id: "S01", number: 1, title: "证据落桌", duration: 8, sceneId: "SC01", scene: "客厅",
      characterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"], characterNames: ["张三", "李四"],
      scenePresenceCharacterIds: ["C01", "C02"], imageReferenceCharacterIds: ["C01", "C02"], videoReferenceCharacterIds: [],
      offscreenSpeakerIds: [], action: "张三把证据推到桌面，李四后退半步", visualBeat: "证据改变两人的关系",
      stateBefore: "证据还在张三手里", stateAfter: "证据摊在桌面，李四无处躲闪",
      shotSize: "中近景", cameraMove: "从张三推手动作缓慢推近到李四反应", compositionPlan: "张三在左，李四在右",
      emotion: "压着怒气到被迫承认", performance: "眉眼收紧，呼吸加重，李四眼神躲闪",
      dialogueTurns: [
        { speakerId: "C01", speaker: "张三", listenerIds: ["C02"], text: "你先听我说完。", sourceTone: "压着怒气，低声起句" },
        { speakerId: "C02", speaker: "李四", listenerIds: ["C01"], text: "我没有骗你。", sourceTone: "带哭腔，急促辩解" }
      ],
      subshots: [{ number: 1, start: 0, end: 4, action: "张三推证据", framing: "张三中近景", camera: "缓慢推近", dialogueTurns: [] }, { number: 2, start: 4, end: 8, action: "李四后退", framing: "李四近景", camera: "硬切并锁定李四", dialogueTurns: [] }],
      promptMode: "system", promptOverrides: {}
    }]
  });
  const seeded = store.getProject(created.id);
  seeded.assetLibraries = {
    ...(seeded.assetLibraries || {}),
    props: [{ id: "P01", name: "证据文件袋", description: "推动剧情的唯一核心道具", promptOverrides: {} }],
    wardrobes: [{ id: "W01", name: "张三深色夹克", description: "全剧不换装", characterId: "C01", promptOverrides: {} }]
  };
  store.saveProject(seeded);

  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  const result = await workflow.preparePromptReviewBundle(created.id, { autoApprove: true });
  assert.equal(result.promptReview.version, PROMPT_REVIEW_BUNDLE_VERSION);
  assert.equal(result.promptReview.status, "approved");
  assert.ok(result.promptReview.counts.total >= 8);
  assert.equal(result.promptReview.items.every(item => item.language === "zh-CN"), true);
  assert.ok(result.promptReview.items.every(item => item.prompt.length > 20));
  assert.equal(result.promptReview.items.some(item => item.entityId === "P01" && item.stage === "prop_asset"), true);
  assert.equal(result.promptReview.items.some(item => item.entityId === "W01" && item.stage === "wardrobe_asset"), true);
  assert.match(result.shots[0].systemVideoPrompt, /对白内容＞语气＞情绪＞场景＞运镜＞其他/);
  assert.match(result.shots[0].systemVideoPrompt, /你先听我说完。/);
  assert.match(result.shots[0].systemVideoPrompt, /我没有骗你。/);
  assert.equal(result.shots[0].promptReviewReferencePlan.audios.length, 2);
  assert.equal(result.shots[0].promptReviewReferencePlan.images.some(item => item.type === "scene"), true);
  assert.equal(result.shots[0].promptReviewReferencePlan.images.some(item => item.type === "character"), true);
  const refs = promptReviewReferencePlan(result, result.shots[0], "keyframe");
  assert.equal(refs.reviewOnly, true);
  assert.ok(refs.images.every(item => item.startsWith("prompt-review://")));
});

test("asset generation cannot reach the provider boundary before prompt review is persisted", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("prompt order guard", { engine: "seedance", mode: "keyframe" });
  store.patchProject(created.id, {
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true },
    productionPlan: { ...(created.productionPlan || {}), executionMode: "step", inputMode: "manual", scriptFormatConfirmed: true },
    characters: [{ id: "C01", name: "角色甲", description: "固定身份与外观", promptOverrides: {} }],
    scenes: [{ id: "SC01", name: "室内", description: "固定室内场景", promptOverrides: {} }],
    shots: [{ id: "S01", number: 1, duration: 5, sceneId: "SC01", characterIds: ["C01"], action: "角色甲走到桌边", dialogueTurns: [], promptOverrides: {} }]
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  let providerBoundaryObserved = false;
  workflow.buildAssetBatchPlan = () => [];
  workflow.authoritativeGenerationConcurrency = async () => {
    const persisted = store.getProject(created.id).promptReview;
    assert.equal(["ready", "approved"].includes(persisted?.status), true);
    assert.ok(Number(persisted?.counts?.total) > 0);
    providerBoundaryObserved = true;
    return { image: 1, video: 1, source: "test", authority: "test" };
  };
  await workflow.generateAllAssets(created.id, { track: false });
  assert.equal(providerBoundaryObserved, true);
});
