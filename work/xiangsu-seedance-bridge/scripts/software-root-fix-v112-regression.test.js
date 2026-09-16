"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  productCommerceFacts,
  voiceProfileCompatible
} = require("../app/workbench-workflow");
const {
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  eventSpecificCameraCue,
  filterReferencesForGenerationBlock,
  generationBlockTakes,
  productPresenterTurn,
  validateCameraTakePlan
} = require("../app/agent-director");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");

test("multi-person costume change belongs only to its named owner and carries forward until an explicit reset", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-wardrobe-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("服装状态机回归", { engine: "hailuo-h3", mode: "asset_direct" });
  store.patchProject(created.id, {
    characters: [{
      id: "C01",
      name: "林岚",
      description: "中年女性",
      outfits: [{ label: "修复后的礼服", description: "完整修复、合身的深色礼服", changeRequired: true }]
    }, {
      id: "C02",
      name: "周梅",
      description: "中年女性，紫色开衫"
    }],
    scenes: [{ id: "SC01", name: "婚礼休息室" }],
    assetLibraries: { props: [], wardrobes: [], voices: [] },
    shots: [{
      id: "S01", number: 1, sceneId: "SC01",
      characterIds: ["C01", "C02"], scenePresenceCharacterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"],
      action: "林岚穿日常衣服站在左侧，周梅穿紫色开衫站在右侧。"
    }, {
      id: "S28", number: 28, sceneId: "SC01", wardrobeLabel: "修复后的礼服",
      characterIds: ["C01", "C02"], scenePresenceCharacterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"],
      action: "林岚换上修复后的礼服，周梅仍穿紫色开衫。"
    }, {
      id: "S29", number: 29, sceneId: "SC01",
      characterIds: ["C01", "C02"], scenePresenceCharacterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"],
      action: "林岚走到宾客面前继续完成婚礼，周梅退到门边。"
    }, {
      id: "S30", number: 30, sceneId: "SC01",
      characterIds: ["C01", "C02"], scenePresenceCharacterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"],
      action: "仪式结束后，林岚换回日常服装，周梅仍穿紫色开衫。"
    }]
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  workflow.syncReferenceLibraries(created.id);
  const project = store.getProject(created.id);
  assert.equal(project.assetLibraries.wardrobes.length, 1);
  const wardrobe = project.assetLibraries.wardrobes[0];
  assert.equal(wardrobe.characterId, "C01");
  assert.equal(wardrobe.label, "修复后的礼服");
  const s28 = project.shots.find(item => item.id === "S28");
  const s29 = project.shots.find(item => item.id === "S29");
  const s30 = project.shots.find(item => item.id === "S30");
  assert.deepEqual(s28.wardrobeBindings.map(item => item.characterId), ["C01"]);
  assert.equal(s28.wardrobeBindings[0].wardrobeId, wardrobe.id);
  assert.equal(s29.wardrobeBindings.find(item => item.characterId === "C01")?.wardrobeId, wardrobe.id);
  assert.equal(s29.wardrobeBindings.some(item => item.characterId === "C02"), false);
  assert.deepEqual(s30.wardrobeBindings, []);
});

test("identity reference cannot overwrite a dedicated changed-hair or wardrobe reference", () => {
  const prompt = buildApprovedHailuoPrompt({
    project: {
      generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" },
      characters: [{ id: "C01", name: "林岚" }]
    },
    shot: {
      id: "S28", duration: 12, sceneId: "SC01",
      characterIds: ["C01"], visibleCharacterIds: ["C01"],
      actionEn: "C01 enters already wearing W01 and faces the guests.",
      stateBeforeEn: "C01 waits outside the doorway in W01.",
      stateAfterEn: "C01 stands before the guests in W01."
    },
    references: {
      images: ["scene-four-view.png", "c01-identity.png", "c01-current-wardrobe.png"],
      imageRoles: [
        { type: "scene", entityId: "SC01" },
        { type: "character", entityId: "C01" },
        { type: "wardrobe", entityId: "W01", characterId: "C01" }
      ],
      audios: [],
      promptMode: "asset_direct"
    },
    dialogueTurns: [{ speakerId: "C01", listenerIds: [], text: "今天，我只为自己站在这里。", deliveryEn: "steady dignity with a trembling aftershock" }]
  });
  assert.match(prompt, /<Subject 1> \(S1\)[\s\S]{0,180}exact face, age, body and immutable identity come from <Picture 2>[\s\S]{0,180}hair and wardrobe follow the dedicated current appearance reference/);
  assert.match(prompt, /exact complete wardrobe and accessories shown in <Picture 3>/);
  assert.doesNotMatch(prompt, /hair and wardrobe[\s\S]{0,40}come from <Picture 2>/);
});

test("camera direction is driven by the authored event instead of one generic static template", () => {
  const cues = [
    eventSpecificCameraCue({ action: "女主被一脚踹倒在地，捂住腹部。" }, {}, false),
    eventSpecificCameraCue({ action: "她把房产证和剪开的礼服摔在桌上。" }, {}, true),
    eventSpecificCameraCue({ action: "真相落地后，全场宾客起身鼓掌。" }, {}, false),
    eventSpecificCameraCue({ productMention: true, productShotType: "product_cta", action: "主角介绍优惠和购买入口。" }, {}, true)
  ];
  assert.equal(new Set(cues).size, cues.length);
  assert.match(cues[0], /ground-level impact follow/i);
  assert.match(cues[1], /object close-up/i);
  assert.match(cues[2], /ensemble reaction/i);
  assert.match(cues[3], /front-facing presenter medium close-up/i);
});

test("only an authored product close may face the viewer and commerce facts are never invented", () => {
  const product = { name: "七味堂植物泡泡染发膏", sellingPoints: "居家泡泡染，白发盖色自然" };
  const presenter = { metadata: { directToViewer: true }, text: "点击当前页面商品入口查看实时活动和下单。" };
  assert.equal(productPresenterTurn({ product }, { productMention: true, productShotType: "product_cta" }, presenter), true);
  assert.equal(productPresenterTurn({ product }, { productMention: false, productShotType: "none" }, { text: "你终于肯听我说完了。" }), false);
  assert.deepEqual(productCommerceFacts({ product }), {
    price: "",
    offer: "",
    purchase: "",
    safePurchaseClose: "点击当前页面商品入口查看实时活动和下单",
    hasCommercialClaim: false
  });
  assert.deepEqual(productCommerceFacts({ product: { ...product, price: "39.9元", offer: "限时两件九折", purchaseMethod: "点击商品入口下单" } }), {
    price: "39.9元",
    offer: "限时两件九折",
    purchase: "点击商品入口下单",
    safePurchaseClose: "点击商品入口下单",
    hasCommercialClaim: true
  });
});

test("final compact H3 prompt puts the exact Chinese line and speaker ownership ahead of bounded direction", () => {
  const project = {
    generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" },
    product: { name: "七味堂植物泡泡染发膏" },
    characters: [{ id: "C01", name: "林岚" }, { id: "C02", name: "周梅" }]
  };
  const turn = {
    speakerId: "C01", listenerIds: ["C02"], text: "七味堂植物泡泡染发膏，点击当前页面商品入口查看实时活动和下单。",
    metadata: { directToViewer: true, addressMode: "viewer", deliveryEn: "warm confident recommendation with firm keyword stress" }
  };
  const shot = {
    id: "S31", number: 31, duration: 12, sceneId: "SC01",
    characterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"],
    productMention: true, productShotType: "product_cta", shotFunction: "product_presentation",
    actionEn: "C01 raises the exact product beside her face after the family conflict resolves.",
    subshots: [{ start: 0, end: 12, visibleCharacterIds: ["C01", "C02"], dialogueTurns: [turn] }],
    dialogueTurns: [turn]
  };
  const references = {
    images: ["scene.png", "c01.png", "c02.png", "product.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "product", entityId: "product" }
    ],
    audios: []
  };
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  const source = plan.generationBlocks[0];
  const block = { ...source, takes: generationBlockTakes(plan, source) };
  const scoped = filterReferencesForGenerationBlock(references, block, { blockCount: 1, multiBlock: false });
  const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, scoped);
  // The official sectioned prompt is bounded by the actual submission contract,
  // not the retired compact-template 6000-character heuristic.
  assert.ok(prompt.length <= 10000, `provider request limit exceeded: ${prompt.length}`);
  assert.match(prompt, /^subject_definitions:/);
  assert.match(prompt, /\noverall_soundscape:\n/);
  assert.equal(prompt.split(turn.text).length - 1, 1);
  assert.match(prompt, /faces the viewer through the lens/);
  assert.match(prompt, /face, eyes and upper torso stay front-facing toward the lens/);
  assert.match(prompt, /Only <Subject 1> \(S1\) moves the lips for this line/);
  assert.match(prompt, /<Subject 2> remains closed-lipped/);
});

