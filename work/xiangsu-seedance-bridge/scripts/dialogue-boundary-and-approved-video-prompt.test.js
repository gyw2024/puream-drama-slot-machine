"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { parseSourceDialogueLedger } = require("../app/dialogue-parser");
const { defaultSettings } = require("../app/workbench-store");
const { planFilmSchedule } = require("../app/duration-contract");
const {
  buildDirectFastFallbackSegment,
  buildDirectFastFallbackSpine,
  directFastSegmentRanges,
  materializeDirectFastScript
} = require("../app/direct-fast-script");
const {
  WorkbenchWorkflow,
  bindSourceDialogueLedgerToAnalysis,
  assertSourceDialogueParity,
  normalizeAnalysis,
  renderApprovedVideoPrompt
} = require("../app/workbench-workflow");

const SCRIPT = `# 边界测试

## 主要人物
- 周桂兰：母亲
- 林晓梅：女儿

## 场景背景
- 家庭客厅：门口与茶几关系明确

### S01｜00:00–00:08｜家庭客厅
【背景/动作：周桂兰推开砸摊人的手，挡在女儿身前。】
周桂兰（压着急火；“住手”重读；手掌护住女儿）：住手！有话冲我来！
林晓梅（带哭腔；尾音发颤；攥住母亲衣角）：妈，摊子砸了，我们怎么办？

### S02｜00:08–00:16｜家庭客厅
【背景/动作：周桂兰捡起送货单，林晓梅看见收款日期。】
林晓梅（先疑惑后发紧；“日期”加重；手指停在纸面）：这日期，明明是他收的钱。
周桂兰（气息压低；短停后落锤；抬眼盯住门口）：所以欠债的人不是你爸。

### S03｜00:16–00:24｜社区工作室
【无对白：两人闭口核对材料，用表情、视线和动作完成本镜。】
【商品动作：便携折叠台灯只按用户上传原图进入当前剧情动作。】`;

function analysisFixture() {
  return {
    characters: [
      { id: "C01", name: "周桂兰" },
      { id: "C02", name: "林晓梅" }
    ],
    shots: [
      {
        id: "S01",
        duration: 8,
        scene: "家庭客厅",
        visibleCharacterIds: ["C01", "C02"],
        action: "周桂兰推开砸摊人的手，挡在女儿身前",
        emotion: "急火压住→女儿哭问→母亲心口发紧→护住女儿",
        stateAfter: "母女站到同一边",
        sourceDialogueBindings: [{ sourceDialogueId: "D003", subshotNumber: 1 }],
        subshots: [
          { start: 0, end: 3, action: "周桂兰（对林晓梅说；压着急火）：这行不是动作，不能复述。" },
          { start: 3, end: 6 },
          { start: 6, end: 8 }
        ]
      },
      {
        id: "S02",
        duration: 8,
        scene: "家庭客厅",
        visibleCharacterIds: ["C01", "C02"],
        action: "两人看见送货单上的收款日期",
        emotion: "疑惑→看清日期→声音发紧→真相落地",
        stateAfter: "债务关系被改写",
        sourceDialogueBindings: [{ sourceDialogueId: "D001", subshotNumber: 1 }],
        subshots: [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 8 }]
      },
      { id: "S03", duration: 8, scene: "社区工作室", action: "闭口核对材料", subshots: [] }
    ]
  };
}

test("structured screenplay metadata never enters the immutable dialogue ledger", () => {
  const ledger = parseSourceDialogueLedger(SCRIPT);
  assert.equal(ledger.length, 4);
  assert.deepEqual([...new Set(ledger.map(item => item.speaker))], ["周桂兰", "林晓梅"]);
  assert.deepEqual(ledger.map(item => item.sourceShotId), ["S01", "S01", "S02", "S02"]);
  assert.deepEqual(ledger.map(item => item.text), [
    "住手！有话冲我来！",
    "妈，摊子砸了，我们怎么办？",
    "这日期，明明是他收的钱。",
    "所以欠债的人不是你爸。"
  ]);
  const blob = JSON.stringify(ledger);
  assert.doesNotMatch(blob, /00:00|家庭客厅|背景\/动作|无对白|商品动作|便携折叠台灯/);
});

