'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const recovery=require('../app/screenplay-source-recovery'),writer=require('../app/shot-screenplay');
const {fixture}=require('./shot-screenplay-fixture');
function project(){const d=fixture();for(let i=2;i<=4;i++){const s=structuredClone(d.shots[0]);s.id='S0'+i;s.dialogue[0].id='D0'+i;s.beats[0].dialogueIds=['D0'+i];d.shots.push(s);}const raw=writer.render(d),record=writer.makeRecord(d,raw,{},'upload'),data=writer.projectData(record);return {...data,id:'source-repair-test',product:{},script:{raw,originalRaw:'用户上传文件保持不变',shotScreenplay:record},generation:{mode:'asset_direct'},assetLibraries:{props:data.props,wardrobes:data.wardrobes},promptReview:{status:'ready',approvedAt:'old'}};}
const audit=(d,issues=[])=>({ok:!issues.length,storyComplete:true,sourcePreserved:true,checks:d.shots.map(s=>({shotId:s.id,evidence:'Compared actual complete source and current shot.'})),issues});
test('source revision retains unrelated generated candidates and invalidates actual neighboring dependencies',()=>{
 const p=project(),director=require('../app/agent-production-decisions');
 for(const s of p.shots){s.agentProductionDecision={status:'authored',sourceFingerprint:director.sourceFingerprint(p,s)};s.finalPromptEditing={status:'authored',detailedDescriptionEn:'Previously authored '+s.id};}
 const d=structuredClone(p.script.shotScreenplay.document);d.shots[0].opening='Corrected source holder';d.story.synopsis+=' Source normalization note.';
 const next=recovery.applyRepair(p,{document:d,text:writer.render(d),reviews:[audit(d)]},{decision:{layer:'source',evidence:'actual source conflict'}});
 assert.equal(next.shots[0].agentProductionDecision,undefined);
 assert.equal(director.current(next,next.shots[1]),false);
 assert.equal(director.current(next,next.shots[3]),true);
 assert.equal(next.shots[3].finalPromptEditing.detailedDescriptionEn,p.shots[3].finalPromptEditing.detailedDescriptionEn);
 assert.equal(p.shots[3].agentProductionDecision.sourceRebaseHistory,undefined);
 assert.equal(next.promptReview.approvedAt,'');assert.equal(next.script.sourceRepairHistory[0].shots[0].finalPromptEditing.detailedDescriptionEn,p.shots[0].finalPromptEditing.detailedDescriptionEn);
});
test('Agent chooses source repair, accepted source is repaired and re-reviewed before replacement',async()=>{
 let p=project(),calls=[],round=0;const old=structuredClone(p),findings={S01:['The source opening has wrong holder.']};
 const result=await recovery.recover({getProject:()=>structuredClone(p),saveProject:x=>p=x,projectId:p.id,findingsByShot:findings,generate:async(m,o)=>{
  calls.push(o.stage);const input=JSON.parse(m[1].content);
  if(o.stage==='source_repair_diagnosis')return {checks:{S01:{layer:'source',evidence:'Source opening explicitly gives the wrong holder.',repairPrompt:'Correct S01 opening with unchanged dialogue.'}}};
  assert.deepEqual(input.downstreamReviewFeedback.findingsByShot,findings);
  if(o.stage==='shot_screenplay_review')return audit(input.screenplay,++round===1?[{shotIds:['S01'],field:'opening',evidence:'Source wrong holder.',repair:'Correct holder.'}]:[]);
  assert.equal(o.stage,'shot_screenplay_repair');return {shots:[{...input.screenplay.shots[0],opening:'小梅坐左，母亲坐右，母亲持有茶杯。'}],additions:[],characters:[],scenes:[],props:[],wardrobes:[],removeShotIds:[],scopeExtensions:[]};
 }});
 assert.equal(result.changed,true);assert.deepEqual(calls,['source_repair_diagnosis','shot_screenplay_review','shot_screenplay_repair','shot_screenplay_review']);
 assert.ok(writer.runtimeCurrent(p));assert.equal(p.script.originalRaw,old.script.originalRaw);assert.deepEqual(p.shots[3],old.shots[3]);assert.deepEqual(p.shots[0].dialogueTurns.map(x=>x.text),old.shots[0].dialogueTurns.map(x=>x.text));assert.equal(p.promptReview.status,'pending');assert.equal(p.script.sourceRepairHistory.length,1);
});
test('prompt-only finding never dispatches a new screenplay writer or source review',async()=>{
 let p=project(),calls=0;const original=p.script.raw,options={getProject:()=>structuredClone(p),saveProject:x=>p=x,projectId:p.id,findingsByShot:{S01:['Prompt has wrong translated timing.']},generate:async(_m,o)=>{calls++;assert.equal(o.stage,'source_repair_diagnosis');return {checks:{S01:{layer:'prompt',evidence:'Canonical source is viable.',repairPrompt:'Correct only timing.'}}};}};
 assert.equal((await recovery.recover(options)).changed,false);assert.equal((await recovery.recover(options)).changed,false);assert.equal(calls,1);assert.equal(p.script.raw,original);
});
test('an interrupted source repair resumes its saved screenplay checkpoint without rewriting',async()=>{
 let p=project(),reviews=0,diagnoses=0,writes=0;const opts={getProject:()=>structuredClone(p),saveProject:x=>p=x,projectId:p.id,findingsByShot:{S01:['source conflict']},generate:async(m,o)=>{
  if(o.stage==='source_repair_diagnosis'){diagnoses++;return {checks:{S01:{layer:'source',evidence:'source conflict',repairPrompt:'Repair only cited conflict'}}};}
  if(o.stage==='shot_screenplay_write'){writes++;throw Error('unexpected writer');}
  if(++reviews===1)throw Object.assign(Error('simulated transport interruption'),{code:'PROVIDER_REQUEST_ABORTED'});
  return audit(JSON.parse(m[1].content).screenplay);
 }};
 await assert.rejects(recovery.recover(opts),/interruption/);assert.ok(p.script.promptSourceRecovery.checkpoint.document);
 assert.equal((await recovery.recover(opts)).changed,false);assert.equal(writes,0);assert.equal(diagnoses,1);assert.equal(reviews,2);
});
test('cancelled operation cannot dispatch diagnosis or replace any source',async()=>{
 const p=project(),before=structuredClone(p),controller=new AbortController();controller.abort();
 await assert.rejects(recovery.recover({getProject:()=>p,saveProject:()=>assert.fail(),generate:()=>assert.fail(),projectId:p.id,findingsByShot:{S01:['x']},signal:controller.signal}));assert.deepEqual(p,before);
});

