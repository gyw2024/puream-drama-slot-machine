"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseSourceDialogueLedger, parseSpeakerLabel } = require("../app/dialogue-parser");
const { buildSourceSceneLedger } = require("../app/script-scene-ledger");
const {
  localUploadedAnalysisChunk,
  parseStructuredProductionScript,
  bindSourceDialogueLedgerToAnalysis,
  normalizeAnalysis,
  applyUploadedProductBindings,
  conformImportedAnalysisToDurationContract
} = require("../app/workbench-workflow");

test("production field labels are not speakers", () => {
  assert.equal(parseSpeakerLabel("本单元叙事任务"), null);
  assert.equal(parseSpeakerLabel("转场"), null);
  assert.equal(parseSpeakerLabel("首帧"), null);
  const ledger = parseSourceDialogueLedger([
    "### S01｜10秒｜厨房",
    "- 本单元叙事任务：母亲拿出缴费单",
    "- 转场：客厅",
    "苏妈（发颤）：缴费单在这儿。"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => item.speaker), ["苏妈"]);
  assert.deepEqual(ledger.map(item => item.text), ["缴费单在这儿。"]);
});

test("dialogue before the first S01 heading is kept", () => {
  const ledger = parseSourceDialogueLedger([
    "【场景】厨房",
    "林娜（压低声音）：你来了。",
    "### S01｜近景",
    "秦深（坐下）：把单子给我。"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => item.text), ["你来了。", "把单子给我。"]);
});

test("slash-separated speakers on one line are split", () => {
  const ledger = parseSourceDialogueLedger("苏远（怒）：缴费单呢。 / 苏妈（颤）：我收着。");
  assert.deepEqual(ledger.map(item => `${item.speaker}:${item.text}`), ["苏远:缴费单呢。", "苏妈:我收着。"]);
});

test("scene lists and time suffixes do not become dirty or fake places", () => {
  const listed = buildSourceSceneLedger("【场景】老小区客厅、老小区楼道、银行大厅");
  assert.deepEqual(listed.catalogue.map(item => item.name), ["老小区客厅", "老小区楼道", "银行大厅"]);
  const timed = buildSourceSceneLedger("### SC01 苏妈厨房｜傍晚\n苏妈：先吃饭。");
  assert.ok(timed.catalogue.every(item => !/傍晚|白天|夜晚/.test(item.name)));
  assert.ok(timed.catalogue.some(item => item.name.includes("苏妈厨房")));
  const dashTransition = buildSourceSceneLedger("【场景】厨房\n- 转场：客厅\n苏妈：过来。");
  assert.ok(dashTransition.catalogue.some(item => item.name === "客厅"));
});

test("local fallback keeps multiple scenes and core props from bracket lists", () => {
  const raw = [
    "【场景】老小区客厅",
    "物品：@房产证 @手机 @茶杯",
    "【核心道具】房产证",
    "周宁（压着火）：妈，房产证呢？",
    "【场景】银行大厅",
    "周桂兰（发颤）：我没卖房子。"
  ].join("\n");
  const data = localUploadedAnalysisChunk({
    index: 0,
    text: raw,
    unitCount: 2,
    durations: [10, 10],
    sourceDialogueLedger: parseSourceDialogueLedger(raw),
    sourceSceneLedger: buildSourceSceneLedger(raw)
  });
  assert.ok(data.scenes.some(item => item.name.includes("老小区客厅")));
  assert.ok(data.scenes.some(item => item.name.includes("银行大厅")));
  assert.ok(data.props.some(item => item.name === "房产证"));
  assert.ok(!data.props.some(item => item.name === "手机" || item.name === "茶杯"));
});

test("a 对白 prefix does not swallow the first speaker on the same line", () => {
  const ledger = parseSourceDialogueLedger([
    "### S01｜10秒｜楼梯口",
    "- 对白：周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。",
    "周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => `${item.speaker}:${item.text}`), [
    "周妈:饭还热着。",
    "陈晓:你别上来了。"
  ]);
  assert.equal(ledger[0].sourceShotId, "S01");
  assert.equal(ledger[1].sourceShotId, "S01");
});

test("subshot cue lines do not mint extra dialogue with sound suffixes", () => {
  const ledger = parseSourceDialogueLedger([
    "### S01｜10秒｜楼梯口",
    "- 对白：周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。",
    "- subshot 1｜0.0-3.0秒｜近景：周妈扶栏杆；对白：周妈：饭还热着。；声音：楼梯回声"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => `${item.speaker}:${item.text}`), [
    "周妈:饭还热着。",
    "陈晓:你别上来了。"
  ]);
});

test("structured production script still parses official C/SC/S headings", () => {
  const raw = [
    "### C01 林夏",
    "- 28岁职场女性",
    "### SC01 会议室",
    "- 白天会议室",
    "### S01｜10秒｜会议室",
    "- 人物：C01",
    "- 场景：SC01",
    "- 动作：林夏换上黑色西装把录音笔立在桌上",
    "- 对白：林夏（冷静）：你听完再拦。",
    "林夏（冷静）：你听完再拦。",
    "### S02｜10秒｜会议室",
    "- 人物：C01",
    "- 场景：SC01",
    "- 动作：她按下录音笔播放封口费",
    "- 对白：林夏（肯定）：车库里，亲口。",
    "林夏（肯定）：车库里，亲口。"
  ].join("\n");
  const structured = parseStructuredProductionScript(raw);
  assert.ok(structured);
  assert.equal(structured.characters[0].name, "林夏");
  assert.equal(structured.shots.length, 2);
});

test("explicit 商品不出现 and authored 人物 survive dialogue rebinding", () => {
  const raw = [
    "### C01 周妈",
    "### C02 陈晓",
    "### SC01 楼梯口",
    "### SC02 客厅",
    "### S01｜10秒｜楼梯口",
    "- 人物：C01 C02",
    "- 场景：SC01 楼梯口",
    "- 动作：周妈被拦在门口",
    "- 对白：周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。",
    "- 商品：不出现",
    "### S02｜10秒｜客厅",
    "- 人物：C01 C02",
    "- 场景：SC02 客厅",
    "- 动作：周建把硅胶护膝戴上母亲右膝",
    "- 对白：周妈（看着）：这是护膝。",
    "- 商品：出现：硅胶护膝"
  ].join("\n");
  const structured = parseStructuredProductionScript(raw);
  const ledger = parseSourceDialogueLedger(raw, ["周妈", "陈晓"]);
  const bound = bindSourceDialogueLedgerToAnalysis({
    ...structured,
    sourceDialogueLedger: ledger
  }, ledger);
  const project = {
    product: { name: "硅胶护膝", description: "保护膝盖半月板损伤", sellingPoints: "保护膝盖半月板损伤" },
    generation: { targetDurationSeconds: 20, shotDuration: 10, engine: "hailuo-h3" },
    productionPlan: { inputMode: "manual", commerceShotCount: 1 }
  };
  const normalized = conformImportedAnalysisToDurationContract(bound, project, { adaptiveTargetSeconds: 20 });
  assert.deepEqual(normalized.shots[0].characterNames, ["周妈", "陈晓"]);
  assert.deepEqual(normalized.shots[0].dialogueTurns.map(item => item.text), ["饭还热着。", "你别上来了。"]);
  assert.equal(normalized.shots[0].productMention, false);
  assert.equal(normalized.shots[1].productMention, true);
  assert.ok((normalized.shots[1].productBinding?.matchedTokens || []).includes("护膝"));
});