test("source Sxx ownership repairs cross-shot model bindings locally", () => {
  const ledger = parseSourceDialogueLedger(SCRIPT);
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(), ledger);
  assert.deepEqual(bound.shots[0].dialogueTurns.map(turn => turn.text), ledger.slice(0, 2).map(item => item.text));
  assert.deepEqual(bound.shots[1].dialogueTurns.map(turn => turn.text), ledger.slice(2, 4).map(item => item.text));
  assert.equal(bound.shots[2].dialogueTurns.length, 0);
  assert.equal(assertSourceDialogueParity(bound, ledger), true);
});

test("video prompt preview follows the approved dialogue-first Chinese timeline", () => {
  const ledger = parseSourceDialogueLedger(SCRIPT);
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(), ledger);
  const project = {
    characters: bound.characters,
    scenes: [{ id: "SC01", name: "家庭客厅" }],
    product: { name: "便携折叠台灯" },
    shots: bound.shots
  };
  const prompt = renderApprovedVideoPrompt(project, bound.shots[0]);
  assert.match(prompt, /对白内容＞语气＞情绪＞场景＞运镜＞其他/);
  assert.equal(prompt.split("住手！有话冲我来！").length - 1, 1);
  assert.equal(prompt.split("妈，摊子砸了，我们怎么办？").length - 1, 1);
  assert.match(prompt, /周桂兰面向林晓梅/);
  assert.match(prompt, /林晓梅面向周桂兰/);
  assert.match(prompt, /周桂兰闭口/);
  assert.match(prompt, /林晓梅闭口/);
  assert.match(prompt, /压着急火/);
  assert.match(prompt, /带哭腔/);
  assert.match(prompt, /当前说话人开口时其他人物闭口/);
  assert.doesNotMatch(prompt, /这行不是动作，不能复述/);
  assert.doesNotMatch(prompt, /subject_definitions|retention_analysis/);
});

