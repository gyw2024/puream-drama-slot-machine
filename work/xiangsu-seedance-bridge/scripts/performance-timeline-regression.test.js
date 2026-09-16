"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { planPerformanceTimeline, performanceTimelineFailures } = require("../app/drama-performance-timeline");
test("allows concurrent actions without forcing extra silent time or losing dialogue", () => {
  const turns = [{ text: "一".repeat(40) }, { text: "二".repeat(30) }];
  const p = planPerformanceTimeline(turns, 14);
  assert.equal(p.duration, 14);
  assert.ok(p.visualReserveSeconds >= .65);
  assert.ok(p.visualReserveSeconds < 3);
  assert.deepEqual(performanceTimelineFailures({duration:p.duration,dialogueTurns:turns.map((t,i)=>({...t,...p.windows[i]}))}), []);
});
test("overcapacity requires a complete-line split, never silent compression", () => {
  assert.throws(()=>planPerformanceTimeline([{text:"一".repeat(100)}], 15), {code:"PERFORMANCE_REQUIRES_SPLIT"});
});
test("At timestamp headers cannot hide a mid-sentence cut or drift", () => {
  const s = {duration:10,dialogueTurns:[{text:"一二三四五六七八九十",start:1,end:3,speakerId:"C01"}]};
  const p = "[Shot 1] From 0 to 2 seconds, From 1.00 to 3.00 seconds, <d>[Chinese] 一二三四五六七八九十</d>\n[Shot 2] At 00:02.000, From 2 to 10 seconds, reaction";
  assert.ok(performanceTimelineFailures(s,p).some(x=>x.includes("camera cut")));
  assert.ok(performanceTimelineFailures(s,p.replace("From 1.00 to 3.00", "From 1.2 to 3.2")).some(x=>x.includes("differ")));
});
test("same visible actor cannot be both silent and speaking", () => {
  const s={duration:10,dialogueTurns:[{text:"一二三四五六七八九十",start:1,end:3,speakerId:"C01"}],actionBeats:[{start:2,end:4,silentCharacterIds:["C01"]}]};
  assert.ok(performanceTimelineFailures(s).some(x=>x.includes("marked silent")));
});
test("every utterance inside the same official camera line is checked", () => {
  const shot={duration:10,dialogueTurns:[{text:'一二三四五六七八九十',start:1,end:3},{text:'甲乙丙丁戊己庚辛壬癸',start:5,end:7}]};
  const prompt='[Shot 1] From 0 to 10 seconds, From 1 to 3 seconds, <d>[Chinese] 一二三四五六七八九十</d> From 5 to 7 seconds, <d>[Chinese] 甲乙丙丁戊己庚辛壬癸</d>';
  assert.deepEqual(performanceTimelineFailures(shot,prompt),[]);
  assert.ok(performanceTimelineFailures(shot,prompt+' From 8 to 9 seconds, <d>[Chinese] 甲乙丙丁戊己庚辛壬癸</d>').some(x=>x.includes('extra or repeated')));
});
test('generated English rhetoric cannot change source speech rate or cache inputs',()=>{
 const {speechRatePolicy}=require('../app/drama-timing');
 const original={text:'那半小时，他在帮我。',sourceTone:'坚定而清晰'};
 assert.equal(speechRatePolicy(original).kind,'dialogue');
 assert.deepEqual(speechRatePolicy({...original,deliveryEn:'Firmly reveals the truth as a counterattack',vocalArcEn:'Peak with accusatory pressure'}),speechRatePolicy(original));
 assert.equal(speechRatePolicy({text:'你给我解释！',sourceTone:'愤怒质问'}).kind,'argument');
});
test('screen-text cleanup preserves real timing and three-quarter facing',()=>{
 const {sanitizeVisualPromptCue}=require('../app/hailuo-h3-natural-prompt');
 const valid='0.30秒闭口，动作持续1.80秒，保持四分之三侧面';
 assert.equal(sanitizeVisualPromptCue(valid),valid);
 assert.equal(sanitizeVisualPromptCue('手机计时器显示30秒'),'等待结束');
});
