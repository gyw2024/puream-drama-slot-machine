'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const screenplay=require('../app/shot-screenplay');
const {fixture}=require('./shot-screenplay-fixture');
const {WorkbenchWorkflow,ideaSignature}=require('../app/workbench-workflow');
test('a historical fingerprint mismatch preserves the draft without silently approving it',async()=>{
 const d=fixture(),raw=screenplay.render(d),record=screenplay.makeRecord(d,raw,{});
 record.documentHash='historical-key-order-hash';
 assert.equal(screenplay.current(record,raw),false);
 assert.equal(screenplay.hasSavedDraft({raw,shotScreenplay:record}),true);
 assert.equal(screenplay.hasSavedDraft({raw:raw+'changed',shotScreenplay:record}),false);
 const stages=[];
 await screenplay.author({source:raw,mode:'upload',draftDocument:record.document,generate:async(_m,o)=>{
  stages.push(o.stage);return {ok:true,storyComplete:true,sourcePreserved:true,checks:d.shots.map(s=>({shotId:s.id,evidence:'checked source'})),issues:[]};
 }});
 assert.deepEqual(stages,['shot_screenplay_review']);
});
test('repeat writing clicks share a single operation and existing draft bypasses the writer',async()=>{
 const d=fixture(),raw=screenplay.render(d),p={id:'p',script:{raw,shotScreenplay:screenplay.makeRecord(d,raw,{})}};
 p.script.shotScreenplay.documentHash='legacy';p.script.ideaSignature=ideaSignature(p);
 let operations=0,confirmations=0;
 const w={store:{getProject:()=>p},runTrackedOperation:async(_id,_op,_s,fn)=>{operations++;return fn();},prepareWrittenScriptForConfirmation:async()=>{confirmations++;return p;}};
 w.generateCompleteScript=WorkbenchWorkflow.prototype.generateCompleteScript;
 await Promise.all([w.generateCompleteScript('p'),w.generateCompleteScript('p')]);
 assert.equal(operations,1);assert.equal(confirmations,1);assert.equal(w.scriptGenerationFlights.size,0);
});
test('an empty retry checkpoint cannot supersede the saved complete story on resume',async()=>{
 const d=fixture(),raw=screenplay.render(d),p={script:{raw,shotScreenplay:screenplay.makeRecord(d,raw,{}),shotAuthoring:{status:'writing',document:null}}};
 const w={store:{getProject:()=>p},hasActiveOperation:()=>false,generateCompleteScript:()=>assert.fail('must not write'),runTrackedOperation:(_a,_b,_c,fn)=>fn(),prepareWrittenScriptForConfirmation:()=>p};
 assert.equal(await WorkbenchWorkflow.prototype.resumeScriptGeneration.call(w,'p'),p);
});
test('a newer nonempty draft resumes its review rather than falling back to the older accepted text',async()=>{
 const d=fixture(),raw=screenplay.render(d),p={script:{raw,shotScreenplay:screenplay.makeRecord(d,raw,{}),shotAuthoring:{status:'reviewing',document:d}}};
 let resumed=0;const w={store:{getProject:()=>p},hasActiveOperation:()=>false,generateCompleteScript:()=>{resumed++;return p;},prepareWrittenScriptForConfirmation:()=>assert.fail('older source must not override the pending draft')};
 assert.equal(await WorkbenchWorkflow.prototype.resumeScriptGeneration.call(w,'p'),p);assert.equal(resumed,1);
});
test('technical request changes re-review a checkpoint rather than erasing it',async()=>{
 const d=fixture(),topic={title:'same'},product={};let checkpoint;
 const review=async()=>({ok:true,storyComplete:true,sourcePreserved:true,checks:d.shots.map(s=>({shotId:s.id,evidence:'checked'})),issues:[]});
 await screenplay.author({topic,product,draftDocument:d,generate:review,save:s=>{checkpoint=structuredClone(s);}});
 checkpoint.signature='old-prompt-version';let stages=[];
 await screenplay.author({topic,product,checkpoint,generate:async(m,o)=>{stages.push(o.stage);return review();}});
 assert.deepEqual(stages,['shot_screenplay_review']);
});
test('preview rejects malformed fields before formatting and reports their paths',()=>{
 const result=require('../app/mcp/stage-preview').preview({json:true,responseSchema:{type:'object',required:['items'],properties:{items:{type:'array'}}},deliveryPreview:{kind:'master-production-decision',project:{}}},{data:{}});
 assert.equal(result.status,'needs_revision');assert.match(JSON.stringify(result.findings),/items/);assert.equal(result.items,undefined);
});
test('commercial terms change the creative input identity and shared commerce rules reach the writer',()=>{
 const workflow=require('../app/workbench-workflow');
 const p={product:{name:'菊花茶',sellingPoints:'日常茶饮'},productionPlan:{commerceMode:'natural'}};
 const before=workflow.ideaSignature(p),mode=JSON.parse(before).commerceMode;
 assert.notEqual(mode,'none');
 p.product.price='两罐29.9元';p.product.offer='厂家活动：两罐包邮';p.product.purchaseInstructions='点击头像进入橱窗购买';
 assert.equal(workflow.ideaSignatureMatchesProject(before,p),false);
 assert.equal(workflow.ideaSignatureMatchesProject(workflow.ideaSignature(p),p),true);
 assert.ok(screenplay.RULES.includes(require('../app/commerce-performance-system-prompt').SYSTEM_PROMPT));
 assert.match(screenplay.REVIEW_RULES,/product.price、offer、purchaseInstructions/);
});
test('review identity slots expose the exact missing shot before accepting a receipt',async()=>{
 const d=fixture();d.shots.push({...structuredClone(d.shots[0]),id:'S02',dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]});
 const schema=screenplay.reviewSchemaFor(d),audit={ok:true,sourcePreserved:true,storyComplete:true,issues:[],checks:{S01:{evidence:'first source checked'}}};
 const findings=require('../app/agent-output-normalization').inspect(audit,schema);
 assert.ok(findings.some(f=>f.path==='$.checks.S02'));
 audit.checks.S02={evidence:'second source checked'};
 assert.deepEqual(require('../app/agent-output-normalization').inspect(audit,schema),[]);
 const result=await screenplay.author({draftDocument:d,generate:async(m,o)=>{assert.equal(o.responseSchema.properties.checks.type,'object');return audit;}});
 assert.equal(result.status,'ready');assert.deepEqual(result.reviews[0].checks.map(c=>c.shotId),['S01','S02']);
});
