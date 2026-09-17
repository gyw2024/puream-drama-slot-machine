'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const editorial=require('../app/commerce-editorial-contract'),{WorkbenchWorkflow}=require('../app/workbench-workflow');
const {createRepairBudget}=require('../app/production-v2/budget');
const retryPolicy=require('../app/production-v2/retry-policy');
const source='儿子：暖光和白光都能切换，同一盏灯我们都能用。';
function fixture(){return {id:'test',product:{name:'测试灯'},shots:[{id:'S1',duration:12}],candidates:[],script:{raw:source,authoredWithoutDurationTarget:true,adaptiveAuthoring:{signature:'source1',parts:[{sceneId:'SC1',scriptText:source}]},editorialReview:{ok:false,inputFingerprint:'review1',issues:[{message:'有效带货时长不足'}],rawReport:{editorial:{anchors:{selection:{unitId:'S1',quote:source}}}}}}};}
test('commerce repair source hashes use the actual author feedback algorithm',()=>{
 const p=fixture(),f=editorial.sourceRepairFeedback(p);assert.ok(f);assert.equal(f.sourceHashes.SC1,crypto.createHash('sha256').update(source).digest('hex'));assert.deepEqual(f.issues[0].targetSceneIds,['SC1']);
});
test('commerce automatic repair protects uploads, existing media and the matching exhausted checkpoint',()=>{
 const base={
  authored:p=>p.script.authoredWithoutDurationTarget=false,
  media:p=>p.candidates.push({status:'completed',filePath:'original.png'}),
  video:p=>p.videoJobs=[{taskId:'paid-task'}],
  // An exhausted checkpoint for the SAME receipt (signature + inputFingerprint)
  // must block a redundant repair.
  sameReceipt:p=>p.script.editorialRepairProgress={sourceSignature:'source1',passes:2,inputFingerprint:'review1'},
  sameReceiptAgain:p=>p.script.editorialRepairProgress={sourceSignature:'source1',passes:1,inputFingerprint:'review1'}
 };
 for(const change of Object.values(base)){const p=fixture();change(p);assert.equal(editorial.sourceRepairFeedback(p),null);}
});
test('commerce repair does not block on a checkpoint for a different receipt',()=>{
 const p=fixture();p.script.editorialRepairProgress={sourceSignature:'source1',passes:2,inputFingerprint:'OTHER_RECEIPT'};
 const f=editorial.sourceRepairFeedback(p);assert.ok(f,'a checkpoint bound to a different receipt must not suppress repair');
 assert.equal(f.sourceHashes.SC1,crypto.createHash('sha256').update(source).digest('hex'));
});
test('commerce review fingerprints ignore local media paths, never actual product facts',()=>{
 const a={name:'灯',sellingPoints:'暖光与白光两档切换',price:'39.9'},key=editorial.fingerprint([],a,'explicit');assert.equal(key,editorial.fingerprint([],{...a,imagePath:'another.png',publicUrl:'https://example.invalid/file'},'explicit'));assert.notEqual(key,editorial.fingerprint([],{...a,price:'49.9'},'explicit'));
});

// T03/T06/T07 — the old write→split→review repair orchestration was folded into
// the budget-aware production-v2 coordinator; repairCommerceSourceBeforeAssets is
// now a thin router to prompt review that must never trigger media generation.
test('repairCommerceSourceBeforeAssets routes a failed commerce project to prompt review, never to media',async()=>{
 let p=fixture();const calls=[];
 const w=Object.create(WorkbenchWorkflow.prototype);w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};
 w.preparePromptReviewBundle=async()=>{calls.push('review');return {...p,promptReview:{items:[],status:'ready'}};};
 w.editPromptReviewDocument=async()=>{calls.push('edit');return p;};
 w.generateAllAssets=async()=>{throw Error('Must not generate media');};
 const result=await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true});
 assert.deepEqual(calls,['review']);assert.ok(result.promptReview);assert.equal(result.script.raw,source);
});
test('repairCommerceSourceBeforeAssets is idempotent and never spins on the same receipt',async()=>{
 let p=fixture();const calls=[];
 const w=Object.create(WorkbenchWorkflow.prototype);w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};
 w.preparePromptReviewBundle=async()=>{calls.push('review');return {...p,promptReview:{items:[],status:'ready'}};};
 w.generateAllAssets=async()=>{throw Error('Must not generate media');};
 await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true});
 await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true});
 assert.deepEqual(calls,['review','review']);assert.equal(p.script.raw,source);
});
test('repairCommerceSourceBeforeAssets resumes an existing review document instead of re-routing',async()=>{
 let p=fixture();p.promptReview={items:[{id:'i1'}],status:'ready'};const calls=[];
 const w=Object.create(WorkbenchWorkflow.prototype);w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};
 w.preparePromptReviewBundle=async()=>{calls.push('review');return p;};
 w.editPromptReviewDocument=async()=>{calls.push('edit');return p;};
 w.generateAllAssets=async()=>{throw Error('Must not generate media');};
 const result=await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true});
 assert.deepEqual(calls,['edit']);assert.ok(result.promptReview.items.length);
});

