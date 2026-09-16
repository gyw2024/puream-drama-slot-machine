'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { scopedPropContinuityLedger } = require('../app/semantic-request-context');
const { h3AssetDirectSemanticSource, criticalPropContinuityLedger } = require('../app/workbench-workflow');

test('one-shot request keeps exact current, previous and next prop appearances without the whole film', () => {
  const shots = Array.from({ length: 41 }, (_, i) => ({ shotId: `S${i+1}`, propBindings: [{propId:'P1'}] }));
  const appearances = shots.map(s => ({shotId:s.shotId, action:'specific action '.repeat(80), stateBefore:s.shotId+' before', stateAfter:s.shotId+' after'}));
  const source = {shots, props:[{id:'P1'}], propContinuityLedger:[{propId:'P1', appearances}]};
  const before = JSON.stringify(source), result = scopedPropContinuityLedger(source,[shots[20]]);
  assert.deepEqual(result[0].appearances, appearances.slice(19,22));
  assert.equal(JSON.stringify(source), before);
  assert.ok(JSON.stringify(result).length < JSON.stringify(source.propContinuityLedger).length / 10);
});
test('batch gaps and collection members retain nearest boundary states without clipping row text', () => {
  const shots = Array.from({length:9},(_,i)=>({shotId:`S${i+1}`,propBindings: i===4 ? [{propId:'green'}] : []}));
  const source = {shots,props:[{id:'books',containsMemberIds:['green']},{id:'green',parentId:'books'},{id:'unrelated'}],propContinuityLedger:[
    {propId:'books',appearances:[{shotId:'S1',stateAfter:'all together'},{shotId:'S8',stateBefore:'member returned'}]},
    {propId:'green',appearances:[{shotId:'S3'},{shotId:'S5',action:'complete transfer'},{shotId:'S6'}]},
    {propId:'unrelated',appearances:[{shotId:'S9'}]}
  ]};
  const result=scopedPropContinuityLedger(source,[shots[4]]);
  assert.deepEqual(result,source.propContinuityLedger.slice(0,2));
  assert.equal(scopedPropContinuityLedger(source,[{shotId:'unknown'}]),source.propContinuityLedger);
});
test('mention, first named actor and sole visible speaker do not invent prop holders', () => {
  const p={characters:[{id:'C01',name:'张秀兰'},{id:'C03',name:'韩雪'}],assetLibraries:{props:[{id:'receipt',name:'旧汇款单',units:['S1']}]},shots:[{id:'S1',number:1,visibleCharacterIds:['C01'],action:'张秀兰询问韩雪，旧汇款单仍封存在韩雪马甲内袋。',stateAfter:'汇款单仍在韩雪内袋',dialogueTurns:[{speakerId:'C01',text:'你收好了吗？',body:'看向韩雪内袋里的旧汇款单'}]}]};
  const source=h3AssetDirectSemanticSource(p);
  assert.equal(source.shots[0].propBindings[0].holderAfterCharacterId,'');
  assert.equal(source.propContinuityLedger[0].appearances[0].holderAfterCharacterId,'');
  assert.equal(criticalPropContinuityLedger(p)[0].appearances[0].holderBeforeCharacterId,'');
  p.shots[0].propBindings=[{propId:'receipt',holderBeforeCharacterId:'C03',holderAfterCharacterId:'C03',locationBefore:'C03 vest pocket',locationAfter:'C03 vest pocket'}];
  assert.equal(h3AssetDirectSemanticSource(p).propContinuityLedger[0].appearances[0].holderAfterCharacterId,'C03');
});
