"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

let transportCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  transportCalls += 1;
  throw new Error("OFFLINE_AUDIT_FORBIDS_NETWORK");
};

const { planFilmSchedule } = require("../app/duration-contract");
const { buildSourceSceneLedger } = require("../app/script-scene-ledger");
const {
  buildDirectFastFallbackSegment,
  buildDirectFastFallbackSpine,
  directFastSegmentRanges,
  materializeDirectFastScript
} = require("../app/direct-fast-script");
const {
  aiFirstUploadStandardizationValidation,
  conformImportedAnalysisToDurationContract,
  ideaScriptBootstrapGaps,
  localUploadedAnalysisChunk,
  normalizeTopicOptions,
  productionDialogueLedgerFromScript,
  scriptPipelineEntryRoute,
  topicIdeationRuntimePrompt,
  uploadedFormatAdaptationValidation
} = require("../app/workbench-workflow");

test.after(() => {
  global.fetch = originalFetch;
  assert.equal(transportCalls, 0, "pre-asset audit must not touch any network upstream");
});

function topicFixture() {
  const relationships = ["母女", "父子", "婆媳", "邻里", "师生", "夫妻", "兄妹", "同事", "医患", "老友"];
  return relationships.map((relationship, index) => ({
    slotId: `T${String(index + 1).padStart(2, "0")}`,
    title: `雨夜真相${index + 1}`,
    genre: "现实情感",
    relationship,
    referenceKernel: `K${String((index % 15) + 1).padStart(2, "0")}`,
    storyMechanism: ["rescue_repaid", "kindness_misjudged", "sacrifice_repaid", "evidence_reversal"][index % 4],
    conflictDomain: "家庭财产与照护责任",
    hookAction: "女儿当众抢走母亲手里的缴费单",
    hook: "女儿当众抢走母亲手里的缴费单，逼问她为什么卖掉老屋。",
    firstDialogue: "妈，你卖了老屋，还替弟弟还债？",
    highlights: ["缴费单被抢", "日期揭穿误解", "女儿交还新房钥匙"],
    logline: "女儿误以为母亲卖屋偏心弟弟，缴费单和邻居证言证明母亲替她垫付急救费。",
    reversal: "女儿确认母亲卖屋是替自己垫付急救费。",
    emotionalPayoff: "女儿交还新房钥匙并承担母亲的新住处租金。",
    productPlacement: "母亲搬进新居后需要日常清洁，此刻拆开羊脂皂使用，镜头只拍真实清洁动作与可见结果，女儿决定长期照料。",
    audienceAppeal: "误解刺痛，证据翻转，行动偿还。",
    reason: "冲突、证据和结局行动都可直接拍摄。"
  }));
}

test("AI topic entry requests skill-level causal hooks and normalizes ten distinct complete cards", () => {
  const prompt = topicIdeationRuntimePrompt({ prompts: {}, promptModes: {} }, {
    generation: { videoEngine: "hailuo-h3" },
    productionPlan: { commerceMode: "natural" },
    product: { name: "羊脂皂", description: "日常清洁用品", sellingPoints: "只按用户提供事实和商品原图展示" }
  });
  for (const contract of [
    "0-8秒能看懂的具体钩子",
    "危机动作、关系冲突和失败代价",
    "此前可见需求→为什么此刻使用→人物怎样使用→镜头可见的客观结果→关系或决定怎样变化",
    "不得虚构功效、价格、赠品或品牌信息"
  ]) assert.match(prompt, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), contract);
  const topics = normalizeTopicOptions({ topics: topicFixture() });
  assert.equal(topics.length, 10);
  assert.equal(new Set(topics.map(item => item.title)).size, 10);
  assert.ok(topics.every(item => item.hook && item.firstDialogue && item.logline && item.reversal && item.emotionalPayoff && item.productPlacement));
  assert.equal(scriptPipelineEntryRoute({ productionPlan: { inputMode: "ai" }, script: { raw: "" } }), "missing");
});

test("an incomplete recovered topic card cannot enter AI script writing", () => {
  const topics = normalizeTopicOptions({ topics: [{
    title: "只有标题",
    relationship: "母女",
    highlights: ["片段一", "片段二", "片段三"]
  }] }, { expectedCount: 10, allowPartial: true, enforceDiversity: false });
  assert.ok(ideaScriptBootstrapGaps({
    ideation: { topics, selectedTopicId: topics[0].id },
    productionPlan: { inputMode: "ai", commerceMode: "none" }
  }).length > 0, "missing hook/logline/reversal/payoff must block script writing locally");
});

