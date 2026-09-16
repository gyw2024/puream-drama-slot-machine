const test=require('node:test'),assert=require('node:assert/strict');
const {h3AssetDirectSemanticSource,mergeH3AssetDirectSemanticItem,h3SemanticCompilerItemMissing}=require('../app/workbench-workflow');
const {deterministicEnglishCue}=require('../app/hailuo-h3-natural-prompt');
test('semantic compiler receives exact dialogue and nonzero mathematical bounds',()=>{
 const p={characters:[{id:'C01',name:'甲'},{id:'C02',name:'乙'}],shots:[{id:'S01',duration:12,dialogueTurns:[{sourceDialogueId:'D001',speakerId:'C01',listenerIds:['C02'],text:'我先扶您坐稳，不着急。'}]}]};
 const turn=h3AssetDirectSemanticSource(p).shots[0].dialogue[0];assert.equal(turn.text,'我先扶您坐稳，不着急。');assert.equal(turn.primaryListenerId,'C02');assert.ok(turn.plannedSpeechSeconds>0);assert.ok(turn.calculatedSpeechWindow.minSeconds>0);
});
test('semantic persistence and final cue rendering preserve the final action and sound',()=>{
 const long='C01 remains screen-left and visibly supports P01 with the left palm. '.repeat(7)+'Finally C01 puts P01 in C02 right hand; the metal latch clicks at contact.';
 const p={characters:[]},s={id:'S01',duration:12,subshots:[{start:0,end:12}],dialogueTurns:[]},compiled={actionEn:long,stateAfterEn:long,segments:[{index:0,actionEn:long,soundEn:long,stateAfterEn:long}],dialogue:[]};
 const result=mergeH3AssetDirectSemanticItem(p,s,compiled);assert.equal(result.actionEn,long);assert.equal(result.providerTimedDirections[0].soundEn,long);assert.equal(deterministicEnglishCue(result.providerTimedDirections[0].actionEn,'action','placeholder',180),long);
});
test('semantic timing cannot reserve a guessed slow window or overlap speakers',()=>{
 const source={shotId:'S01',duration:12,subshots:[],dialogue:[{sourceDialogueId:'D001',calculatedSpeechWindow:{characters:10,minSeconds:1.67,maxSeconds:2}}]};
 const issues=h3SemanticCompilerItemMissing(source,{shotId:'S01',segments:[],dialogue:[{sourceDialogueId:'D001',startSecond:0,endSecond:9}]});assert.ok(issues.some(s=>s.includes('calculatedSpeechWindow')));
});