// T03/T06/T07 — production-v2 repair budget terminal semantics. Budgets are
// consumed before the call and never refunded; exceeding either cap is a
// terminal pause, not an unbounded retry loop.
test('repair budget caps repairs at 2 per work unit and maxRunRepairs per run',()=>{
 const budget=createRepairBudget({maxRunRepairs:12});
 budget.consumeRepair('a');budget.consumeRepair('b');
 assert.throws(()=>budget.consumeRepair('c'),e=>e.code==='REPAIR_BUDGET_EXHAUSTED');
 assert.equal(budget.exhausted,true);
});
test('repair budget: nextWorkUnit resets the per-unit counter, the run counter keeps accumulating',()=>{
 const budget=createRepairBudget({maxRunRepairs:6});
 for(let unit=0;unit<3;unit++){budget.nextWorkUnit();budget.consumeRepair('u'+unit);budget.consumeRepair('u'+unit);assert.throws(()=>budget.consumeRepair('u'+unit),e=>e.code==='REPAIR_BUDGET_EXHAUSTED');}
 assert.equal(budget.state.runRepairs,6);
 budget.nextWorkUnit();
 assert.throws(()=>budget.consumeRepair('u3'),e=>e.code==='REPAIR_BUDGET_EXHAUSTED');
});
test('repair budget exhaustion is a terminal pause carrying noAutomaticRetry',()=>{
 const budget=createRepairBudget({maxRunRepairs:12});
 budget.consumeRepair('a');budget.consumeRepair('b');
 try{budget.consumeRepair('c');assert.fail('should have thrown');}catch(e){
  assert.equal(e.code,'REPAIR_BUDGET_EXHAUSTED');assert.equal(e.noAutomaticRetry,true);assert.equal(budget.exhausted,true);
 }
});
test('repair budget decision routes repairable errors and pauses once capped',()=>{
 assert.equal(retryPolicy.decision({repairs:0,runRepairs:0,maxRunRepairs:12},{code:'SCHEMA_INVALID'}).action,'repair_scope');
 assert.equal(retryPolicy.decision({repairs:2,runRepairs:0,maxRunRepairs:12},{code:'SCHEMA_INVALID'}).action,'pause');
 assert.equal(retryPolicy.decision({repairs:0,runRepairs:12,maxRunRepairs:12},{code:'SCHEMA_INVALID'}).action,'pause');
 // Unknown acceptance reconciles — never blind resubmit; auth/quota pause.
 assert.equal(retryPolicy.decision({},{acceptance:'unknown'}).action,'reconcile');
 assert.equal(retryPolicy.decision({},{code:'AUTH_REQUIRED'}).action,'pause');
 assert.equal(retryPolicy.decision({},{code:'INSUFFICIENT_QUOTA'}).action,'pause');
 // Soft target exceeded forbids new repair loops.
 assert.equal(retryPolicy.decision({targetExceeded:true,repairs:0,runRepairs:0,maxRunRepairs:12},{code:'SCHEMA_INVALID'}).action,'pause');
});
test('repair budget transport retries are capped at 2 and consumed before the call',()=>{
 assert.equal(retryPolicy.decision({transportRetries:0},{code:'CONNECT_FAILED_BEFORE_SEND',acceptance:'not_accepted'}).action,'retry_transport');
 assert.equal(retryPolicy.decision({transportRetries:2},{code:'CONNECT_FAILED_BEFORE_SEND',acceptance:'not_accepted'}).action,'pause');
});
test('repair budget cancellation stops all further decisions',()=>{
 const budget=createRepairBudget({maxRunRepairs:12});budget.cancel();
 assert.equal(budget.decide({code:'SCHEMA_INVALID'}).action,'stop');
});
