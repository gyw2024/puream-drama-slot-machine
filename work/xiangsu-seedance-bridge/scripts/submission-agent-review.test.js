'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const review=require('../app/submission-agent-review'),tasks=require('../app/agent-stage-tasks');
const fixture=()=>{
 const shot={id:'S1',dialogueTurns:[],promptReviewReferencePlan:{images:[{type:'character',entityId:'C1'}],audios:[]}},project={id:'P',shots:[shot],characters:[],scenes:[],product:{}},settings={localAgents:{text:'workbuddy',providers:{workbuddy:{model:'test'}}}},prompt='official English with complete staging';
 const w=require('../app/workbench-workflow');project.promptReview={status:'approved',sourceFingerprint:w.promptReviewSourceFingerprint(project),settingsFingerprint:w.promptReviewSettingsFingerprint(settings),items:[{entityId:'S1',stage:'shot_video',status:'confirmed',prompt,agentAudit:{requirementsVersion:require('../app/production-content-requirements').VERSION,issues:[],promptSha256:review.digest(prompt)}}]};
 return {project,shot,prompt,references:{imageRoles:[{type:'character',entityId:'C1',remoteUrl:'https://example.invalid/new-signed-url'}],audios:[]},settings,save:async()=>{},generate:()=>assert.fail('Submission never authors or re-reviews')};
};
test('unchanged confirmed content and equivalent signed-URL transport reuse current approval',async()=>{const args=fixture();assert.equal(await review.prepare(args),args.prompt);assert.equal(await review.prepare({...args,prompt:'  '+args.prompt+'\r\n'}),'  '+args.prompt+'\r\n');});
test('changed content, identity, policy, reviewer or missing evidence requires visible reconfirmation',async()=>{
 for(const edit of [a=>a.prompt='changed words',a=>a.references.imageRoles[0].entityId='C2',a=>a.settings.localAgents.providers.workbuddy.model='new-model',a=>a.project.promptReview.items[0].agentAudit.status='needs_evidence',a=>a.project.promptReview.items[0].status='draft',a=>a.project.shots[0].action='new source action']){
  const a=fixture(),receipts=[];a.save=async(k,r)=>receipts.push(r);edit(a);await assert.rejects(review.prepare(a),{code:'PROMPT_CONFIRMATION_REQUIRED'});assert.equal(receipts.length,1);assert.equal(receipts[0].status,'awaiting_prompt_review');
 }
});
test('cancelled submission never enters a review or creative retry',async()=>{const c=new AbortController();c.abort();await assert.rejects(review.prepare({...fixture(),signal:c.signal}),{code:'PROVIDER_REQUEST_ABORTED'});});
test('video Agent receives provider rules rather than a compulsory local prose sentence',()=>{
 const rules=tasks.promptReviewRules([{entityType:'shot',stage:'shot_video',prompt:'x'}]);assert.match(rules,/HAILUO OFFICIAL PROMPT AUTHORITY/);assert.match(rules,/Natural English staging has no application-invented compulsory sentence/);
});
test('a batch persists an early failure while a sibling is still rendering',async()=>{
 const {executeShotVideoBatch}=require('../app/workbench-workflow');let release,observed;const wait=new Promise(r=>release=r),progress=new Promise(r=>observed=r);
 const result=executeShotVideoBatch([{id:'S1'},{id:'S2'}],async shot=>{if(shot.id==='S1')throw Object.assign(Error('provider error'),{code:'TEST_FAILURE'});await wait;return {id:'video'};},2,p=>{if(p.failures.length)observed(p);});
 const p=await progress;assert.equal(p.failures[0].shotId,'S1');assert.equal(p.completed,0);release();assert.equal((await result).results.filter(Boolean).length,1);
});
