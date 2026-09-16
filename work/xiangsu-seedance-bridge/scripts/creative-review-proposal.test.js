'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),flight=require('../app/creative-single-flight'),proposal=require('../app/prompt-review-proposal'),editor=require('../app/prompt-review-editor');
test('cross-entry clicks join the same creative task while internal steps can proceed',async()=>{
 const owner={},calls=[];let finish;const wait=new Promise(r=>finish=r);
 const a=flight.run(owner,'p','idea_to_full_pipeline',async()=>{calls.push('writer');await wait;return flight.run(owner,'p','analyze_script',async()=>{calls.push('intake');return 'done';});});
 const b=flight.run(owner,'p','pipeline_from_stage',()=>{calls.push('duplicate');});
 assert.equal(a,b);finish();assert.equal(await b,'done');assert.deepEqual(calls,['writer','intake']);
 assert.equal(await flight.run(owner,'p','analyze_script',()=>42),42);
});
test('failed flights release ownership and independent media calls remain concurrent',async()=>{
 const owner={};await assert.rejects(flight.run(owner,'p','analyze_script',()=>{throw Error('offline');}));assert.equal(await flight.run(owner,'p','analyze_script',()=>1),1);
 let count=0;await Promise.all([flight.run(owner,'p','shot_video',()=>++count),flight.run(owner,'p','shot_video',()=>++count)]);assert.equal(count,2);
});
function setup(){
 let p={id:'p',script:{raw:'source'},shots:[],productionPlan:{simpleAssetOnly:true},promptReview:{status:'ready',items:[{id:'v1',stage:'shot_video',entityId:'s1',label:'第一镜',prompt:'小白说你好',displayPrompt:'小白说你好',status:'draft'}]}};
 const opts={projectId:'p',owner:{},getProject:()=>structuredClone(p),saveProject:v=>{p=structuredClone(v);},applyItem:(_p,i,d,e)=>({...i,displayPrompt:d,prompt:e}),settings:{},edit:async o=>{const snap=o.getProject();const edits=editor.targets(snap).filter(t=>t.owner.itemId&&t.path.at(-1)!=="label").map(t=>({targetId:t.targetId,before:'小白',after:'小黑',reason:'与剧本角色名称一致'}));const r=editor.applyResult(snap,snap,{edits,unresolved:[]},opts.applyItem);assert.equal(r.ok,true,JSON.stringify(r.issues));r.project.promptReview.editor={status:'completed'};r.project.promptReview.items.forEach(i=>i.agentAudit={issues:[]});o.saveProject(r.project);}};
 return {opts,get:()=>p};
}
test('review produces before/after/reasons without changing source; apply is explicit and idempotent',async()=>{
 const x=setup();await proposal.propose(x.opts);assert.equal(x.get().promptReview.items[0].prompt,'小白说你好');assert.equal(x.get().promptReview.proposal.status,'ready');assert.equal(x.get().promptReview.proposal.changes.length,2);assert.match(x.get().promptReview.proposal.changes[0].reasons[0],/角色名称/);
 proposal.apply(x.opts);assert.equal(x.get().promptReview.items[0].prompt,'小黑说你好');assert.equal(x.get().script.raw,'source');assert.equal(x.get().promptReview.proposal.status,'applied');proposal.apply(x.opts);assert.equal(x.get().promptReview.editHistory.length,1);
});
test('stale proposal never overwrites a later user edit',async()=>{
 const x=setup();await proposal.propose(x.opts);const changed=x.opts.getProject();changed.promptReview.items[0].prompt='用户的新版本';x.opts.saveProject(changed);proposal.apply(x.opts);assert.equal(x.get().promptReview.items[0].prompt,'用户的新版本');assert.equal(x.get().promptReview.proposal.status,'stale');
});
test('human confirmation is distinct from an AI audit pass',()=>{
 const r=require('../app/renderer/review-receipt-state');const item={status:'confirmed',userConfirmed:true,agentAudit:{status:'not_verified'}};assert.equal(r.confirmed(item),true);assert.equal(r.state(item.agentAudit),'not_verified');assert.equal(r.approved({status:'approved',items:[item]}),true);
});
