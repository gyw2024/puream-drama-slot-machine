'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const time=require('../app/screenplay-time-authority');
test('actual writer and partitioned source reviewer packets share the two-clock capability without changing source',()=>{
 const writer=require('../app/shot-screenplay'),parts=require('../app/screenplay-review-partitions'),compact=require('../app/compact-screenplay');
 const doc=require('./shot-screenplay-fixture').fixture();
 doc.shots=Array.from({length:6},(_,i)=>({...structuredClone(doc.shots[0]),id:'S'+i}));
 const before=structuredClone(doc),input={mode:'upload',screenplay:doc,originalSource:'immutable source',product:{}};
 assert.ok(writer.RULES.includes(time.INSTRUCTION));
 assert.ok(writer.REVIEW_RULES.includes(time.INSTRUCTION));
 assert.ok(compact.DIRECTOR_INSTRUCTION.includes(time.INSTRUCTION));
 const tasks=parts.plan(input,writer.REVIEW_RULES);
 assert.equal(tasks.length,3); // One film review owns causality; two local batches own execution.
 for(const task of tasks)assert.ok(task.messages[0].content.includes(time.INSTRUCTION),task.key);
 assert.deepEqual(doc,before);
 assert.ok(require('../app/prompt-review-evidence').INSTRUCTION.includes(time.INSTRUCTION));
});
test('actual final chronology review receives two-clock authority and caches only its current request',async()=>{
 const audit=require('../app/prompt-chronology-audit');
 const source={shots:[{id:'S1',duration:10,action:'杯子放下；明确省略五分钟后反馈。',dialogueTurns:[]},{id:'S2',duration:10,action:'继续交流。',dialogueTurns:[]}]};
 const items=source.shots.map(s=>({id:s.id,entityId:s.id,entityType:'shot',stage:'shot_video',prompt:'[Shot 1] Before. [Shot 2] At 00:05.000, after the explicitly authored ellipsis.'}));
 let calls=0;const args={source,items,execution:{model:'test'},generate:async messages=>{
  calls++;assert.ok(messages[0].content.includes(time.INSTRUCTION));
  return {shots:source.shots.map(s=>({shotId:s.id,sourcePhase:'source authored phase',proposedPhase:'same authored phase',issues:[]}))};
 }};
 const receipt=await audit.review(args);assert.equal(calls,1);
 await audit.review({...args,checkpoint:receipt});assert.equal(calls,1);
 await audit.review({...args,checkpoint:{...receipt,fingerprint:'obsolete temporal authority'}});assert.equal(calls,2);
});
