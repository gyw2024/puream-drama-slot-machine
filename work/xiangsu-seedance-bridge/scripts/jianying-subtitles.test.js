"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSubtitles, toSrt, splitCaptionText } = require("../app/jianying-subtitles");

const timeline = (durationSeconds = 10, trimStartSeconds = 0, startSeconds = 0) => [{ shotId: "S01", startSeconds, durationSeconds, trimStartSeconds }];
const project = (turns, shotFields = {}) => ({ outputPreferences:{subtitles:true}, characters: [{ id: "C01", name: "苏晴" }, { id: "C02", name: "林远" }], shots: [{ id: "S01", dialogueTurns: turns, ...shotFields }] });
const turn = (text, fields = {}) => ({ speakerId: "C01", text, ...fields });
function assertBounds(result, maxSeconds) {
  let end = 0;
  for (const item of result.subtitles) {
    assert.ok(Number.isSafeInteger(item.startUs));
    assert.ok(Number.isSafeInteger(item.durationUs));
    assert.ok(item.startUs >= end);
    assert.ok(item.durationUs > 0);
    assert.ok(item.startUs + item.durationUs <= maxSeconds * 1000000);
    assert.ok(Array.from(item.text).length <= 18);
    end = item.startUs + item.durationUs;
  }
}

test("uses canonical ledger once, deduplicates same ID copies, keeps intentional repeats", () => {
  const a = turn("你回来！", { sourceDialogueId: "D001", startSecond: 0.5, endSecond: 1.5 });
  const b = turn("你回来！", { sourceDialogueId: "D002", startSecond: 2, endSecond: 3 });
  const result = buildSubtitles(project([a, { ...a }, b], { subshots: [{ dialogueTurns: [a, b] }] }), timeline());
  assert.deepEqual(result.subtitles.map(item => item.text), ["你回来！", "你回来！"]);
  assert.equal(result.subtitles[0].speaker, "苏晴");
  assert.equal(result.timingSource, "planned");
  assert.match(result.warnings.join(""), /重复对白账本/);
});

test("punctuation-aware splitting preserves all text and never exceeds 18 characters", () => {
  const text = "这些年我在外面拼命挣钱，只想让你们过上好日子。可是你为什么宁愿相信外人，也不肯听我说一句话？";
  const chunks = splitCaptionText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every(item => Array.from(item).length <= 18));
  const result = buildSubtitles(project([turn(text)]), timeline(10));
  assert.equal(result.subtitles.map(item => item.text).join(""), text);
  assert.equal(result.timingSource, "estimated-5.5cps");
  assertBounds(result, 10);
});

test("rebalance long multiple-speaker lines without lost text or overlapping subtitles", () => {
  const texts = ["你凭什么认为我会为了钱出卖自己的亲人？", "我没有这个意思，可是那份合同明明白白写着你的名字！"];
  const result = buildSubtitles(project(texts.map((text, index) => turn(text, { speakerId: index ? "C02" : "C01" }))), timeline(2));
  assert.equal(result.subtitles.map(item => item.text).join(""), texts.join(""));
  assert.deepEqual([...new Set(result.subtitles.map(item => item.speaker))], ["苏晴", "林远"]);
  assert.match(result.warnings.join(""), /超过镜头长度/);
  assertBounds(result, 2);
});

test("remaps source planned speech windows through a head trim", () => {
  const result = buildSubtitles(project([turn("请你听我解释！", { startSecond: 1, endSecond: 3 })]), timeline(8, 0.5, 4));
  assert.equal(result.subtitles[0].startUs, 4500000);
  assert.equal(result.subtitles[0].durationUs, 2000000);
  assertBounds(result, 12);
});

test("does not fabricate speech fully removed by trim and warns about partial cuts", () => {
  const result = buildSubtitles(project([turn("喂！", { startSecond: 0, endSecond: 0.2 }), turn("别走！", { startSecond: 0.25, endSecond: 1 })]), timeline(5, 0.5));
  assert.deepEqual(result.subtitles.map(item => item.text), ["别走！"]);
  assert.equal(result.subtitles[0].startUs, 0);
  assert.match(result.warnings.join(""), /穿过对白/);
  assert.match(result.warnings.join(""), /裁剪区间/);
});

test("trusts word timestamps only with complete lexical match and retains script punctuation", () => {
  const result = buildSubtitles(project([turn("你回来！"), turn("我不走。", { speakerId: "C02" })], {
    asrResult: { confidence: 0.96, words: [
      { word: "你", start: 1, end: 1.3 }, { word: "回来", start: 1.3, end: 2 },
      { word: "我", start: 3, end: 3.3 }, { word: "不走", start: 3.3, end: 4 }
    ] }
  }), timeline());
  assert.equal(result.timingSource, "asr-word-interpolated");
  assert.deepEqual(result.subtitles.map(item => [item.text, item.startUs, item.durationUs]), [["你回来！", 1000000, 1000000], ["我不走。", 3000000, 1000000]]);
});

test("recognition mismatch cannot overwrite the exact dialogue ledger", () => {
  const result = buildSubtitles(project([turn("钱不是我拿的！")], { asrResult: { segments: [{ text: "钱是我拿的", start: 0.5, end: 2 }] } }), timeline());
  assert.equal(result.subtitles[0].text, "钱不是我拿的！");
  assert.equal(result.timingSource, "estimated-5.5cps");
  assert.match(result.warnings.join(""), /识别文本与完整对白账本不一致/);
});

test("stale recognition from another reroll candidate is rejected even when words match", () => {
  const result = buildSubtitles(project([turn("回来！")], { asrResult: { sourceCandidateId: "old", words: [{ word: "回来", start: 1, end: 2 }] } }), [{ ...timeline()[0], sourceCandidateId: "new" }]);
  assert.equal(result.timingSource, "estimated-5.5cps");
  assert.match(result.warnings.join(""), /不属于当前视频候选/);
});

