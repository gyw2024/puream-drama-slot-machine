'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inputFingerprint,summarize}=require('../app/actual-media-review-state');
const select=(p,type,id,stage)=>p.candidates.find(c=>c.entityType===type&&c.entityId===id&&c.stage===stage&&c.selected);
const settings={localAgents:{stages:{review:'grokbuild'},providers:{grokbuild:{model:'selected',reasoningEffort:'high'}}}};
const opts={version:'test',dimensions:['identity','dialogue']};
function fixture(){return {characters:[{id:'C1',name:'甲'}],product:{name:'原商品'},shots:[1,2].map(n=>({id:'S'+n,action:'对对方递出信封',dialogueTurns:[{speakerId:'C1',text:'请看这封信。'}],characterIds:['C1']})),candidates:[1,2].map(n=>({id:'V'+n,entityId:'S'+n,entityType:'shot',stage:'shot_video',selected:true,sha256:String(n).repeat(64)}))};}
function approve(p,n){const shot=p.shots[n],c=select(p,'shot',shot.id,'shot_video');shot.actualMediaAudit={version:'test',status:'passed',sourceCandidateId:c.id,sourceSha256:c.sha256,inputFingerprint:inputFingerprint(p,shot,settings,select),dimensions:opts.dimensions.map(d=>({dimension:d,status:'pass'})),neighborEvidence:[]};}
test('partial audit never certifies the entire film, and later batches retain earlier current reports',()=>{
 const p=fixture();approve(p,0);let s=summarize(p,settings,select,opts);assert.equal(s.passed,false);assert.equal(s.totalShots,2);assert.equal(s.currentReviewedShots,1);
 approve(p,1);s=summarize(p,settings,select,{...opts,lastRunReports:[{shotId:'S2',status:'passed'}]});assert.equal(s.passed,true);assert.equal(s.reports.length,2);
 assert.equal(summarize(p,settings,select,{...opts,lastRunReports:[{shotId:'S1',status:'missing_video'}]}).passed,false);
});
test('changed video, source dialogue, reviewer or adjacent video invalidates the relevant approval',()=>{
 for(const change of ['video','dialogue','reviewer','neighbor']){
  const p=fixture();approve(p,0);approve(p,1);let config=structuredClone(settings);
  if(change==='video')p.candidates[0].id='replacement';
  if(change==='dialogue')p.shots[0].dialogueTurns[0].text='改过的台词。';
  if(change==='reviewer')config.localAgents.providers.grokbuild.model='different';
  if(change==='neighbor')p.shots[0].actualMediaAudit.neighborEvidence=[{shotId:'S2',candidateId:'old'}];
  assert.equal(summarize(p,config,select,opts).passed,false,change);
 }
});
test('old reports without a source fingerprint and incomplete dimensions are not promoted',()=>{
 const p=fixture();approve(p,0);approve(p,1);delete p.shots[0].actualMediaAudit.inputFingerprint;assert.equal(summarize(p,settings,select,opts).passed,false);
 approve(p,0);p.shots[0].actualMediaAudit.dimensions.pop();assert.equal(summarize(p,settings,select,opts).passed,false);
});
