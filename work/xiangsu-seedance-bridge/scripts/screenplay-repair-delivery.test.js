'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const protocol=require('../app/screenplay-repair-delivery'),writer=require('../app/shot-screenplay'),mcp=require('../app/mcp/stage-delivery');
function fixture(){const d=require('./shot-screenplay-fixture').fixture();for(let i=2;i<=3;i++)d.shots.push({...structuredClone(d.shots[0]),id:'S0'+i,dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]});return d;}
function context(d){return {kind:'screenplay-repair',document:d,requested:['S01'],completing:false,mode:'original',entityKeys:['characters','scenes','props','wardrobes']};}
function blankShot(d,id){return {...structuredClone(d.shots[1]),id};}
test('explicit dependency and insertion graphs do not depend on declaration order',()=>{
 const d=fixture(),c=context(d),patch={shots:[{...d.shots[2],ending:'Agent changed upstream dependency'}],additions:[{afterShotId:'A',shot:blankShot(d,'B')},{afterShotId:'S03',shot:blankShot(d,'A')}],scopeExtensions:[{shotId:'S03',dependsOnShotId:'S02',evidence:'Agent explains S03 dependency'},{shotId:'S02',dependsOnShotId:'S01',evidence:'Agent explains S02 dependency'},{shotId:'A',dependsOnShotId:'S03',evidence:'Redundant annotation of new split'}]};
 const r=protocol.assemble(c,patch);assert.deepEqual(r.findings,[]);assert.deepEqual(r.candidate.shots.map(s=>s.id),['S01','S02','S03','A','B']);assert.deepEqual(r.candidate.shots[0],d.shots[0]);assert.deepEqual(r.candidate.shots[1],d.shots[1]);
});
test('MCP rejects exact wrong field before receipt and accepts the corrected same task',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'screenplay-precommit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const d=fixture(),c=context(d),bad={shots:[{...d.shots[1],ending:'A real change'}],additions:[]};
 fs.writeFileSync(dir+'/request.json',JSON.stringify({jobId:'agent_test',json:true,deliveryPreview:c}));fs.writeFileSync(dir+'/job.json',JSON.stringify({status:'running'}));
 const first=mcp.submit(dir,{data:bad});assert.equal(first.status,'needs_revision');assert.equal(first.preview.findings[0].path,'$.shots[0].id');assert.match(first.preview.findings[0].reason,/S02/);assert.equal(mcp.read(dir),null);
 bad.scopeExtensions=[{shotId:'S02',dependsOnShotId:'S01',evidence:'Agent verified causal dependency'}];assert.equal(mcp.submit(dir,{data:bad}).status,'saved');assert.deepEqual(mcp.read(dir).value,bad);assert.equal(fs.readFileSync(dir+'/mcp-submissions.jsonl','utf8').trim().split('\n').length,2);
});
test('invalid anchors, removed anchors, unknown IDs and duplicate speech stay visible',()=>{
 const d=fixture(),c=context(d);let r=protocol.assemble(c,{shots:[],additions:[{afterShotId:'missing',shot:blankShot(d,'A')}]});assert.equal(r.ok,false);assert.match(JSON.stringify(r.findings),/missing/);
 r=protocol.assemble({...c,requested:['S01','S02']},{shots:[],removeShotIds:['S02'],additions:[{afterShotId:'S02',shot:blankShot(d,'A')}]});assert.equal(r.ok,false);assert.match(JSON.stringify(r.findings),/removed/);
 r=protocol.assemble(c,{shots:[],additions:[{afterShotId:'S01',shot:{...structuredClone(d.shots[0]),id:'A'}}]});assert.equal(r.ok,false);assert.match(JSON.stringify(r.findings),/duplicate dialogue ID D01/);
});
test('legacy saved patch correction survives cancellation and policy migration without another full repair',async()=>{
 const d=fixture(),bad={shots:[{...d.shots[1],ending:'Agent corrected ending'}],additions:[]},controller=new AbortController();let saved,fullRepairs=0,reviews=0;
 const generate=async(m,o)=>{if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);if(o.stage==='shot_screenplay_write')return d;if(o.stage==='shot_screenplay_review'){reviews++;return {ok:false,storyComplete:true,sourcePreserved:true,checks:d.shots.map(s=>({shotId:s.id,evidence:'Agent source evidence'})),issues:[{shotIds:['S01'],field:'ending',evidence:'dependency issue',repair:'fix dependency'}]};}if(o.stage==='shot_screenplay_repair'){fullRepairs++;assert.equal(o.deliveryPreview.kind,'screenplay-repair');return bad;}controller.abort();throw Error('deliberate interruption');};
 await assert.rejects(writer.author({generate,signal:controller.signal,save:s=>saved=structuredClone(s)}),/deliberate interruption/);assert.deepEqual(saved.pendingRepairPatch,bad);saved.signature='older-policy';
 const result=await writer.author({checkpoint:saved,generate:async(m,o)=>{assert.notEqual(o.stage,'shot_screenplay_write');assert.notEqual(o.stage,'shot_screenplay_repair');if(o.stage==='shot_screenplay_repair_fields'){const input=JSON.parse(m[1].content);assert.deepEqual(input.draftPatch,bad);const changes={changes:[{path:['scopeExtensions'],value:[{shotId:'S02',dependsOnShotId:'S01',evidence:'Verified actual dependency'}]}]};assert.equal(require('../app/mcp/stage-preview').preview({json:true,responseSchema:o.responseSchema,deliveryPreview:o.deliveryPreview},{data:changes}).ok,true);return changes;}return {ok:true,storyComplete:true,sourcePreserved:true,checks:d.shots.map(s=>({shotId:s.id,evidence:'Fresh current-policy review'})),issues:[]};}});
 assert.equal(fullRepairs,1);assert.equal(reviews,1);assert.equal(result.document.shots[1].ending,bad.shots[0].ending);assert.deepEqual(result.document.shots[0],d.shots[0]);assert.equal(result.pendingRepairPatch,undefined);
});
test('saved repair recovery requires same project and exact source facts, not current model or boilerplate',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'screenplay-recovery-')),dir=root+'/agent_test';fs.mkdirSync(dir);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const input={mode:'original',originalSource:'source',product:{name:'toothpaste'},screenplay:fixture(),allowedShotIds:['S01'],findings:[{field:'ending',evidence:'actual evidence'}]};
 fs.writeFileSync(dir+'/request.json',JSON.stringify({jobId:'agent_test',json:true,messages:[{role:'user',content:JSON.stringify(input)}]}));fs.writeFileSync(dir+'/job.json',JSON.stringify({status:'running'}));const value={shots:[],additions:[]};mcp.submit(dir,{data:value});const jobs=[{id:'agent_test',projectId:'p',operation:'shot_screenplay_repair'}],c={recoverSaved:true,recoveryKey:protocol.recoveryKey({...input,deliveryIssues:['old generic transport failure']})};
 assert.deepEqual(protocol.recover(root,jobs,'p',c).saved.value,value);assert.equal(protocol.recover(root,jobs,'other',c),null);assert.equal(protocol.recover(root,jobs,'p',{...c,recoveryKey:protocol.recoveryKey({...input,product:{name:'another'}})}),null);
 const tampered=JSON.parse(fs.readFileSync(dir+'/mcp-result.json','utf8'));tampered.value.shots.push({id:'tampered'});fs.writeFileSync(dir+'/mcp-result.json',JSON.stringify(tampered));assert.equal(protocol.recover(root,jobs,'p',c),null);
});
test('field corrections preserve unrelated bytes and reject prototype or nonexistent parent paths',()=>{
 const base={shots:[{id:'S01',ending:'old'}],additions:[]},r=protocol.correct(base,{changes:[{path:['shots',0,'ending'],value:'new'}]});assert.equal(r.shots[0].ending,'new');assert.equal(base.shots[0].ending,'old');assert.throws(()=>protocol.correct(base,{changes:[{path:['__proto__','x'],value:1}]}));assert.throws(()=>protocol.correct(base,{changes:[{path:['missing','x'],value:1}]}));
});
test('explicit draft row removal preserves the source and null rows return precise field feedback',()=>{
 const d=fixture(),c=context(d),base={shots:[{...d.shots[1],ending:'accidental unrelated row'},{...d.shots[0],ending:'intended edit'}],additions:[]};
 const patch=protocol.correct(base,{changes:[{path:['shots',0],op:'remove'}]});assert.equal(patch.shots.length,1);const r=protocol.assemble(c,patch);assert.equal(r.ok,true);assert.deepEqual(r.candidate.shots[1],d.shots[1]);
 const bad=protocol.assemble(c,{shots:[null],additions:[]});assert.equal(bad.ok,false);assert.equal(bad.findings[0].path,'$.shots[0]');assert.match(bad.findings[0].reason,/op:remove/);assert.throws(()=>protocol.correct(base,{changes:[{path:['shots',0]}]}),/requires value/);
});

