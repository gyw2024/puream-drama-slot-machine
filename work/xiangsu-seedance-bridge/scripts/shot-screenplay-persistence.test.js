'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const screenplay=require('../app/shot-screenplay'),{fixture}=require('./shot-screenplay-fixture'),{canonicalJson}=require('../app/foundry/canonical');
test('object key order cannot invalidate screenplay but story changes still do',()=>{
 const d=fixture(),raw=screenplay.render(d),record=screenplay.makeRecord(d,raw,{ok:true});
 const persisted=JSON.parse(canonicalJson(record));assert.ok(screenplay.current(persisted,raw));
 persisted.document.shots[0].dialogue[0].text='不同对白';assert.equal(screenplay.current(persisted,raw),false);
 const d2=fixture();d2.shots.push({...structuredClone(d2.shots[0]),id:'S02',dialogue:[],beats:[{...d2.shots[0].beats[0],dialogueIds:[]}]});
 const h=screenplay.hash(d2);d2.shots.reverse();assert.notEqual(screenplay.hash(d2),h);
});
test('accepted screenplay survives actual Foundry SQLite, reload and repeated analysis without model calls',async()=>{
 const {AdaptiveDramaKernel}=require('../app/foundry/kernel'),{WorkbenchStore}=require('../app/workbench-store');
 const base=path.resolve(__dirname,'../../../.codex_tests/TASK-20260913-AGENT-296');fs.mkdirSync(base,{recursive:true});
 const dir=fs.mkdtempSync(path.join(base,'foundry-persistence-'));
 const kernel=new AdaptiveDramaKernel({rootDir:dir});const store=new WorkbenchStore(dir,{encode:x=>x,decode:x=>x,foundryKernel:kernel});
 try{
  let p=store.createProject('数据库逐镜往返验收',{mode:'asset_direct',modeConfirmed:true});
  const d=fixture(),raw=screenplay.render(d);p.script={...p.script,raw,shotScreenplay:screenplay.makeRecord(d,raw,{ok:true})};store.saveProject(p);
  assert.ok(screenplay.current(store.getProject(p.id).script.shotScreenplay,raw));
  const workflow={store,operationControls:new Map(),generateText:()=>assert.fail('must not regenerate unchanged accepted data'),setAutomation:()=>{}};
  p=await require('../app/agent-analysis-entry').analyze(workflow,p.id);
  assert.ok(screenplay.runtimeCurrent(p));assert.ok(screenplay.runtimeCurrent(store.getProject(p.id)));
  const again=await require('../app/agent-analysis-entry').analyze(workflow,p.id);
  assert.deepEqual(again.shots,p.shots);assert.equal(again.shots[0].dialogueTurns[0].text,'妈，我回来了。');
 }finally{kernel.runtime.db.close();}
});
test('legacy fingerprint recovery reviews the full preserved draft instead of rewriting it',async()=>{
 const d=fixture(),raw=screenplay.render(d),calls=[];
 const r=await screenplay.author({source:raw,mode:'upload',draftDocument:d,generate:async(_m,o)=>{calls.push(o.stage);assert.equal(o.stage,'shot_screenplay_review');return {ok:true,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'original dialogue and physical action retained'}],issues:[]};}});
 assert.deepEqual(calls,['shot_screenplay_review']);assert.deepEqual(r.document,d);assert.equal(r.status,'ready');
});
