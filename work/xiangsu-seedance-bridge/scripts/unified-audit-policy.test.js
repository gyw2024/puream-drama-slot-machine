'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),policy=require('../app/unified-audit-policy');
test('shared audit scopes accept declared aliases and reject unknown routing rather than lose rules',()=>{
 const s='shared prefix\n<!-- audit-scopes: assets,prompts -->\nCOLLECTION\n<!-- audit-scopes: media -->\nMEDIA';
 for(const stage of ['asset','storyboard','video']){const p=policy.scopedStandard(s,[stage]);assert.match(p,/COLLECTION/);assert.doesNotMatch(p,/MEDIA/);}
 assert.throws(()=>policy.scopedStandard('<!-- audit-scopes: unknowable -->\nX',['asset']),/Unknown audit scope/);
 const tasks=require('../app/agent-stage-tasks');for(const item of [{entityType:'character',stage:'character_intro'},{entityType:'shot',stage:'storyboard_sheet'},{entityType:'shot',stage:'shot_video'}])assert.match(tasks.promptReviewRules([item]),/Collection\/member metadata/);
});
test('generation defaults are stage scoped and review defaults keep one current audit policy; superseded quotas are absent',()=>{
 const templates=require('../app/prompt-library').defaultPromptTemplates();assert.equal(Object.keys(templates).length,68);
 for(const [name,text]of Object.entries(templates)){
  const generation=require('../app/generation-template-defaults').defaults(); if(Object.hasOwn(generation,name)){assert.equal(text,generation[name],name);assert.equal(text.split(policy.INSTRUCTION).length-1,0,name);}else assert.equal(text.split(policy.INSTRUCTION).length-1,1,name);
  assert.doesNotMatch(text,/at most two (?:complete |spoken )?(?:sentences|lines|speakers)|最多\s*2句|最多两句|最多2名说话|主反转.*(?:70%|0\.7)|连续静默.*建议/i,name);
 }
});
test('evidence unknown, defect, skipped and passed remain distinct',()=>{
 assert.equal(policy.receiptState({issues:[],status:'needs_evidence'}),'needs_evidence');
 assert.equal(policy.receiptState({issues:[],unresolvedFindings:['fact absent']}),'needs_evidence');
 assert.equal(policy.receiptState({issues:['real violation']}),'defect');
 assert.equal(policy.receiptState({issues:[],ok:true,skipped:true}),'not_verified');
 assert.equal(policy.receiptState({issues:[]}),'passed');
});
test('unchanged failed request diagnoses once and then saves pending evidence without a time cap',async()=>{
 const request=require('../app/audit-progress').request,journal={},calls=[];
 const args={journal,stage:'review',messages:[{role:'user',content:'same facts'}],schema:{},generate:async m=>{calls.push(m);return {ok:false};}};
 await request(args);await assert.rejects(request(args),{code:'AGENT_EVIDENCE_PENDING'});await assert.rejects(request(args),{code:'AGENT_EVIDENCE_PENDING'});assert.equal(calls.length,2);assert.match(calls[1].at(-1).content,/Diagnose/);
 await request({...args,messages:[{role:'user',content:'new evidence'}]});assert.equal(calls.length,3);
});
test('independent adjudicator supplements missing evidence without turning it into a defect or pass',async()=>{
 const verify=require('../app/prompt-finding-verification').verify;let calls=0;
 const result=await verify({result:{items:[{id:'S1',issues:['unclear original holder']}]},payload:{source:'held by A'},generate:async m=>{calls++;return {decisions:[{id:'S1#0',verdict:'needs_evidence',reason:'Original image evidence is not supplied; holder cannot be verified.'}]};}});
 assert.equal(calls,2);assert.deepEqual(result.items[0].issues,[]);assert.equal(result.items[0].unresolvedFindings.length,1);assert.equal(policy.receiptState(result.items[0]),'needs_evidence');
});
test('timed commerce measures partial mixed speech and source action with shared union arithmetic',async()=>{
 const ed=require('../app/commerce-editorial-contract'),projection=require('../app/approved-source-commerce');
 const project={product:{name:'测试膏'},shots:[{id:'S1',duration:10,dialogueTurns:[{text:'先说你的事，这盒三十九元。',start:1,end:7}],subshots:[{action:'他给她演示按压泵头。',start:3,end:6}]}]};
 const units=ed.projectUnits(project),rows=[{eventId:'S1:turns:0',purpose:'offer',start:4,end:6},{eventId:'S1:actions:0',purpose:'verified_demonstration',start:3,end:5}];
 const bound=ed.bindEvidenceClock(units,{editorial:{intervals:rows}});const measured=ed.timedEvidence(units,bound.editorial.intervals,.057);assert.deepEqual(measured.issues,[]);assert.equal(measured.timing.effectiveSeconds,3);
 const result=await projection.review({project,mode:'natural',targetRatio:.057,sourceProof:{inputFingerprint:'verified-source'},generate:async()=>({items:rows.map(r=>({id:r.eventId,purpose:r.purpose,start:r.start,end:r.end,reason:'source-evidenced effective interval'}))})});
 assert.equal(result.ok,true);assert.equal(result.timing.effectiveSeconds,measured.timing.effectiveSeconds);assert.equal(result.semanticApproval,false);
});
test('review execution profile includes inherited provider and model while excluding credentials and timeout',()=>{
 const a={localAgents:{text:'workbuddy',stages:{review:'inherit'},providers:{workbuddy:{model:'hy4',reasoningEffort:'medium',speed:'fast',timeoutSeconds:30,apiKey:'secret'}}}};
 const p=policy.executionProfile(a);assert.equal(p.source,'workbuddy');assert.equal(p.profile.model,'hy4');assert.equal(JSON.stringify(p).includes('secret'),false);
 const b=structuredClone(a);b.localAgents.providers.workbuddy.timeoutSeconds=999;assert.deepEqual(policy.executionProfile(b),p);b.localAgents.providers.workbuddy.model='glm';assert.notDeepEqual(policy.executionProfile(b),p);
});
test('disabled old gate is recorded as unverified and does not satisfy a newly enabled gate',()=>{
 const w=require('../app/workbench-workflow'),audit=w.skippedQualityAudit('shot_video');assert.equal(audit.ok,null);assert.equal(audit.status,'not_verified');assert.equal(w.qualityAccepted({filePath:'saved.mp4',stage:'shot_video',qualityAudit:audit},{generation:{qualityGatesEnabled:true,qualityGateModules:{videos:true}}}),false);
});
