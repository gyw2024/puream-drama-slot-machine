'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const editorial=require('../app/commerce-editorial-contract'),{WorkbenchWorkflow}=require('../app/workbench-workflow');
const source='儿子：暖光和白光都能切换，同一盏灯我们都能用。';
function fixture(){return {id:'test',product:{name:'测试灯'},shots:[{id:'S1',duration:12}],candidates:[],script:{raw:source,authoredWithoutDurationTarget:true,adaptiveAuthoring:{signature:'source1',parts:[{sceneId:'SC1',scriptText:source}]},editorialReview:{ok:false,inputFingerprint:'review1',issues:[{message:'有效带货时长不足'}],rawReport:{editorial:{anchors:{selection:{unitId:'S1',quote:source}}}}}}};}
test('commerce repair source hashes use the actual author feedback algorithm',()=>{
 const p=fixture(),f=editorial.sourceRepairFeedback(p);assert.ok(f);assert.equal(f.sourceHashes.SC1,crypto.createHash('sha256').update(source).digest('hex'));assert.deepEqual(f.issues[0].targetSceneIds,['SC1']);
});
test('commerce automatic repair protects uploads, existing media and exhausted checkpoints',()=>{
 for(const change of [p=>p.script.authoredWithoutDurationTarget=false,p=>p.candidates.push({status:'completed',filePath:'original.png'}),p=>p.videoJobs=[{taskId:'paid-task'}],p=>p.script.editorialRepairProgress={sourceSignature:'source1',passes:2},p=>p.script.editorialRepairProgress={sourceSignature:'source1',passes:1,inputFingerprint:'review1'}]){const p=fixture();change(p);assert.equal(editorial.sourceRepairFeedback(p),null);}
});
test('real workflow sends failed timed commerce back to writing, splitting, then prompt review, never media',async()=>{
 let p=fixture();const calls=[],w=Object.create(WorkbenchWorkflow.prototype);w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};
 w.generateCompleteScript=async()=>{calls.push('write');assert.equal(p.script.adaptiveAuthoring.status,'needs_review');assert.ok(p.script.adaptiveAuthoring.repairRequest.id);assert.equal(p.script.adaptiveAuthoring.audit.ok,false);assert.ok(p.script.adaptiveAuthoring.audit.issues.length);p.script.raw=source+'\n母亲：两种光我都能用上。';p.script.adaptiveAuthoring.status='ready';return structuredClone(p);};
 w.analyzeScript=async()=>{calls.push('split');assert.deepEqual(p.shots,[]);p.shots=[{id:'new',duration:12}];p.script.sourceFingerprint=crypto.createHash('sha256').update(p.script.raw).digest('hex');p.script.analyzedAt=new Date().toISOString();p.script.analysisCheckpoint=null;return structuredClone(p);};
 w.preparePromptReviewBundle=async(_id,opts)=>{calls.push('review');assert.equal(opts.commerceRepairDepth,1);return p;};
 w.generateAllAssets=async()=>{throw Error('Must not generate media');};
 const result=await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true});assert.deepEqual(calls,['write','split','review']);assert.equal(result.script.editorialRepairHistory[0].raw,source);assert.equal(result.script.editorialRepairHistory[0].shots[0].id,'S1');
});
test('unchanged or interrupted repair remains resumable and cannot spin on the same receipt',async()=>{
 let p=fixture();const w=Object.create(WorkbenchWorkflow.prototype);w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};let writes=0;
 w.generateCompleteScript=async()=>{writes++;throw Object.assign(Error('unavailable'),{code:'LOCAL_AGENT_QUOTA'});};
 assert.equal(await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true}),null);assert.equal(await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true}),null);assert.equal(writes,1);assert.equal(p.script.raw,source);assert.equal(p.script.editorialRepairProgress.status,'interrupted');
});
test('commerce review fingerprints ignore local media paths, never actual product facts',()=>{
 const a={name:'灯',sellingPoints:'暖光与白光两档切换',price:'39.9'},key=editorial.fingerprint([],a,'explicit');assert.equal(key,editorial.fingerprint([],{...a,imagePath:'another.png',publicUrl:'https://example.invalid/file'},'explicit'));assert.notEqual(key,editorial.fingerprint([],{...a,price:'49.9'},'explicit'));
});

