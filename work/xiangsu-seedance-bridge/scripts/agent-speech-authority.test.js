'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const authority=require('../app/agent-speech-authority');
test('canonical packet removes classified estimates and duplicate lines, preserving source and both arithmetic options',()=>{
 const line={id:'D3',text:'躲雨上别处躲去，别在我这门口杵着碍眼！',delivery:'甩手嫌恶，语速快'};
 const row={id:'S1',shotExecution:{dialogue:[line]},dialogue:[{...line,bounds:{kind:'dialogue',targetCps:5.5,targetSeconds:3.09}}],referenceSpeechGrid:[1,2]};
 const before=structuredClone(row),out=authority.directorShot(row);
 assert.deepEqual(row,before);assert.equal(out.dialogue,undefined);assert.equal(out.referenceSpeechGrid,undefined);
 assert.deepEqual(out.shotExecution,row.shotExecution);
 assert.deepEqual(out.speechMeasurements,[{dialogueId:'D3',effectiveCharacters:17,ordinarySeconds:{minimum:2.833,maximum:3.4},highEmotionMaximumSeconds:2.125}]);
 assert.equal(JSON.stringify(out).split(line.text).length-1,1);
 assert.doesNotMatch(JSON.stringify(out),/targetCps|"kind"|targetSeconds/);
});
test('both timing classes are unselected arithmetic, and input without canonical execution is untouched',()=>{
 const legacy={id:'S1',dialogue:[{id:'D1',text:'原文'}]};assert.equal(authority.directorShot(legacy),legacy);
 const data=authority.directorShot({shotExecution:{dialogue:[{id:'D1',text:'九块九两支。'},{id:'D2',text:'9.9元两支。'}]}});
 assert.equal(data.speechMeasurements[0].effectiveCharacters,5);
 assert.equal(data.speechMeasurements[1].effectiveCharacters,6);
 assert.ok(require('../app/prompt-review-evidence').INSTRUCTION.includes(authority.INSTRUCTION));
});
test('real parallel director path supplies at most five canonical shots without old classified clocks',async()=>{
 const {fixture,decision}=require('./compact-screenplay-fixtures'),writer=require('../app/shot-screenplay'),director=require('../app/agent-production-decisions');
 const doc=fixture(),one=structuredClone(doc.shots[0]);doc.shots=Array.from({length:6},(_,i)=>({...structuredClone(one),id:'S'+i,dialogue:one.dialogue.map(d=>({...d,id:'D'+i}))}));
 const raw=writer.render(doc),record=writer.makeRecord(doc,raw,{}),data=writer.projectData(record);
 let p={...data,id:'parallel-speech-authority',script:{raw,shotScreenplay:record},generation:{engine:'hailuo-h3',mode:'asset_direct'},product:{},assetLibraries:{props:[],wardrobes:[]}};const sizes=[];
 await director.author({getProject:()=>structuredClone(p),saveProject:v=>p=v,projectId:p.id,settings:{textProvider:{}},optionsFor:(_id,stage,o)=>({...o,stage}),generate:async(_provider,m,o)=>{
  assert.equal(o.stage,'master_production_decisions');const u=JSON.parse(m[1].content);sizes.push(u.shots.length);
  assert.equal(u.speechAuthority,authority.INSTRUCTION);
  assert.ok(m[0].content.includes(require('../app/dialogue-boundary-context').INSTRUCTION));
  assert.ok(u.dialogueBoundaries.boundaries.length);
  assert.ok(u.dialogueBoundaries.boundaries.every(b=>b.left.revisionPlanned&&b.right.revisionPlanned));
  for(const s of u.shots){assert.equal(s.dialogue,undefined);assert.equal(s.referenceSpeechGrid,undefined);assert.equal(s.speechMeasurements.length,s.shotExecution.dialogue.length);}
  return {items:u.shots.map(s=>decision(s.shotExecution))};
 }});
 assert.deepEqual(sizes.sort(),[1,5]);assert.equal(p.shots.filter(s=>director.current(p,s)).length,6);
});
test('whole actual-prompt review receives semantic speech authority and invalidates old approval',async()=>{
 const audit=require('../app/prompt-chronology-audit');const source={shots:['S1','S2'].map(id=>({id,duration:10,dialogueTurns:[]}))},items=source.shots.map(s=>({id:s.id,entityId:s.id,entityType:'shot',stage:'shot_video',prompt:'Actual prompt.'}));let calls=0;
 const args={source,items,generate:async m=>{calls++;assert.ok(m[0].content.includes(authority.INSTRUCTION));return {shots:source.shots.map(s=>({shotId:s.id,sourcePhase:'night',proposedPhase:'night',issues:[]}))};}};
 const r=await audit.review(args);await audit.review({...args,checkpoint:r});assert.equal(calls,1);
 await audit.review({...args,checkpoint:{...r,fingerprint:'old authority'}});assert.equal(calls,2);
});
