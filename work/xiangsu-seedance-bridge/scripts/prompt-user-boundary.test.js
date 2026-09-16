'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkbenchWorkflow,PROMPT_REVIEW_BUNDLE_VERSION,promptReviewSourceFingerprint,promptReviewSettingsFingerprint,ideaSignature}=require('../app/workbench-workflow');
const receipt=require('../app/renderer/review-receipt-state');
function setup(mode='asset_direct',entry='original') {
 const p={id:'confirmation-fixture',productionRevision:'rev1',productionPlan:{executionMode:'full',commerceMode:'none',inputMode:entry==='original'?'ai':'manual',scriptFormat:'production',scriptFormatConfirmed:true},generation:{mode,modeConfirmed:true,engine:'hailuo-h3',videoProviderKind:'puream-hailuo-h3'},product:{},ideation:{selectedTopicId:'topic',topics:[{id:'topic',title:'测试',hook:'冲突',logline:'主线',reversal:'反转',emotionalPayoff:'和解'}]},script:{raw:''},shots:[],automation:{}};
 const settings={videoProvider:{kind:'puream-hailuo-h3'}},calls=[];
 const store={getProject:()=>p,saveProject:x=>Object.assign(p,x),getSettings:()=>settings};
 const w=new WorkbenchWorkflow({store,bridge:{}});
 w.generateCompleteScript=async()=>{calls.push('write');p.script={raw:'完整剧情',authoredWithoutDurationTarget:true,adaptiveAuthoring:{status:'ready'},ideaSignature:ideaSignature(p)};return p;};
 w.analyzeScript=async()=>{calls.push('structure');p.shots=[{id:'S01',duration:10}];return p;};
 w.preparePromptReviewBundle=async()=>{
  calls.push('prompts');p.promptReview={version:PROMPT_REVIEW_BUNDLE_VERSION,status:'ready',productionRevision:p.productionRevision,sourceFingerprint:promptReviewSourceFingerprint(p),settingsFingerprint:promptReviewSettingsFingerprint(settings),counts:{total:1,confirmed:0},items:[{id:'shot:S01:shot_video',entityType:'shot',entityId:'S01',stage:'shot_video',prompt:'甲面对乙，说：我回来了。',displayPrompt:'甲面对乙，说：我回来了。',executionLanguage:'zh-CN',status:'draft'}]};return p;
 };
 for(const method of ['generateAllAssets','generateAllStoryboards','generateAllShotVideos','ensurePipelineDependencies'])w[method]=async()=>{calls.push('MEDIA:'+method);throw Error('media must wait for creator');};
 return {w,p,calls};
}
for(const mode of ['asset_direct','keyframe','storyboard_sheet'])for(const entry of ['original','upload','adapt'])test(`${mode}/${entry}: full production stops at the real common user-confirmation boundary`,async()=>{
 const {w,p,calls}=setup(mode,entry);
 if(entry!=='original')p.script={raw:'用户提供或改写的完整剧本',authoredWithoutDurationTarget:true,adaptiveAuthoring:{status:'ready'}};
 await w.runFullPipeline(p.id,{track:false});
 assert.equal(p.automation.status,'awaiting_prompt_review');assert.equal(p.promptReview.status,'ready');assert.equal(p.promptReview.resume.continueAfterApproval,true);
 assert.equal(p.promptReview.resume.requestedAction,'pipeline');assert.ok(calls.includes('prompts'));assert.ok(!calls.some(c=>c.startsWith('MEDIA:')));
});
for(const mode of ['production_package','asset_direct','keyframe','storyboard_sheet'])test(`${mode}: AI/import receipts and autoApprove flags cannot authorize media; explicit user confirmation can`,async()=>{
 const {w,p,calls}=setup(mode);await w.preparePromptReviewBundle();
 p.promptReview.status='approved';p.promptReview.approvedBy='codex-production-package';p.promptReview.items[0].status='confirmed';p.promptReview.items[0].agentAudit={status:'reviewed',issues:[]};
 assert.equal(w.promptReviewIsCurrent(p,'approved'),false);
 const gate=await w.requestPromptReview(p.id,{autoApprove:true,continueAfterApproval:true});
 assert.equal(gate.required,true);assert.equal(p.promptReview.status,'ready');assert.equal(calls.filter(x=>x==='prompts').length,1,'do not rewrite to ask the user');
 assert.throws(()=>w.assertPromptReviewApproved(p.id),{code:'PROMPT_REVIEW_REQUIRED'});
 await w.confirmAllPromptReview(p.id);
 assert.equal(receipt.approved(p.promptReview),true);assert.equal((await w.requestPromptReview(p.id)).required,false);assert.equal(w.assertPromptReviewApproved(p.id).id,p.id);
 p.script.raw='用户修改了来源';assert.equal(w.promptReviewIsCurrent(p,'approved'),false);
});
test('complete prompts request presentation independently of task state; partial and user-approved drafts do not',()=>{
 const items=[{status:'draft',prompt:'完整提示词'}];
 assert.equal(receipt.needsConfirmation({status:'ready',items}),true);
 assert.equal(receipt.needsConfirmation({status:'approved',items}),true);
 assert.equal(receipt.needsConfirmation({status:'pending',items}),false);
 assert.equal(receipt.needsConfirmation({status:'ready',items:[]}),false);
 assert.equal(receipt.needsConfirmation({status:'approved',items:[{status:'confirmed',userConfirmed:true}]}),false);
});
