'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('exact original dialogue location overrides a stale but valid first-scene token',()=>{
 const l=require('../app/script-scene-ledger');const result=l.enforceSourceSceneLedger({scenes:[],shots:[{id:'S19',scene:'夜路',sceneId:'A',dialogueTurns:[{sourceDialogueId:'D58',text:'原台词'}]}]},{explicit:true,catalogue:[{id:'A',name:'夜路',aliases:[]},{id:'B',name:'客厅',aliases:[]}],occurrences:[]},[{id:'D58',sourceSceneId:'B'}]);
 assert.equal(result.shots[0].sceneId,'B');assert.equal(result.shots[0].dialogueTurns[0].text,'原台词');
});
test('structured negative audit keeps every quote and correction; empty success remains empty',()=>{
 const {normalize}=require('../app/prompt-audit-result');const bad={source_quote:'源台词',prompt_quote:'错台词',message:'遗漏',smallest_correction:'恢复原词'};
 const r=normalize({items:[{id:'a',issues:[bad]},{id:'b',issues:[]}]});
 for(const value of Object.values(bad))assert.ok(r.items[0].issues[0].includes(value));assert.deepEqual(r.items[1].issues,[]);
 assert.deepEqual(normalize({items:[{id:'a',issues:[{message:'unproven'}]}]}).items[0].issues,[{message:'unproven'}]);
});