test("automatic voice reuse rejects gender and extreme-age mismatches while manual binding remains explicit", () => {
  const woman = { id: "C01", name: "林岚", description: "45岁中年女性", voiceDescription: "中年女声，克制坚定" };
  assert.equal(voiceProfileCompatible({ gender: "male", ageBand: "中年" }, woman), false);
  assert.equal(voiceProfileCompatible({ gender: "female", ageBand: "中年", profileVerified: true }, woman), true);
  assert.equal(voiceProfileCompatible({ gender: "female", ageBand: "少年" }, { name: "白发老奶奶", description: "七十岁老年女性" }), false);
  assert.equal(voiceProfileCompatible({ gender: "male", ageBand: "少年" }, woman, { manualBinding: true }), true);
});

test("acceptance runner preserves source shot IDs, authored durations and exact lines without machine-local artifacts", () => {
  const runnerSource=fs.readFileSync(path.join(__dirname,'run-real-h3-five-minute-no-product-first-half.js'),'utf8');
  assert.match(runnerSource,/summarizeSource\(SOURCE_PROJECT\)/);
  assert.match(runnerSource,/const SHOT_IDS = SOURCE_SUMMARY.shotIds/);
  assert.match(runnerSource,/const duration = Number\(source\.duration \|\| 0\)/);
  assert.match(runnerSource,/const exactText = String\(inherited\.text \|\| inherited\.spokenText \|\| ""\)/);
  assert.doesNotMatch(runnerSource,/DIALOGUE_OVERRIDES|SHOT_SECONDS/);
  const {summarizeSource}=require('./source-project-contract');
  // Synthetic input tests the shared contract, never impersonates the lost historical screenplay.
  const source={shots:Array.from({length:31},(_,i)=>({id:'source-'+(31-i),duration:i===30?3:12,dialogueTurns:Array.from({length:i<3?3:2},(_,j)=>({text:'Exact synthetic line '+i+' / '+j+'; punctuation preserved.'}))}))};
  const before=JSON.stringify(source),actual=summarizeSource(source);
  assert.deepEqual(actual.shotIds,source.shots.map(s=>s.id));assert.equal(actual.seconds,363);assert.equal(actual.dialogue.length,65);
  assert.deepEqual(actual.dialogue,source.shots.flatMap(s=>s.dialogueTurns.map(t=>t.text)));assert.equal(JSON.stringify(source),before);
  assert.equal(summarizeSource({shots:[{id:'single',duration:7.25,dialogueTurns:[{spokenText:'Fallback exact line.'}]}]}).seconds,7.25);
  assert.throws(()=>summarizeSource({shots:[{id:'x',duration:1},{id:'x',duration:2}]}),/SOURCE_SHOT_IDS_INVALID/);
  assert.throws(()=>summarizeSource({shots:[{id:'x',duration:0}]}),/SOURCE_DURATION_INVALID/);
});
