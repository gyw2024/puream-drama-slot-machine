'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const docs=require('../app/agent-production-document'),wf=require('../app/workbench-workflow'),director=require('../app/agent-repair-director');
const flags={preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true};
function document(){return docs.create([{shotId:'S01',scene:'厨房',dialogueIds:['D001'],action:'托着罐子',continuity:'放回桌面'}],[{id:'D001',speaker:'沈玉兰',sourceTone:'说得干脆（对观众：认真（轻声））',text:'要买的话，点左下角头像进橱窗就能找到，我也就这么买的。'}]);}
function delivery(){return {story:{title:'测试',synopsis:'原稿'},characters:[{id:'C1',name:'沈玉兰'}],scenes:[{id:'SC1',name:'厨房'}],props:[],wardrobes:[],bindings:[{shotId:'S01',sceneId:'SC1',characterIds:['C1'],visibleCharacterIds:['C1'],propIds:[],wardrobeBindings:[],productVisible:true,productReason:'原稿持罐',speakers:[{dialogueId:'D001',characterId:'C1',onScreen:true}]}]};}
test('presentation corruption or nested performance punctuation cannot erase structured dialogue',()=>{
 const doc=document(),r=wf.aiFirstUploadStandardizationValidation({agentDocument:doc,productionScript:'任意展示：不用于解析',sourceAudit:flags});
 assert.equal(r.usable,true);assert.equal(r.candidateDialogueLedger[0].text,doc.shots[0].dialogueTurns[0].text);assert.match(r.candidateDialogueLedger[0].tone,/对观众：认真/);
});
test('Agent entity delivery preserves exact words and cues through UI data projection',()=>{
 const doc=document(),r=delivery();assert.deepEqual(docs.receiptIssues(r,doc),[]);const saved=docs.projectData(doc,r,[{shotId:'S01',requiredSeconds:12}]);
 assert.equal(saved.shots[0].dialogueTurns[0].text,doc.shots[0].dialogueTurns[0].text);assert.equal(saved.shots[0].dialogueTurns[0].tone,doc.shots[0].dialogueTurns[0].tone);assert.equal(saved.shots[0].characterIds[0],'C1');assert.equal(saved.shots[0].duration,12);assert.equal(saved.shots[0].sourcePerformanceBudget.requiredSeconds,12);
});
test('only unresolved data references return to the Agent, never semantic keyword rules',()=>{
 const r=delivery();r.bindings[0].speakers[0].characterId='missing';assert.deepEqual(docs.receiptIssues(r,document()),['S01: unresolved speaker binding D001']);
});
test('a valid persisted Agent receipt resumes without generation and source changes invalidate it',async()=>{
 let checkpoint,calls=0;const args={source:'源稿',document:document(),product:{},save:r=>checkpoint=structuredClone(r),generate:async()=>{calls++;return delivery();}};
 await docs.materialize(args);await docs.materialize({...args,checkpoint});assert.equal(calls,1);await docs.materialize({...args,source:'更新的原稿',checkpoint});assert.equal(calls,2);
});
test('Agent diagnoses scope and writes repair instructions; incomplete repair replies self-reconcile',async()=>{
 let calls=0;const result=await director.plan({source:'原稿',findings:['vague error'],groups:[{shotId:'S01'},{shotId:'S02'}],draft:{},generate:async()=>++calls===1?{}:{affectedIds:['S02'],diagnosis:'Only S02 has a missing binding',repairPrompt:'Restore the S02 binding while retaining S01'}});
 assert.equal(calls,2);assert.deepEqual(result.affectedIds,['S02']);assert.match(result.repairPrompt,/retaining S01/);
});
test('external provider interruption remains cancelable and is not turned into content rewriting',async()=>{
 await assert.rejects(docs.materialize({source:'x',document:document(),generate:async()=>{throw Object.assign(Error('cancelled'),{code:'PROVIDER_REQUEST_ABORTED'});}}),{code:'PROVIDER_REQUEST_ABORTED'});
});
