'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
test('legacy 29-unit duration failure resumes saved content without writing or analysis',async()=>{
 const project={id:'p',script:{raw:'完整原稿'},shots:Array.from({length:29},(_,i)=>({id:'S'+i})),automation:{errorCode:'FILM_RUNTIME_SOURCE_INFEASIBLE',status:'failed'}};
 let calls=0;const ctx={store:{getProject:()=>project},hasActiveOperation:()=>false,preparePromptReviewBundle:async(id,opts)=>{calls++;assert.equal(id,'p');assert.equal(opts.autoApprove,false);return project;}};
 assert.equal(await WorkbenchWorkflow.prototype.resumeScriptGeneration.call(ctx,'p'),project);assert.equal(calls,1);
});
test('speech estimates above film target preserve source and only return review advice',()=>{
 const project={script:{runtimePolicy:{minSeconds:450,maxSeconds:630}},shots:Array.from({length:67},(_,i)=>({id:'S'+i,dialogueTurns:[]}))};
 const before=structuredClone(project),advice=require('../app/film-shot-budget').assertMinimum(project);
 assert.equal(advice.advisory,true);assert.equal(advice.runtimeEvidence.minimum,670);assert.deepEqual(project,before);
});
