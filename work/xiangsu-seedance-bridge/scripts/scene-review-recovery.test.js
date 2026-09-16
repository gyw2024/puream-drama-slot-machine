const test=require('node:test'),assert=require('node:assert/strict');
const {review}=require('../app/scene-review-recovery');
const result=()=>({ok:true,issues:[],checks:[{dimension:'source',evidence:'甲放书。'}],facts:[{fact:'书已放下',quote:'甲放书。'}]});
test('timeout scopes retain complete source and all completed receipts across retry',async()=>{
 const state={},calls=[];let fail=true;
 const opts={state,part:{sceneId:'SC3'},fingerprint:'a',prompt:'全部当前场。全部前场。',keys:['ok','issues','checks','facts'],maxTokens:6000,save:()=>{},call:async(stage,prompt)=>{calls.push(stage);assert.match(prompt,/全部当前场。全部前场。/);if(stage==='review_scene_SC3'||stage.includes('causal_commerce')&&fail){fail=stage==='review_scene_SC3';throw Object.assign(Error('deadline'),{code:'LOCAL_AGENT_TIMEOUT'});}return result();}};
 await assert.rejects(review(opts),{code:'LOCAL_AGENT_TIMEOUT'});assert.ok(state.sceneReviewRecovery.SC3.scopes.performance);
 const r=await review(opts);assert.equal(r.ok,true);assert.equal(calls.filter(s=>s==='review_scene_SC3').length,1);assert.equal(calls.filter(s=>s.includes('performance')).length,1);assert.equal(r.recovery.scopes.length,2);
});
test('unchanged successful whole review stays one call; changed source invalidates recovery',async()=>{
 const state={sceneReviewRecovery:{SC1:{fingerprint:'old',scopes:{performance:result(),causal_commerce:result()}}}};let calls=0;
 const r=await review({state,part:{sceneId:'SC1'},fingerprint:'new',prompt:'source',keys:[],maxTokens:1,save:()=>{},call:async(stage)=>{calls++;assert.equal(stage,'review_scene_SC1');return result();}});
 assert.equal(r.ok,true);assert.equal(calls,1);
});
test('scope finding cannot be approved by the other scope and non-timeout failures propagate',async()=>{
 const opts={state:{sceneReviewRecovery:{SC1:{fingerprint:'a',reason:'LOCAL_AGENT_TIMEOUT',scopes:{}}}},part:{sceneId:'SC1'},fingerprint:'a',prompt:'source',keys:[],maxTokens:1,save:()=>{},call:async(stage)=>stage.includes('performance')?{...result(),ok:false,issues:[{message:'wrong speaker'}]}:result()};
 const r=await review(opts);assert.equal(r.ok,false);assert.equal(r.issues.length,1);
 await assert.rejects(review({...opts,state:{},call:async()=>{throw Object.assign(Error('permission'),{code:'LOCAL_AGENT_TOOL_DENIED'});}}),{code:'LOCAL_AGENT_TOOL_DENIED'});
});