test("five-minute text pipeline produces clean assets, storyboards and dialogue-first video prompts", () => {
  const startedAt = performance.now();
  const baseTopic = {
    id: "TOPIC_01",
    title: "替父还债的女儿",
    relationship: "父女、叔侄",
    hook: "叔叔掀翻早餐摊。",
    logline: "叔叔砸摊逼债，女儿护父被学校停课；父亲藏下的送货单证实叔叔早已收款，女儿当众调监控追款复学。",
    proofChain: "送货单、监控、收款记录",
    reversal: "债主才是欠款人",
    emotionalPayoff: "父女重开早餐摊",
    themeObject: "送货单",
    valueStatement: "亲情不能纵容侵占。"
  };
  const topics = Array.from({ length: 10 }, (_, index) => ({
    ...baseTopic,
    id: `TOPIC_${String(index + 1).padStart(2, "0")}`,
    title: index === 0 ? baseTopic.title : `${baseTopic.title}·备选冲突${index + 1}`
  }));
  const topic = topics[0];
  const product = {
    name: "便携折叠台灯",
    description: "一款适合床头阅读、书桌临时补光和出差收纳的便携折叠台灯。",
    sellingPoints: "三档亮度；可折叠收纳；Type-C充电；适合床头阅读；轻巧便携",
    imagePath: "D:/test-inputs/portable-folding-lamp.png"
  };
  const schedule = planFilmSchedule(300, "local-xiangsu", { engine: "seedance", preferredUnit: 10 });
  const ranges = directFastSegmentRanges(schedule.unitCount);
  const spine = buildDirectFastFallbackSpine({ topic, ranges });
  const payload = {
    ...spine,
    spineLocked: true,
    s: ranges.flatMap(([segmentStart, segmentEnd]) => buildDirectFastFallbackSegment({
      spine,
      topic,
      segmentStart,
      segmentEnd,
      unitDurations: schedule.suggestedDurations,
      productStartNumber: Math.max(1, schedule.unitCount - 2)
    }).s)
  };
  const materialized = materializeDirectFastScript({ payload, topic, product, filmSchedule: schedule });
  const normalized = normalizeAnalysis({
    story: materialized.storyBible.story,
    characters: materialized.storyBible.characters,
    scenes: materialized.storyBible.scenes,
    shots: materialized.rawShots
  }, {
    product,
    generation: { engine: "seedance", mode: "storyboard_sheet", targetDurationSeconds: 300, aspectRatio: "9:16" }
  });
  const project = {
    product,
    generation: { engine: "seedance", mode: "storyboard_sheet", targetDurationSeconds: 300, aspectRatio: "9:16" },
    characters: normalized.characters,
    scenes: normalized.scenes,
    shots: normalized.shots,
    assetLibraries: { wardrobes: [], props: [] },
    script: { sourceDialogueLedger: [] }
  };
  const settings = defaultSettings();
  const workflow = WorkbenchWorkflow.prototype;
  const characterPrompts = project.characters.map(character => workflow.compileImagePrompt.call({}, project, settings, "character_sheet", character));
  const scenePrompts = project.scenes.map(scene => workflow.compileImagePrompt.call({}, project, settings, "scene_asset", scene));
  const storyboardPrompts = project.shots.map(shot => workflow.compileImagePrompt.call({}, project, settings, "storyboard_sheet", shot));
  const videoPrompts = project.shots.map(shot => renderApprovedVideoPrompt(project, shot));
  const turns = project.shots.flatMap(shot => shot.dialogueTurns || []);

  assert.equal(topics.length, 10);
  assert.equal(new Set(topics.map(item => item.title)).size, 10);
  assert.equal(topic.id, "TOPIC_01");
  assert.equal(project.shots.length, 30);
  assert.ok(project.characters.length >= 3 && project.characters.length <= 5);
  assert.ok(turns.length >= 60);
  assert.equal(characterPrompts.length, project.characters.length);
  assert.equal(scenePrompts.length, project.scenes.length);
  assert.equal(storyboardPrompts.length, 30);
  assert.equal(videoPrompts.length, 30);
  assert.ok(characterPrompts.every(prompt => /只表现一个角色|人物资产/.test(prompt)));
  assert.ok(scenePrompts.every(prompt => /无人|空场景/.test(prompt)));
  assert.ok(storyboardPrompts.every(prompt => /对白表演画面|本镜无台词/.test(prompt)));
  assert.ok(videoPrompts.every(prompt => prompt.includes("对白内容＞语气＞情绪＞场景＞运镜＞其他")));
  const productShotIndexes = project.shots.map((shot, index) => shot.productMention ? index : -1).filter(index => index >= 0);
  assert.ok(productShotIndexes.length > 0);
  assert.ok(productShotIndexes.every(index => videoPrompts[index].includes(product.name)));
  project.shots.forEach((shot, index) => {
    for (const turn of shot.dialogueTurns || []) {
      const quotedSpeech = `说：“${turn.text}”`;
      assert.equal(videoPrompts[index].split(quotedSpeech).length - 1, 1, `${shot.id}:${turn.text}`);
    }
  });
  assert.doesNotMatch(videoPrompts.join("\n"), /subject_definitions|retention_analysis|【(?:背景\/动作|无对白|商品动作)[：:][^\n]*说：“/);
  if (process.env.SHOW_DIALOGUE_FIRST_SAMPLE === "1") {
    const sampleIndex = crypto.randomInt(videoPrompts.length);
    console.log(JSON.stringify({
      topics: topics.length,
      selectedTopic: topic.title,
      productBound: Boolean(product.imagePath && product.description),
      scriptShots: project.shots.length,
      dialogueTurns: turns.length,
      assetPrompts: characterPrompts.length + scenePrompts.length,
      storyboardPrompts: storyboardPrompts.length,
      videoPrompts: videoPrompts.length,
      sampledShot: project.shots[sampleIndex].id,
      textPipelineMs: Math.round(performance.now() - startedAt)
    }, null, 2));
    console.log(videoPrompts[sampleIndex]);
  }
});
