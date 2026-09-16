"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { matrixEntry } = require("../app/production-mode-matrix");

const PREASSET_MODES = ["asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixtureProject(store, mode, productPath) {
  const created = store.createProject(`离线资产前置审计-${mode}`, {
    engine: "hailuo-h3",
    mode,
    inputMode: "manual",
    executionMode: "step"
  });
  return store.patchProject(created.id, {
    generation: {
      ...(created.generation || {}),
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      aspectRatio: "9:16",
      mode,
      modeConfirmed: true
    },
    productionPlan: {
      ...(created.productionPlan || {}),
      inputMode: "manual",
      scriptHandling: "respect",
      executionMode: "step"
    },
    product: {
      name: "羊脂皂",
      description: "用户上传商品原包装",
      sellingPoints: "用户提供事实",
      imagePath: productPath,
      source: "manual-upload"
    },
    characters: [
      { id: "C01", name: "沈青", gender: "female", age: "38岁", ageBand: "中年", castingTier: "lead", role: "女主", description: "38岁女性，鹅蛋脸，深棕短发，身形清瘦，穿米白衬衫与深色长裤。", identitySignature: "左眉尾浅痣，深棕短发，窄银腕表。" },
      { id: "C02", name: "周衡", gender: "male", age: "45岁", ageBand: "中年", castingTier: "supporting", role: "关键证人", description: "45岁男性，方脸，黑色短发，肩背端正，穿深灰夹克。", identitySignature: "方脸，右眼下细纹，深灰夹克。" },
      { id: "C03", name: "路人甲", gender: "male", age: "30岁", ageBand: "青年", castingTier: "background", role: "从始至终只是背景板", description: "30岁男性，短发，普通深色外套。" },
      { id: "C04", name: "门外邻居", gender: "female", age: "60岁", ageBand: "老年", castingTier: "offscreen", role: "只在画外存在", description: "60岁女性。" }
    ],
    scenes: [{
      id: "SC01",
      name: "夜间旧客厅",
      description: "狭长旧客厅，北墙木门，东侧窗，沙发与茶几位置固定",
      layout: "北墙木门；东侧窗；沙发朝西；茶几居中",
      entrances: ["北墙木门"],
      axis: "沿沙发与木门建立东西向180度轴线",
      time: "night",
      lighting: "东侧窗冷光与落地灯暖光"
    }],
    assetLibraries: {
      props: [
        { id: "P01", name: "发黄信封", description: "右下角有三角折痕的旧信封", coreStory: true, causalRole: "唯一关键证物", units: ["S01", "S02"] },
        { id: "P02", name: "透明水杯", description: "一次性饮水容器", units: ["S01"] },
        { id: "P03", name: "羊脂皂外包装", description: "商品包装部件", units: ["S02"] }
      ],
      wardrobes: []
    },
    shots: [
      {
        id: "S01", number: 1, title: "信封落桌", duration: 8,
        sceneId: "SC01", scene: "夜间旧客厅", sceneName: "夜间旧客厅",
        characterIds: ["C01", "C03"], visibleCharacterIds: ["C01", "C03"], scenePresenceCharacterIds: ["C01", "C03"],
        focusCharacterId: "C01", cameraOwnerId: "C01", mouthOwnerId: "C01",
        imageReferenceCharacterIds: ["C01"], videoReferenceCharacterIds: ["C01"],
        propIds: ["P01"], propBindings: [{ propId: "P01", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", stateBefore: "握在右手", stateAfter: "落在茶几上", transferAction: "沈青把信封按在茶几上" }],
        action: "沈青从北墙木门入镜，把发黄信封按在茶几上。", visualBeat: "信封落桌后沈青抬眼逼视周衡", stateBefore: "沈青在门外，信封握在右手", stateAfter: "沈青站在画面左侧，信封落在茶几中央",
        startFrame: "沈青从北墙木门跨入画面，信封握在右手", endFrame: "信封停在茶几中央，沈青站在左侧",
        shotSize: "中近景", cameraMove: "从门口跟拍到茶几后切入沈青中近景", emotion: "压住愤怒",
        dialogue: "沈青（压住愤怒）：这封信，能证明你刚才撒了谎。",
        dialogueTurns: [{ sourceDialogueId: "D001", speakerId: "C01", speakerName: "沈青", listenerIds: ["C02"], text: "这封信，能证明你刚才撒了谎。", sourceTone: "压住愤怒", tone: "压住愤怒", delivery: "压住愤怒，结尾加重", start: 1, end: 7 }],
        sourceDialogueBindings: [{ sourceDialogueId: "D001", listenerIds: ["C02"], subshotNumber: 1, intent: "揭穿谎言", emotion: "压住愤怒", delivery: "压住愤怒，结尾加重", body: "把信封按在茶几上", listenerBeat: "闭口后退半步" }],
        subshots: [{ number: 1, start: 0, end: 8, action: "沈青入场、落下信封并说完整台词", camera: "门口跟拍后切中近景", visibleCharacterIds: ["C01", "C03"], sourceDialogueIds: ["D001"] }]
      },
      {
        id: "S02", number: 2, title: "证人承认", duration: 8,
        sceneId: "SC01", scene: "夜间旧客厅", sceneName: "夜间旧客厅",
        characterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"], scenePresenceCharacterIds: ["C01", "C02"],
        focusCharacterId: "C02", cameraOwnerId: "C02", mouthOwnerId: "C02",
        imageReferenceCharacterIds: ["C01", "C02"], videoReferenceCharacterIds: ["C01", "C02"],
        propIds: ["P01"], propBindings: [{ propId: "P01", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", stateBefore: "茶几中央", stateAfter: "茶几中央", transferAction: "无换手" }],
        action: "周衡盯着茶几上的信封，闭眼一瞬后承认。", visualBeat: "周衡从回避视线到直视沈青", stateBefore: "周衡站在右侧回避视线", stateAfter: "周衡站在右侧直视沈青",
        startFrame: "周衡站在右侧低头看信封", endFrame: "周衡站在右侧直视沈青",
        shotSize: "近景", cameraMove: "从信封特写切周衡近景并缓慢推近", emotion: "羞愧后下定决心",
        dialogue: "周衡（羞愧、低声）：是我撒了谎，我现在把真相说清楚。",
        dialogueTurns: [{ sourceDialogueId: "D002", speakerId: "C02", speakerName: "周衡", listenerIds: ["C01"], text: "是我撒了谎，我现在把真相说清楚。", sourceTone: "羞愧、低声", tone: "羞愧、低声", delivery: "开头低沉迟疑，后半句坚定", start: 1, end: 7 }],
        sourceDialogueBindings: [{ sourceDialogueId: "D002", listenerIds: ["C01"], subshotNumber: 1, intent: "承认真相", emotion: "羞愧转坚定", delivery: "开头低沉迟疑，后半句坚定", body: "先低头再抬眼", listenerBeat: "沈青闭口盯住他" }],
        subshots: [{ number: 1, start: 0, end: 8, action: "周衡看向信封后抬眼说完整台词", camera: "信封特写切周衡近景", visibleCharacterIds: ["C01", "C02"], sourceDialogueIds: ["D002"] }]
      }
    ]
  });
}

test("every non-package mode compiles the same strict minimal asset set without any model or media call", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-preasset-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceProduct = path.join(__dirname, "..", "app", "assets", "drama-slot-mark.png");

  for (const mode of PREASSET_MODES) {
    const dataRoot = path.join(root, mode);
    const store = new WorkbenchStore(dataRoot);
    const settings = store.getSettings();
    settings.generation.qualityGatesEnabled = false;
    settings.videoProvider.hailuoReferenceAudioMode = "image_only";
    store.saveSettings(settings);
    const imported = path.join(dataRoot, "immutable-product.png");
    fs.mkdirSync(path.dirname(imported), { recursive: true });
    fs.copyFileSync(sourceProduct, imported);
    assert.equal(sha256(imported), sha256(sourceProduct), `${mode}: product bytes changed on import fixture`);

    const project = fixtureProject(store, mode, imported);
    let textCalls = 0;
    let mediaCalls = 0;
    const bridge = new Proxy({}, { get: () => () => { mediaCalls += 1; throw new Error("offline preasset audit forbids media calls"); } });
    const workflow = new WorkbenchWorkflow({
      store,
      bridge,
      locateFfmpeg: () => "",
      stagingRoot: dataRoot,
      textGenerator: async () => { textCalls += 1; throw new Error("offline preasset audit forbids model calls"); }
    });
    const reviewed = await workflow.preparePromptReviewBundle(project.id, { autoApprove: false });
    const assetStages = new Set(["character_intro", "character_sheet", "character_voice", "character_video", "scene_asset", "prop_asset", "wardrobe_asset", "product_asset"]);
    const assetItems = reviewed.promptReview.items.filter(item => assetStages.has(item.stage));
    const characterItems = assetItems.filter(item => item.entityType === "character" && ["character_intro", "character_sheet"].includes(item.stage));
    const scene = assetItems.find(item => item.stage === "scene_asset");
    const propItems = assetItems.filter(item => item.stage === "prop_asset");

    // Prompt-review may request a Chinese review mirror for an English video
    // prompt.  The injected local stub intercepts that request, so it proves
    // the orchestration path without allowing any network/provider call.
    assert.ok(textCalls <= 2, `${mode}: unexpected text-stage fan-out (${textCalls})`);
    assert.equal(mediaCalls, 0, `${mode}: media provider was called`);
    assert.deepEqual(characterItems.map(item => item.entityId).sort(), ["C01", "C02"], `${mode}: background/offscreen identity leaked into assets`);
    assert.equal(characterItems.every(item => /岁|中年/.test(item.prompt) && /脸|发/.test(item.prompt)), true, `${mode}: character appearance is missing`);
    assert.equal(scene && /16:9/.test(scene.prompt) && /2列×2行|2×2/.test(scene.prompt), true, `${mode}: scene is not a 16:9 2x2 board`);
    assert.match(scene.prompt, /正向广角主视图/);
    assert.match(scene.prompt, /反向广角/);
    assert.match(scene.prompt, /左侧45度/);
    assert.match(scene.prompt, /右侧45度/);
    assert.match(scene.prompt, /同一个可连通空间/);
    assert.match(scene.prompt, /不得出现任何人/);
    assert.deepEqual(propItems.map(item => item.entityId), ["P01"], `${mode}: non-core/product-component prop leaked into assets`);
    assert.equal(assetItems.some(item => item.stage === "product_asset"), false, `${mode}: user product was incorrectly queued for generation`);
    assert.equal(reviewed.product.imagePath, imported, `${mode}: product source path changed during prompt compilation`);

    const plan = workflow.buildAssetBatchPlan(project.id);
    assert.equal(plan.some(item => item.entityId === "C03" || item.entityId === "C04"), false, `${mode}: background/offscreen asset queued`);
    assert.equal(plan.filter(item => item.kind === "prop_asset").map(item => item.entityId).join(","), "P01", `${mode}: asset plan contains non-core props`);
    assert.equal(plan.some(item => item.kind === "product_asset"), false, `${mode}: product generation was queued`);
  }
});

test("production-package mode explicitly bypasses all preasset generation", () => {
  const entry = matrixEntry("cloud", "production_package");
  assert.match(entry.framePolicy, /不再进入选题、写作、拆镜、提示词或资产生成阶段/);
  assert.match(entry.imagePolicy, /不要求、不生成任何额外镜头锚点图/);
  assert.match(entry.videoPolicy, /不触发任何导入包之外的媒体生成/);
});

test("optional reference-audio planning never allocates voice assets to background-only people", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-preasset-voice-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceProduct = path.join(__dirname, "..", "app", "assets", "drama-slot-mark.png");

  for (const mode of PREASSET_MODES) {
    const dataRoot = path.join(root, mode);
    const store = new WorkbenchStore(dataRoot);
    const settings = store.getSettings();
    settings.videoProvider.hailuoReferenceAudioMode = "image_audio";
    store.saveSettings(settings);
    const project = fixtureProject(store, mode, sourceProduct);
    const workflow = new WorkbenchWorkflow({
      store,
      bridge: new Proxy({}, { get: () => () => { throw new Error("offline preasset audit forbids media calls"); } }),
      locateFfmpeg: () => "",
      stagingRoot: dataRoot,
      textGenerator: async () => { throw new Error("offline preasset audit forbids text calls"); }
    });
    const plan = workflow.buildAssetBatchPlan(project.id);
    assert.deepEqual(plan.filter(item => item.kind === "character_voice").map(item => item.entityId).sort(), ["C01", "C02"], `${mode}: voice plan includes a background/offscreen person`);
    assert.equal(plan.some(item => ["C03", "C04"].includes(item.entityId)), false, `${mode}: optional audio created a background asset`);
    assert.equal(plan.filter(item => item.kind === "character_video").length, mode === "asset_direct" ? 0 : 2, `${mode}: character-video prerequisites disagree with mode contract`);
  }
});
test('a later semantic timeout preserves earlier saved shot output and batch-size checkpoint',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-semantic-checkpoint-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new WorkbenchStore(root),project=fixtureProject(store,'asset_direct',path.join(__dirname,'../app/assets/drama-slot-mark.png'));
 const workflow=new WorkbenchWorkflow({store,bridge:{},locateFfmpeg:()=>'',stagingRoot:root,textGenerator:async()=>{throw Error('no real provider');}});
 // Design is a separate verified stage; only timeout persistence is under test.
 const fullPrompt=require('../app/asset-prompt-author'), originalFullPrompt=fullPrompt.author;
 fullPrompt.author=async()=>({changed:false,authoredCount:0});
 t.after(()=>{fullPrompt.author=originalFullPrompt;});
 const design=require('../app/asset-design-author'),original=design.authorMissingDesigns;
 design.authorMissingDesigns=async({project})=>project;
 t.after(()=>{design.authorMissingDesigns=original;});
 workflow.compileH3AssetDirectSemanticsBatch=async id=>{
  const saved=store.getProject(id);saved.shots[0].stateAfterEn='Exact completed first-batch result retained';
  saved.h3AssetDirectSemanticCompile={status:'deferred',batchSize:2,compiledCount:1,errorCode:'LOCAL_AGENT_TIMEOUT',batches:[{shotIds:['S01'],status:'completed'}]};store.saveProject(saved);
  throw Object.assign(Error('Later request timed out'),{code:'LOCAL_AGENT_TIMEOUT'});
 };
 const reviewed=await workflow.preparePromptReviewBundle(project.id,{autoApprove:false});
 assert.equal(reviewed.shots[0].stateAfterEn,'Exact completed first-batch result retained');
 assert.equal(reviewed.h3AssetDirectSemanticCompile.batchSize,2);
 assert.equal(reviewed.h3AssetDirectSemanticCompile.compiledCount,1);
 assert.equal(reviewed.h3AssetDirectSemanticCompile.batches[0].status,'completed');
});