test('commerce repair cannot review retained old shots after an incomplete split',async()=>{
 let p=fixture();p.script.sourceFingerprint=crypto.createHash('sha256').update(source).digest('hex');
 const w=Object.create(WorkbenchWorkflow.prototype),calls=[];
 w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};
 w.generateCompleteScript=async()=>{p.script.raw=source+'\n母亲：两种光我都能用上。';p.script.adaptiveAuthoring.status='ready';return structuredClone(p);};
 w.analyzeScript=async()=>{calls.push('split');return structuredClone(p);};
 w.preparePromptReviewBundle=async()=>{calls.push('review');return p;};
 assert.equal(await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true}),null);
 assert.deepEqual(calls,['split']);assert.equal(p.script.editorialRepairProgress.status,'needs_split');
 assert.deepEqual(p.shots,[]);assert.equal(p.script.editorialRepairHistory[0].shots[0].id,'S1');
 assert.equal(p.script.editorialRepairHistory[0].raw,source);
});

for(const state of ['stale_source','missing_completion','partial_checkpoint','unsaved_result']){
 test(`commerce repair rejects ${state} instead of treating shot presence as completed splitting`,async()=>{
  let p=fixture();const w=Object.create(WorkbenchWorkflow.prototype);let reviews=0;
  w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};
  w.generateCompleteScript=async()=>{p.script.raw=source+'\n母亲：两种光我都能用上。';p.script.adaptiveAuthoring.status='ready';return structuredClone(p);};
  w.analyzeScript=async()=>{
   const result=structuredClone(p);result.shots=[{id:'new',duration:12}];
   result.script.sourceFingerprint=crypto.createHash('sha256').update(state==='stale_source'?source:result.script.raw).digest('hex');
   result.script.analyzedAt=state==='missing_completion'?null:new Date().toISOString();
   result.script.analysisCheckpoint=state==='partial_checkpoint'?{chunks:[{index:0}],totalChunks:2}:null;
   if(state!=='unsaved_result')p=structuredClone(result);return result;
  };
  w.preparePromptReviewBundle=async()=>{reviews++;return p;};
  assert.equal(await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true}),null);assert.equal(reviews,0);
  assert.equal(p.script.editorialRepairProgress.status,'needs_split');assert.equal(p.script.editorialRepairHistory[0].shots[0].id,'S1');
 });
}

test('split interruption keeps the repaired manuscript and archived old shots, never an active old ledger',async()=>{
 let p=fixture();const w=Object.create(WorkbenchWorkflow.prototype);let reviews=0;
 w.store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v))};w.setAutomation=()=>{};
 w.generateCompleteScript=async()=>{p.script.raw=source+'\n母亲：两种光我都能用上。';p.script.adaptiveAuthoring.status='ready';return structuredClone(p);};
 w.analyzeScript=async()=>{throw Object.assign(Error('fixture incomplete split'),{code:'UPLOAD_PREPARATION_INCOMPLETE'});};
 w.preparePromptReviewBundle=async()=>{reviews++;return p;};
 assert.equal(await w.repairCommerceSourceBeforeAssets('test',{explicitRewrite:true}),null);assert.equal(reviews,0);
 assert.deepEqual(p.shots,[]);assert.notEqual(p.script.raw,source);assert.equal(p.script.editorialRepairHistory[0].shots[0].id,'S1');
 assert.equal(p.script.editorialRepairProgress.status,'interrupted');assert.equal(p.script.editorialRepairProgress.code,'UPLOAD_PREPARATION_INCOMPLETE');
});
