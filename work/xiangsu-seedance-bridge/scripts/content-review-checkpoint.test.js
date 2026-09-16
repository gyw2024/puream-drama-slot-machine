'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchStore}=require('../app/workbench-store'),{WorkbenchWorkflow}=require('../app/workbench-workflow');
test('creative disagreement preserves content as a resumable review checkpoint, never as completed or failed',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'drama-content-review-'));
 const store=new WorkbenchStore(dir),p=store.createProject('review checkpoint');p.script.raw='Original immutable screenplay';store.saveProject(p);
 const w=new WorkbenchWorkflow({store,bridge:{},stagingRoot:dir});
 const error=Object.assign(Error('Creative timing disagreement'),{code:'AGENT_DECISION_CONFLICT',issues:['Actor stays outside frame']});
 await assert.rejects(w.runTrackedOperation(p.id,'prepare_prompt_review','',async()=>{throw error;}),e=>e.expectedControl===true&&e.reviewRequired===true);
 const saved=store.getProject(p.id);assert.equal(saved.script.raw,p.script.raw);assert.equal(saved.automation.status,'paused');assert.equal(saved.automation.errorCode,'');assert.equal(saved.automation.contentReviewRequired,true);assert.equal(saved.automation.autoResume,false);assert.deepEqual(saved.automation.contentReviewFindings,error.issues);assert.equal(w.hasActiveOperation(p.id),false);
 await w.runTrackedOperation(p.id,'prepare_prompt_review','',async()=>true);assert.equal(store.getProject(p.id).automation.contentReviewRequired,false);
});
