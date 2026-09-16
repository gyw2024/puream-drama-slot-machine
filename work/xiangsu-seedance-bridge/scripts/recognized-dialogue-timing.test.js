const test = require('node:test'), assert = require('node:assert/strict');
const {alignRecognizedDialogue} = require('../app/recognized-dialogue-timing');
test('actual late line boundaries remain distinct from planned speaker windows', () => {
  const turns = [{id:'D1',speakerId:'C02',text:'你赔得起吗？',startSecond:2.58,endSecond:6.96},{id:'D2',speakerId:'C01',text:'我就站这儿。',startSecond:8.25,endSecond:12.43}];
  const recognition = {words:[{word:'你赔得起吗',start:2.72,end:10.38},{word:'我就站这儿',start:10.47,end:15.03}]};
  const before = JSON.stringify(recognition), result = alignRecognizedDialogue(turns,recognition);
  assert.equal(result.turns[0].observedEnd,10.38); assert.equal(result.turns[1].observedStart,10.47);
  assert.equal(result.turns[1].startDeviation,2.22); assert.equal(result.turns[0].speakerId,'C02');
  assert.equal(result.turns[0].alignmentStatus,'exact_text_alignment'); assert.equal(JSON.stringify(recognition),before);
});
test('ASR homophones and missing characters are not silently rewritten or approved', () => {
  const r = alignRecognizedDialogue([{id:'D1',text:'避雨，这儿。'}],{words:[{word:'碧雨这',start:1,end:2}]});
  assert.equal(r.editDistance,2); assert.equal(r.turns[0].alignmentStatus,'uncertain_text_alignment');
  assert.equal(r.turns[0].exactCharacterMatches,2);
});
test('a repeated utterance is not assigned one confident speech interval', () => {
  const r = alignRecognizedDialogue([{text:'你是谁'}],{words:[{word:'你是谁',start:1,end:2},{word:'你是谁',start:3,end:4}]});
  assert.equal(r.turns[0].repeatedTextInRecognition,true); assert.equal(r.turns[0].alignmentStatus,'uncertain_text_alignment');
});
test('empty or invalid word timing does not manufacture observed windows', () => {
  assert.equal(alignRecognizedDialogue([{text:'你好'}],{words:[]}).status,'uncertain');
  assert.equal(alignRecognizedDialogue([{text:'你好'}],{words:[{word:'你好',start:3,end:2}]}).status,'uncertain');
});
