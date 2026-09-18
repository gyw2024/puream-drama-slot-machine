'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const verify=require('../app/source-finding-verification'),writer=require('../app/shot-screenplay'),{fixture}=require('./shot-screenplay-fixture');
const criteria=()=>Object.fromEntries(['story','commerce','dialogue'].map(k=>[k,{passed:true,evidence:'Specific current source evidence'}]));
const rejected=()=>({ok:false,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'Primary check retained'}],criteria:criteria(),issues:[{shotIds:['S01'],field:'reportedFact',evidence:'Alleged missing prior scene',repair:'Change reported total'}]});
const answer=verdict=>({decisions:{F1:{verdict,reason:verdict==='dismissed'?'S01 explicitly reports the background fact; no earlier source contradicts it.':'S01 names an already completed event as not having happened.'}},conclusion:{ok:verdict==='dismissed',storyComplete:true,sourcePreserved:true,criteria:criteria()}});
test('no software verdict: explicit Agent dismissal preserves source and primary evidence without any author call',async()=>{
 const d=fixture(),before=JSON.stringify(d),audit=rejected();let reviews=0,verifications=0;
 const result=await writer.author({source:writer.render(d),mode:'upload',draftDocument:d,deferReview:false,generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review'){reviews++;return audit;}
  assert.equal(o.stage,'shot_screenplay_review_findings');assert.equal(o.agentStage,'review');verifications++;
  assert.deepEqual(JSON.parse(m[1].content).screenplay,d);assert.deepEqual(JSON.parse(m[1].content).originalSource,writer.render(d));return answer('dismissed');
 }});
 assert.equal(result.status,'ready');assert.equal(JSON.stringify(result.document),before);assert.equal(reviews,1);assert.equal(verifications,1);assert.equal(result.history,undefined);assert.deepEqual(result.reviews[0],audit);assert.equal(result.activeAudit.issues.length,0);assert.deepEqual(result.activeAudit.findingVerification.findings[0].finding,audit.issues[0]);
 assert.equal(result.reviews.at(-1).ok,true);assert.equal(writer.makeRecord(d,result.text,result.reviews.at(-1),'upload').review.findingVerification.decisions.F1.verdict,'dismissed');
});
test('true finding reaches targeted repair then fresh review; neighboring source bytes retained',async()=>{
 const d=fixture();d.shots.push({...structuredClone(d.shots[0]),id:'S02',dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]});const before=JSON.stringify(d.shots[1]);let reviews=0,repairs=0;
 const result=await writer.author({source:writer.render(d),draftDocument:d,deferReview:false,generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review'){const a=rejected();a.checks.push({shotId:'S02',evidence:'Neighbor retained'});if(++reviews>1){a.ok=true;a.issues=[];}return a;}
  if(o.stage==='shot_screenplay_review_findings')return answer('upheld');
  assert.equal(o.stage,'shot_screenplay_repair');repairs++;assert.deepEqual(JSON.parse(m[1].content).allowedShotIds,['S01']);return {shots:[{...d.shots[0],ending:'修正后的源稿状态'}],additions:[],characters:[],scenes:[],props:[],wardrobes:[]};
 }});assert.equal(result.status,'ready');assert.equal(repairs,1);assert.equal(reviews,2);assert.equal(JSON.stringify(result.document.shots[1]),before);assert.equal(result.history[0].review.findingVerification.decisions.F1.verdict,'upheld');
});
test('partial or contradictory adjudication goes back to the review Agent without acceptance',async()=>{
 const audit=rejected(),input={screenplay:fixture()},bad=answer('upheld');bad.conclusion.ok=true;let calls=0;
 const result=await verify.verify({input,audit,call:async(stage,m)=>{assert.equal(stage,'review_findings');calls++;if(calls===1)return {decisions:{}};if(calls===2){assert.equal(m.length,3);return bad;}assert.equal(m.length,3);return answer('dismissed');}});
 assert.equal(calls,3);assert.equal(result.ok,true);assert.deepEqual(audit,rejected());
 const noTarget=answer('dismissed');noTarget.conclusion.criteria.story.passed=false;assert.ok(verify.validate(verify.prepare(audit),noTarget));
});
test('interrupted verification resumes saved audit without reauthoring or rerunning completed primary review',async()=>{
 const d=fixture();let checkpoint,calls=0;const input={draftDocument:d,source:writer.render(d),mode:'upload',deferReview:false,save:s=>checkpoint=structuredClone(s)};
 await assert.rejects(writer.author({...input,generate:async(_m,o)=>{if(o.stage==='shot_screenplay_review')return rejected();calls++;throw Object.assign(Error('cancelled'),{code:'LOCAL_AGENT_CANCELLED'});}}),{code:'LOCAL_AGENT_CANCELLED'});
 const savedSession=checkpoint.pendingRequest.sessionId;
 const result=await writer.author({...input,checkpoint,generate:async(_m,o)=>{assert.equal(o.stage,'shot_screenplay_review_findings');assert.equal(o.sessionId,savedSession);calls++;return answer('dismissed');}});
 assert.equal(calls,2);assert.equal(result.status,'ready');assert.deepEqual(result.document,d);
});
test('adjudication evidence binds exact current input and preserves original finding on invalidation',async()=>{
 const audit=rejected(),input={screenplay:fixture()};let calls=0;
 const call=async()=>{calls++;return answer('upheld');};const first=await verify.verify({input,audit,call});
 await verify.verify({input,audit:first,call});assert.equal(calls,1);
 const changed={screenplay:structuredClone(input.screenplay)};changed.screenplay.shots[0].opening+=' Changed.';
 const second=await verify.verify({input:changed,audit:first,call});assert.equal(calls,2);assert.notEqual(second.findingVerification.inputHash,first.findingVerification.inputHash);assert.deepEqual(second.findingVerification.findings,first.findingVerification.findings);
});
test('positive primary review does not incur another review and causal prompt shares reported-fact discipline',async()=>{
 const audit={...rejected(),ok:true,issues:[]};assert.equal(await verify.verify({input:{screenplay:fixture()},audit,call:()=>assert.fail('no need')}),audit);
 const task=require('../app/screenplay-causal-review').task({screenplay:fixture(),mode:'upload'});assert.ok(task.messages[0].content.includes(verify.REPORTED_FACTS));
 const independent=verify.task({screenplay:fixture()},rejected());assert.equal(JSON.parse(independent.messages[1].content).findings[0].finding.repair,undefined);assert.equal(independent.findings[0].finding.repair,'Change reported total');
});