test("AI script entry materializes a 300-second drama with opening clarity, one main line and no empty final dialogue unit", () => {
  const topic = {
    ...topicFixture()[0],
    valueStatement: "善意必须被看见，也必须用行动偿还。",
    protagonistWound: "母亲长期替女儿承担却被误解。",
    falseBelief: "沉默能保住家庭体面。",
    themeObject: "折角缴费单",
    proofChain: "急救缴费单日期、房款流水和邻居证言共同证明。",
    settlementAction: "女儿把新房钥匙交到母亲手里，当众道歉并接她回家。"
  };
  const product = { name: "羊脂皂", description: "日常清洁用品", sellingPoints: "只按用户提供事实和商品原图展示" };
  const filmSchedule = planFilmSchedule(300, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
  const ranges = directFastSegmentRanges(filmSchedule.unitCount);
  const spine = buildDirectFastFallbackSpine({ topic, ranges });
  const payload = {
    ...spine,
    spineLocked: true,
    s: ranges.flatMap(([segmentStart, segmentEnd]) => buildDirectFastFallbackSegment({
      spine,
      topic,
      segmentStart,
      segmentEnd,
      unitDurations: filmSchedule.suggestedDurations
    }).s)
  };
  const materialized = materializeDirectFastScript({ payload, topic, product, filmSchedule });
  assert.equal(materialized.rawShots.length, filmSchedule.unitCount);
  assert.equal(materialized.rawShots.reduce((sum, shot) => sum + shot.duration, 0), 300);
  const first30 = materialized.rawShots.slice(0, 3);
  const openingTurns = first30.flatMap(shot => shot.dialogueTurns || []);
  assert.ok(openingTurns.length >= 3);
  assert.ok(new Set(openingTurns.map(turn => turn.speakerId)).size >= 2);
  assert.equal(materialized.plans.filter(shot => shot.mainlineStage === "main_reversal").length, 1);
  assert.ok(materialized.rawShots.every(shot => (shot.dialogueTurns || []).length >= 1), "every final video unit must contain 1-2 complete dialogue lines");
  assert.ok(materialized.rawShots.every(shot => (shot.dialogueTurns || []).length <= 2));
  for (const shot of materialized.rawShots) {
    for (const turn of shot.dialogueTurns || []) {
      assert.ok(turn.speakerId && Array.isArray(turn.listenerIds));
      assert.ok(turn.delivery && turn.body && turn.listenerBeat);
      assert.ok(Number(turn.plannedSpeechSeconds) > 0);
      assert.ok(Number(turn.plannedAfterBeatSeconds) >= 0);
    }
    const subshots = shot.subshots || [];
    assert.equal(Number(subshots[0]?.start), 0);
    assert.equal(Number(subshots.at(-1)?.end), Number(shot.duration));
    assert.ok(subshots.every((subshot, index) => Number(subshot.end) > Number(subshot.start)
      && (index === 0 || Math.abs(Number(subshot.start) - Number(subshots[index - 1].end)) < 0.001)));
  }
  const reversalIndex = materialized.plans.findIndex(shot => shot.mainlineStage === "main_reversal");
  const firstProductIndex = materialized.rawShots.findIndex(shot => shot.productMention);
  assert.ok(firstProductIndex > reversalIndex);
});

test("uploaded-script entry preserves every authored speaker, line, scene occurrence and event before asset extraction", () => {
  const source = [
    "### S01｜场景：旧屋客厅｜0-8秒",
    "【动作】林夏从画面右侧冲入，抢走母亲手里的缴费单；母亲站在左侧，二人隔桌对视。",
    "【对白】林夏（又急又怒）：妈，你卖了老屋，还替舅舅还债？",
    "【对白】周岚（压着委屈）：那张单不是他的，是你抢救那晚的。",
    "【声音】雨声和纸张被夺声。",
    "【承接】林夏低头看见缴费日期。",
    "### S02｜场景：旧屋客厅｜8-18秒",
    "【动作】林夏把单据铺在桌上，手指停在到账日期；周岚仍在左侧，没有换位。",
    "【对白】林夏（声音发紧）：房款，全进了我的急救账户？",
    "【对白】周岚（轻声落锤）：你的命，比那间老屋值钱。",
    "【声音】雨声连续，纸张轻响。",
    "【承接】门外传来邻居敲门声。",
    "### S03｜场景：旧屋门厅｜18-30秒",
    "【动作】陈姨从门外进入画面左后方，把房款流水放到林夏面前；周岚退到右后方。",
    "【对白】陈姨（急促作证）：日期、签名都在，我陪她办的。",
    "【对白】林夏（愧疚但果断）：妈，我现在就把新房钥匙还给你。",
    "【声音】敲门声后接脚步与钥匙落桌声。",
    "【承接】林夏把钥匙推到周岚手边。"
  ].join("\n");
  const ledger = productionDialogueLedgerFromScript(source);
  const scenes = buildSourceSceneLedger(source, { acceptStandardShotHeading: true });
  assert.equal(ledger.length, 6);
  assert.deepEqual(ledger.map(item => item.speaker), ["林夏", "周岚", "林夏", "周岚", "陈姨", "林夏"]);
  const parity = uploadedFormatAdaptationValidation(source, ledger, scenes, source);
  assert.equal(parity.ok, true, JSON.stringify(parity));
  const aiFirst = aiFirstUploadStandardizationValidation({
    productionScript: source,
    sourceAudit: {
      sceneOccurrenceCount: 3,
      dialogueCount: 6,
      sceneOccurrences: ["旧屋客厅", "旧屋客厅", "旧屋门厅"],
      preservedAllDialogue: true,
      preservedAllScenes: true,
      preservedAllActions: true,
      preservedEventOrder: true,
      noInventedDialogue: true
    }
  });
  assert.equal(aiFirst.ok, true, JSON.stringify(aiFirst));
  const local = localUploadedAnalysisChunk({
    index: 0,
    text: source,
    unitCount: 3,
    durations: [8, 10, 12],
    sourceDialogueLedger: ledger,
    sourceSceneLedger: scenes
  }, { productionPlan: { inputMode: "manual" }, generation: { engine: "hailuo-h3", mode: "keyframe" } });
  const normalized = conformImportedAnalysisToDurationContract(local, {
    productionPlan: { inputMode: "manual" },
    generation: { engine: "hailuo-h3", mode: "keyframe", targetDurationSeconds: 30 },
    script: { raw: source }
  }, { adaptiveTargetSeconds: 30 });
  assert.deepEqual(normalized.shots.flatMap(shot => shot.dialogueTurns || []).map(turn => turn.text), ledger.map(item => item.text));
  assert.ok(normalized.shots.every(shot => (shot.dialogueTurns || []).length >= 1));
  assert.equal(scriptPipelineEntryRoute({ productionPlan: { inputMode: "manual" }, script: { raw: source } }), "analyze_imported");
});
