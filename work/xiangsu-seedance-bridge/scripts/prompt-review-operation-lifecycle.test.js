'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchStore}=require('../app/workbench-store');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new WorkbenchStore(dir);const p=store.createProject('lifecycle',{mode:'asset_direct',modeConfirmed:true});const wf=new WorkbenchWorkflow({store,bridge:{}});return {store,p,wf};}
test('standalone review compilation stays active through refresh and duplicate clicks share its work',async t=>{
 const {store,p,wf}=setup(t);let release,calls=0;
 wf.compilePromptReviewBundle=async()=>{calls++;await new Promise(r=>release=r);return store.getProject(p.id);};
 const first=wf.preparePromptReviewBundle(p.id);await new Promise(setImmediate);assert.equal(wf.hasActiveOperation(p.id),true);
 const second=wf.preparePromptReviewBundle(p.id);assert.equal(calls,1);
 wf.reconcileDetachedAutomations(p.id);assert.equal(store.getProject(p.id).automation.status,'running');
 release();await Promise.all([first,second]);assert.equal(wf.hasActiveOperation(p.id),false);assert.equal(wf.promptReviewPreparations.size,0);
});
test('compilation failure releases registration and a later explicit retry runs fresh work',async t=>{
 const {p,wf}=setup(t);let calls=0;wf.compilePromptReviewBundle=async()=>{calls++;throw Object.assign(Error('upstream unavailable'),{code:'TEST_UPSTREAM'});};
 await assert.rejects(wf.preparePromptReviewBundle(p.id),{code:'TEST_UPSTREAM'});assert.equal(wf.hasActiveOperation(p.id),false);assert.equal(wf.promptReviewPreparations.size,0);
 wf.compilePromptReviewBundle=async()=>{calls++;return {ok:true};};await wf.preparePromptReviewBundle(p.id);assert.equal(calls,2);
});
test('nested compilation keeps outer operation registered until its own completion',async t=>{
 const {p,wf}=setup(t);wf.compilePromptReviewBundle=async()=>({ok:true});
 await wf.runTrackedOperation(p.id,'full_pipeline','',async()=>{await wf.preparePromptReviewBundle(p.id);assert.equal(wf.hasActiveOperation(p.id),true);});assert.equal(wf.hasActiveOperation(p.id),false);
});
test('prompt compilation receives an operation cancellation signal',async t=>{
 const {p,wf}=setup(t);let signal;
 wf.compilePromptReviewBundle=async()=>{signal=wf.operationControls.get(p.id).controller.signal;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const pending=wf.preparePromptReviewBundle(p.id);await new Promise(setImmediate);const reason=Object.assign(Error('paused'),{code:'PIPELINE_PAUSED'});wf.operationControls.get(p.id).controller.abort(reason);
 await assert.rejects(pending,{code:'PIPELINE_PAUSED'});assert.equal(signal.aborted,true);assert.equal(wf.hasActiveOperation(p.id),false);assert.equal(wf.promptReviewPreparations.size,0);
});
