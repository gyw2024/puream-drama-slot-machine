'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const whole=require('../app/whole-script-preparation'),wf=require('../app/workbench-workflow'),recovery=require('../app/whole-plan-recovery');
const source='## 第一场｜小店\n老周（对小陈；克制）：这本账我一直留着。你自己看看，这些都是你爸写的。\n## 第二场｜院子\n小陈（对老周；低声）：我刚才说错了。爸当年的事情，我应该问清楚再开口。';
const flags={preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true};
function output(input){return {sourceAudit:flags,shotDetails:Object.fromEntries(input.capacityGroups.map(g=>[g.shotId,{segments:[{dialogueIds:g.dialogueIds,scene:'小店',cast:[{name:'老周',presence:'visible',openingState:'小陈对面站着'},{name:'小陈',presence:'visible',openingState:'老周对面站着'}],props:'账本',action:'保持位置，讲话时看向对方。',sound:'衣料声',continuity:'两人保持位置',budget:{beforeSeconds:.3,beforeAction:'看向对方',duringSeconds:2,duringReason:'目光与讲话同时进行',afterSeconds:.35,afterAction:'收句'}}]}]))};}
const validate=wf.aiFirstUploadStandardizationValidation;
test('one button recovers failed group only, retains other groups and reuses completed checkpoint without another call',async()=>{
 let calls=0,saved,first;const result=await whole.prepare({source,validate,save:s=>saved=structuredClone(s),generate:async(m)=>{
  const input=JSON.parse(m[1].content);if(input.estimatedBudgets)return {ok:false,issues:[{shotId:'S01',message:'S01 requires repartitioning',repair:'Repartition S01 only'}],budgets:input.estimatedBudgets};if(input.allowedSourceGroups)return {affectedIds:['S01'],diagnosis:'Only S01 exceeds capacity',repairPrompt:'Repartition S01 only'};calls++;const r=output(input);
  if(calls===1){first=structuredClone(r);assert.ok(input.capacityGroups.length>1);r.shotDetails.S01.segments[0].budget.duringSeconds=15;}
  else{assert.deepEqual(input.capacityGroups.map(g=>g.shotId),['S01']);assert.equal(input.repairOnlyTheseFindings.repairPrompt,'Repartition S01 only');}
  return r;
 }});assert.equal(calls,2);assert.equal(saved.status,'completed');assert.equal(saved.sourceDraft.shotDetails.S02.segments[0].action,first.shotDetails.S02.segments[0].action);assert.deepEqual(saved.sourceDraft.shotDetails.S02.segments[0].dialogueIds,first.shotDetails.S02.segments[0].dialogueIds);assert.deepEqual(whole.check(source,result,validate).issues,[]);
 await whole.prepare({source,validate,checkpoint:saved,generate:async()=>{throw Error('completed source called again')}});
});
test('invalid primitive and malformed sentence assignment become recoverable feedback, not an uncaught parser exception',async()=>{
 for(const bad of [null,{}, {shotDetails:{S01:{segments:[null]}},sourceAudit:flags}]){
  let calls=0;const result=await whole.prepare({source,validate,generate:async(m)=>{const i=JSON.parse(m[1].content);if(i.allowedSourceGroups)return {affectedIds:i.allowedSourceGroups.map(g=>g.shotId),diagnosis:'Malformed receipt',repairPrompt:'Complete only missing groups'};return ++calls===1?bad:output(i);}});assert.equal(calls,2);assert.ok(result.productionScript);
 }
});
test('network or cancellation is not mistaken for a content defect or silently retried',async()=>{
 for(const code of ['LOCAL_AGENT_DNS_FAILED','ABORT_ERR']){let calls=0;await assert.rejects(whole.prepare({source,validate,generate:async()=>{calls++;throw Object.assign(Error(code),{code});}}),{code});assert.equal(calls,1);}
});
test('content recovery continues beyond three responses and completes without a manual resume',async()=>{
 let calls=0,saved;const result=await whole.prepare({source,validate,save:s=>saved=structuredClone(s),generate:async m=>{calls++;return calls<=4?null:output(JSON.parse(m[1].content));}});assert.equal(calls,5);assert.equal(saved.recoveryHistory.length,4);assert.equal(saved.status,'completed');assert.ok(result.productionScript);
});
test('all malformed source groups are identified together instead of exhausting a shared repair budget one group at a time',()=>{
 const contract=require('../app/whole-output-contract');const groups=[{shotId:'S08',dialogueIds:['D1','D2']},{shotId:'S10',dialogueIds:['D3','D4']},{shotId:'S11',dialogueIds:['D5','D6']}];
 const raw={shotDetails:Object.fromEntries(groups.map(g=>[g.shotId,{segments:[{sentenceCount:1}]}]))};
 const issues=contract.inspectGroups(raw,groups,[]);assert.equal(issues.length,3);assert.deepEqual(recovery.targets(issues,groups),groups);
});
test('final shot numbering resolves via immutable dialogue assignments after an earlier group was split',()=>{
 const groups=[{shotId:'S01',dialogueIds:['D1','D2']},{shotId:'S02',dialogueIds:['D3']}],final=[{shotId:'S01',dialogueIds:['D1']},{shotId:'S02',dialogueIds:['D2']},{shotId:'S03',dialogueIds:['D3']}];
 assert.deepEqual(recovery.targets(['S02: exceeds capacity'],groups,final),[groups[0]]);
 assert.deepEqual(recovery.targets(['S03: exceeds capacity'],groups,final),[groups[1]]);
 assert.deepEqual(recovery.targets(['Source group S02: expected 1 complete sentences, received sentenceCount total 2'],groups,final),[groups[1]]);
 assert.throws(()=>recovery.merge({shotDetails:{}},{shotDetails:{S02:{}}},[groups[0]]),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
});
