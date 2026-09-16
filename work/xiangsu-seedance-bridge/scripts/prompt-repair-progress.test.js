'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),progress=require('../app/prompt-repair-progress');
const fixture=()=>({project:{script:{raw:'原文保留'}},items:[{id:'shot:S1',prompt:'Current complete prompt',agentAudit:{issues:['A real source-supported finding']}}]});
test('interrupted repair resumes the same journal while completed unchanged repair cannot repeat',()=>{
 const {project:p,items}=fixture(),key=progress.reserve(p,items,{}),first=p.promptRepairProgress.attempted[key].startedAt;
 progress.settle(p,key,Object.assign(Error('User pause'),{code:'PROVIDER_REQUEST_ABORTED'}));
 assert.equal(p.promptRepairProgress.attempted[key].status,'interrupted');assert.equal(progress.reserve(p,items,{}),key);
 assert.equal(p.promptRepairProgress.attempted[key].startedAt,first);assert.equal(p.promptRepairProgress.attempted[key].resumeCount,1);
 progress.settle(p,key);assert.throws(()=>progress.reserve(p,items,{}),e=>e.code==='AGENT_EVIDENCE_PENDING');
});
test('an in-process duplicate is blocked but an interrupted previous process can resume',()=>{
 const {project:p,items}=fixture(),key=progress.reserve(p,items,{});
 assert.throws(()=>progress.reserve(p,items,{}),e=>e.code==='AGENT_EVIDENCE_PENDING');
 p.promptRepairProgress.attempted[key].ownerPid=-1;assert.equal(progress.reserve(p,items,{}),key);
 assert.equal(p.promptRepairProgress.attempted[key].resumeCount,1);
});
test('legacy pending journal has no fabricated completed result and migrates once',()=>{
 const {project:p,items}=fixture(),key=progress.reserve(p,items,{}),old={startedAt:'old',itemIds:['shot:S1']};p.promptRepairProgress.attempted[key]=old;
 assert.equal(progress.reserve(p,items,{}),key);assert.equal(p.promptRepairProgress.attempted[key].legacyResume,true);
 assert.throws(()=>progress.reserve(p,items,{}));progress.settle(p,key);assert.throws(()=>progress.reserve(p,items,{}));
});
test('provider recovery preserves source while unexpected failures require new evidence',()=>{
 const {project:p,items}=fixture(),key=progress.reserve(p,items,{});progress.settle(p,key,Object.assign(Error('Unavailable'),{code:'RATE_LIMIT'}));
 assert.equal(progress.reserve(p,items,{}),key);progress.settle(p,key,Object.assign(Error('Internal defect'),{code:'INTERNAL_DEFECT'}));assert.throws(()=>progress.reserve(p,items,{}));
 items[0].prompt+=' Changed by its Agent';assert.notEqual(progress.reserve(p,items,{}),key);assert.equal(p.script.raw,'原文保留');
});
