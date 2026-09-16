const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchStore}=require('../app/workbench-store'),{WorkbenchWorkflow}=require('../app/workbench-workflow');
test('failed upstream planning preserves its cause and never audits incomplete asset previews',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-upstream-test-')),store=new WorkbenchStore(root),w=new WorkbenchWorkflow({store,bridge:{},locateFfmpeg:()=>'',stagingRoot:root});
 // Intake has its own tests. This legacy-planning failure fixture must never
 // invoke a real provider while arranging the downstream failure under test.
 w.analyzeScript=async id=>store.getProject(id);
 const inventory=require('../app/source-prop-inventory'),reviews=require('../app/agent-stage-tasks'),prior=inventory.reconcile,priorReview=reviews.reviewStagePrompts;let audits=0;
 inventory.reconcile=async()=>{throw Object.assign(Error('Upstream provider failure'),{code:'SOURCE_PROVIDER_FAILED'});};reviews.reviewStagePrompts=async(items)=>{audits+=items.length;assert.equal(items.length,0);return {status:'skipped'};};
 try{
  let p=store.createProject('Upstream failure',{mode:'asset_direct',commerceMode:'none'});p.script.raw='A person waits.';p.script.formatAdaptation={version:5};p.promptReview={status:'ready',items:[{id:'old',prompt:'retained preview'}],approvedAt:'old'};store.saveProject(p);
  const result=await w.preparePromptReviewBundle(p.id);
  assert.equal(result.assetDesignAuthoring.code,'SOURCE_PROVIDER_FAILED');assert.equal(result.promptReview.status,'pending');assert.ok(Array.isArray(result.promptReview.items));assert.equal(result.promptReview.approvedAt,'');assert.equal(audits,0);
  await assert.rejects(w.preparePromptReviewBundle(p.id,{requireCompleteDelivery:true}),{code:'SOURCE_PROVIDER_FAILED'});assert.equal(audits,0);
 }finally{inventory.reconcile=prior;reviews.reviewStagePrompts=priorReview;}
});