test("sorts unsorted selected shots by their explicit timeline time", () => {
  const data = { outputPreferences:{subtitles:true}, shots: [{ id: "S01", dialogueTurns: [turn("第一句。")] }, { id: "S02", dialogueTurns: [turn("第二句。")] }] };
  const result = buildSubtitles(data, [{ shotId: "S02", startSeconds: 5, durationSeconds: 5 }, { shotId: "S01", startSeconds: 0, durationSeconds: 5 }]);
  assert.deepEqual(result.subtitles.map(item => item.text), ["第一句。", "第二句。"]);
  assertBounds(result, 10);
});

test("rejects low confidence, overlapping, generated and out-of-range recognition", () => {
  for (const asrResult of [
    { confidence: 0.4, words: [{ word: "回来", start: 1, end: 2 }] },
    { words: [{ word: "回", start: 1, end: 2 }, { word: "来", start: 1.5, end: 2.5 }] },
    { generated: true, words: [{ word: "回来", start: 1, end: 2 }] },
    { segments: [{ text: "回来", start: 1, end: 20 }] }
  ]) {
    const result = buildSubtitles(project([turn("回来！")], { asrResult }), timeline());
    assert.equal(result.timingSource, "estimated-5.5cps");
    assert.match(result.warnings.join(""), /识别时间戳未采用/);
  }
});

test("absent or authoritative-empty dialogue returns useful warning without errors", () => {
  for (const fields of [{}, { dialogue: "苏晴：回来！", dialogueTurnsAuthoritative: true }]) {
    const result = buildSubtitles(project([], fields), timeline());
    assert.equal(result.subtitles.length, 0);
    assert.equal(result.timingSource, "none");
    assert.match(result.warnings.join(""), /不编造字幕/);
  }
});

test("falls back to legacy structured subshots and honors explicit dialogue override", () => {
  const fallback = buildSubtitles(project([], { subshots: [{ dialogueTurns: [turn("你来了。", { startSecond: 1, endSecond: 2 })] }] }), timeline());
  assert.equal(fallback.subtitles[0].text, "你来了。");
  const override = buildSubtitles(project([turn("旧台词。")], { videoPromptDialogueOverride: "苏晴：你终于来了。" }), timeline());
  assert.equal(override.subtitles[0].text, "你终于来了。");
});

test("legacy dialogue array survives real WorkbenchStore roundtrip instead of becoming object text", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { WorkbenchStore } = require("../app/workbench-store");
  const evidence = path.join(__dirname, "..", ".codex_tests", "TASK-20260905-DRAMA-JIANYING-DRAFT-001", "subtitle-store");
  fs.mkdirSync(evidence, { recursive: true });
  const store = new WorkbenchStore(fs.mkdtempSync(path.join(evidence, "roundtrip-")));
  const saved = store.createProject("字幕旧结构兼容性隔离测试");
  saved.characters = [{ id: "C01", name: "顾云舟" }];
  saved.shots = [{ id: "S01", number: 1, duration: 12, dialogue: [{ speaker: "顾云舟", characterId: "C01", text: "我回来，是想把当年的误会说清楚。", startSeconds: 1, endSeconds: 5 }] }];
  store.saveProject(saved);
  const result = buildSubtitles({...store.getProject(saved.id),outputPreferences:{subtitles:true}}, timeline(12));
  assert.equal(result.subtitles.map(item => item.text).join(""), saved.shots[0].dialogue[0].text);
  assert.equal(result.timingSource, "planned");
  assert.equal(result.subtitles[0].startUs, 1000000);
  assert.equal(result.subtitles[0].speaker, "顾云舟");
});

test("undefined override does not erase ledger but intentional empty override does", () => {
  const data = project([turn("留下来吧。")], { videoPromptDialogueOverride: undefined });
  assert.equal(buildSubtitles(data, timeline()).subtitles[0].text, "留下来吧。");
  data.shots[0].videoPromptDialogueOverride = "";
  assert.equal(buildSubtitles(data, timeline()).subtitles.length, 0);
});

test("invalid planned windows are rebalanced instead of emitting out-of-range timestamps", () => {
  const result = buildSubtitles(project([turn("先听我说。", { startSecond: 0, endSecond: 8, plannedSpeechSeconds: 2 }), turn("你说吧。", { startSecond: 4, endSecond: 9, plannedSpeechSeconds: 1 })]), timeline(5));
  assert.equal(result.timingSource, "planned-rebalanced");
  assertBounds(result, 5);
});

test("external schedule must match current text rather than number of turns alone", () => {
  const stale = buildSubtitles(project([turn("新台词。")], { speechSchedule: [{ text: "旧台词。", start: 4, end: 5 }] }), timeline());
  assert.equal(stale.timingSource, "estimated-5.5cps");
  const current = buildSubtitles(project([turn("新台词。")], { speechSchedule: [{ text: "新台词。", start: 4, end: 5 }] }), timeline());
  assert.equal(current.timingSource, "planned");
  assert.equal(current.subtitles[0].startUs, 4000000);
});

test("SRT uses microsecond timebase and editable text without speaker prefixes", () => {
  const srt = toSrt([{ text: "你好！", speaker: "苏晴", startUs: 3723004000, durationUs: 1200000 }]);
  assert.equal(srt, "1\r\n01:02:03,004 --> 01:02:04,204\r\n你好！\r\n");
  assert.equal(toSrt([]), "");
  assert.doesNotMatch(srt, /苏晴/);
});