test('mixed findings preserve the Agent source-layer diagnosis instead of taking the majority prompt result',async()=>{
 let p=project(),diagnoses=0,reviews=0;
 const result=await recovery.recover({getProject:()=>structuredClone(p),saveProject:x=>p=x,projectId:p.id,findingsByShot:{S01:['Derived clock'],S04:['Canonical source omits required continuing prop']},generate:async(m,o)=>{
  const input=JSON.parse(m[1].content);
  if(o.stage==='source_repair_diagnosis'){
   diagnoses++;assert.deepEqual(input.source.shots.map(s=>s.id),p.script.shotScreenplay.document.shots.map(s=>s.id));
   assert.deepEqual(o.responseSchema.properties.checks.required,['S01','S04']);
   return {checks:{S01:{layer:'prompt',evidence:'Only derived timing is wrong',repairPrompt:'Retime the derived schedule'},S04:{layer:'source',evidence:'Source-fixed reference list omits required object',repairPrompt:'Correct only the source reference manifest'}}};
  }
  assert.equal(o.stage,'shot_screenplay_review');reviews++;
  assert.equal(input.downstreamReviewFeedback.decision.layer,'source');
  assert.match(input.downstreamReviewFeedback.decision.repairPrompt,/S04/);
  assert.doesNotMatch(input.downstreamReviewFeedback.decision.repairPrompt,/Retime/);
  return audit(input.screenplay);
 }});
 assert.equal(diagnoses,1);assert.equal(reviews,1);assert.equal(result.decision.layer,'source');
});
