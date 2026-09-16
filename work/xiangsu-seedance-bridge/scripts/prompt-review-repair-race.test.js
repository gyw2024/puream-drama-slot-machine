'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
test('late confirmation during live repair preserves the pending project without compiling or saving stale items',async()=>{
 const project={id:'repairing',promptReview:{status:'pending',items:[{id:'S01',prompt:'saved good text'}]},automation:{status:'running',stage:'prompt_review'}};
 const before=JSON.stringify(project),ctx={store:{getProject:()=>project,saveProject:()=>{throw new Error('must not save stale review');}},promptReviewIsCurrent:()=>{throw new Error('pending review is not confirmable');}};
 assert.equal(await WorkbenchWorkflow.prototype.confirmAllPromptReview.call(ctx,project.id,[{id:'S01',prompt:'stale edit'}]),project);
 assert.equal(await WorkbenchWorkflow.prototype.confirmPromptReviewItem.call(ctx,project.id,'S01','stale edit'),project);
 assert.equal(JSON.stringify(project),before);
});
