'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),contract=require('../app/whole-output-contract'),indexed=require('../app/indexed-production-plan');
const atoms=[{id:'D001',turnId:'a',speaker:'甲',text:'先把门打开。',sourceSceneName:'门口'},{id:'D002',turnId:'b',speaker:'乙',text:'我再把箱子搬进去。',sourceSceneName:'门口'},{id:'D003',turnId:'c',speaker:'甲',text:'现在可以关门了。',sourceSceneName:'门口'}];
const groups=[{shotId:'S01',dialogueIds:['D001','D002']},{shotId:'S02',dialogueIds:['D003']}];
test('a preliminary heading cannot overwrite the Agent physical scene and trap repeated repairs',()=>{
 const preliminary=atoms.map(a=>({...a,sourceSceneName:'S01 | 0-10 seconds, doorway'}));
 const raw={shotDetails:{S01:{segments:[detail(['D001','D002'],'Open the door')]},S02:{segments:[detail(['D003'],'Close the door')]}},sourceAudit:{preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}};
 const expanded=indexed.expand(contract.compileGroups(raw,groups,preliminary),preliminary);
 const checked=require('../app/workbench-workflow').aiFirstUploadStandardizationValidation(expanded);
 assert.equal(checked.usable,true);assert.equal(checked.actualDialogueCount,3);
 assert.deepEqual(expanded.shots.map(s=>s.scene),[detail([],'').scene,detail([],'').scene]);
 assert.equal(preliminary[0].sourceSceneName,'S01 | 0-10 seconds, doorway');
});
function detail(ids,action){return {dialogueIds:ids,scene:'门口',cast:[{name:'甲',presence:'visible',openingState:'站在门前'}],props:'门与箱子',action,sound:'现场声音',continuity:'保持门和箱子状态',budget:{beforeSeconds:.3,beforeAction:'动作开始',duringSeconds:6,duringReason:'原文动作与对白',afterSeconds:.35,afterAction:'动作落定'}};}
test('Agent can partition one preliminary group while source coverage and final identity remain exact',()=>{
 const raw={shotDetails:{S01:{segments:[detail(['D001'],'开门'),detail(['D002'],'搬箱')]},S02:{segments:[detail(['D003'],'关门')]}},sourceAudit:{}};
 const compiled=contract.compileGroups(raw,groups,atoms),expanded=indexed.expand(compiled,atoms);
 assert.deepEqual(compiled.shots.map(s=>s.shotId),['S01','S02','S03']);
 assert.deepEqual(compiled.shots.flatMap(s=>s.dialogueIds),atoms.map(a=>a.id));
 assert.deepEqual(compiled.performanceBudgets.map(s=>s.shotId),['S01','S02','S03']);
 assert.equal(compiled.finalGroups[2].sourceGroupId,'S02');assert.match(expanded.productionScript,/现在可以关门了/);
 for(const ids of [['D002','D001'],['D001','D001'],['D001'],['D001','D003']])assert.throws(()=>contract.compileGroups({...raw,shotDetails:{...raw.shotDetails,S01:{segments:[detail(ids,'动作')]}}},groups,atoms),/every complete sentence/);
 const schema=contract.schema(groups,{adaptive:true});assert.deepEqual(schema.properties.shotDetails.properties.S01.properties.segments.items.properties.sentenceCount,{type:'integer',minimum:1,maximum:2});
 const counted=structuredClone(raw);for(const g of Object.values(counted.shotDetails))for(const s of g.segments){s.sentenceCount=s.dialogueIds.length;delete s.dialogueIds;}assert.deepEqual(contract.compileGroups(counted,groups,atoms).shots.map(s=>s.dialogueIds),compiled.shots.map(s=>s.dialogueIds));
 counted.shotDetails.S01.segments[0].sentenceCount=3;assert.throws(()=>contract.compileGroups(counted,groups,atoms),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
});
