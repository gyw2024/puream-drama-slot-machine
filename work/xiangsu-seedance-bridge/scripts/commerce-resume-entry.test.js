'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
test('actual resume entry reaches explicit review repair when writer itself is ready',async()=>{
 const quote='儿子：这盏灯的两档亮度可以切换。';
 const p={id:'p',script:{raw:quote,authoredWithoutDurationTarget:true,adaptiveAuthoring:{status:'ready',signature:'a',parts:[{sceneId:'SC1',scriptText:quote}]},editorialReview:{ok:false,inputFingerprint:'x',issues:[{message:'selection missing'}],rawReport:{editorial:{anchors:{selection:{quote}}}}}},automation:{status:'paused'}};
 const w=Object.create(WorkbenchWorkflow.prototype);w.store={getProject:()=>p};w.hasActiveOperation=()=>false;w.runTrackedOperation=async(_id,op,_target,fn)=>{assert.equal(op,'prepare_prompt_review');return fn();};
 // The editorial-repair branch of resumeScriptGeneration passes only
 // autoApprove/requireCompleteDelivery; there is no explicitRewrite option at
 // this call site, so asserting it here tested a contract that never existed.
 w.preparePromptReviewBundle=async(id,options)=>{assert.equal(id,'p');assert.equal(options.autoApprove,false);assert.equal(options.requireCompleteDelivery,true);return {called:true};};
 assert.deepEqual(await w.resumeScriptGeneration('p'),{called:true});
});
