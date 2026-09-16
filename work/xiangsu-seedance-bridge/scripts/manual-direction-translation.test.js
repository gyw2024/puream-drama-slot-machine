'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const manual=require('../app/manual-direction-translation');
test('manual source directions are translated without rewriting dialogue or timing and reused only for the same input',async()=>{
 let p={productionPlan:{simpleAssetOnly:true},characters:[{id:'C1',name:'父亲'}],shots:[{id:'S1',action:'父亲把倒扣的木碗扶正，收回左手。',dialogueTurns:[{speakerId:'C1',text:'先别动。',startSecond:5,endSecond:7}]}]},calls=0;
 const original=structuredClone(p.shots[0]);const opts={getProject:()=>p,saveProject:v=>(p=v),generate:async messages=>{calls++;assert.ok(messages[1].content.includes(original.action));return {items:[{id:'S1:action',translation:'C1 turns the inverted wooden bowl upright, then withdraws his left hand.'}]};}};
 await manual.translate(opts);await manual.translate(opts);assert.equal(calls,1);assert.equal(p.shots[0].action,original.action);assert.deepEqual(p.shots[0].dialogueTurns,original.dialogueTurns);assert.match(manual.completeDirections(p,p.shots[0]),/inverted wooden bowl/);assert.equal(p.manualDirectionTranslation.status,'completed');p.shots[0].action+='保持站位。';await manual.translate(opts);assert.equal(calls,2);
});
test('partial manual translations keep original source and resume only missing fields',async()=>{
 let p={productionPlan:{simpleAssetOnly:true},characters:[],shots:[{id:'S1',action:'扶正碗。',stateAfter:'双手收回。'}]};const inputs=[];
 const opts={getProject:()=>p,saveProject:v=>(p=v),generate:async messages=>{const items=JSON.parse(messages[1].content).items;inputs.push(items);return {items:[{id:items[0].id,translation:'Retain the source physical state.'}]};}};
 await manual.translate(opts);assert.equal(p.manualDirectionTranslation.status,'needs_attention');await manual.translate(opts);assert.equal(inputs[1].length,1);assert.equal(inputs[1][0].id,'S1:stateAfter');assert.equal(p.manualDirectionTranslation.status,'completed');assert.equal(p.shots[0].promptCompilationPending,undefined);
});
test('commerce classification uses source event identity without inventing or retyping timing',()=>{
 const c=require('../app/commerce-editorial-contract'),units=[{id:'S1',duration:10,text:'喜欢这花香，咱们一起喝。',turns:[{text:'喜欢这花香，咱们一起喝。',start:2,end:5}],actions:[]}];
 const event=c.timedSourceEvents(units)[0],bound=c.bindEvidenceClock(units,{editorial:{intervals:[{eventId:event.eventId,purpose:'feature_explanation',quote:'错误片段',start:3,end:4}]}}).editorial.intervals[0];assert.equal(bound.quote,units[0].turns[0].text);assert.equal(bound.start,3);assert.equal(bound.end,4); // Keep the Agent-selected effective portion within the source event.
});
