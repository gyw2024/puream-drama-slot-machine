'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),boundary=require('../app/dialogue-boundary-context'),speech=require('../app/agent-speech-authority');
const fixture=()=>({shots:[1,2,3].map(n=>({id:'S'+n,shotExecution:{duration:10,dialogue:[{id:'D'+n,speakerId:'C1',text:'第'+n+'句完整对白',delivery:'普通'}]},agentProductionDecision:{item:{duration:10,dialogue:[{id:'D'+n,start:1,end:8}]}}}))});
test('parallel authors distinguish unchanged neighbor clocks from another worker unfinished clocks',()=>{
 const p=fixture(),before=structuredClone(p),r=boundary.packet(p,['S2'],['S2','S3'],['S1']);
 assert.deepEqual(r.boundaries.map(b=>[b.left.shotId,b.right.shotId]),[['S1','S2'],['S2','S3']]);
 assert.equal(r.boundaries[0].left.clockFixedForThisRun,true);
 assert.equal(r.boundaries[1].right.revisionPlanned,true);
 assert.equal(r.boundaries[1].right.clockFixedForThisRun,false);
 assert.deepEqual(r.boundaries[0].left.authoredClock,{duration:10,dialogue:[{id:'D1',start:1,end:8}]});
 assert.equal(r.boundaries[1].right.sourceDialogue[0].text,p.shots[2].shotExecution.dialogue[0].text);
 assert.deepEqual(p,before);
});
test('first and last clips receive only existing boundaries and no invented silence verdict',()=>{
 const p=fixture();delete p.shots[1].agentProductionDecision;
 const r=boundary.packet(p,['S1'],['S1','S2']);assert.equal(r.boundaries.length,1);assert.equal(r.boundaries[0].right.authoredClock,null);
 assert.equal(r.ok,undefined);assert.equal(r.passed,undefined);assert.equal(r.issues,undefined);
 assert.equal(boundary.packet({shots:[p.shots[0]]},['S1'],['S1']).boundaries.length,0);
});
test('seven-character closing line supplies the actual relaxed coverage arithmetic without an approval',()=>{
 const doc={shots:[{id:'last',dialogue:[{id:'last-line',text:'好嘞！开门迎客咯！！'}]}]},before=structuredClone(doc),m=speech.screenplayMeasurements(doc)[0];
 assert.equal(m.lines[0].effectiveCharacters,7);assert.equal(m.coverageArithmetic.ordinarySpeechMaximumSeconds,1.4);assert.equal(m.coverageArithmetic.relaxedCoverageUpperBoundSeconds,7.4);
 assert.equal(m.passed,undefined);assert.equal(m.issues,undefined);assert.deepEqual(doc,before);
});
test('observing changed neighbor clocks does not create a new screenplay source fingerprint',()=>{
 const fs=require('fs'),path=require('path'),{fixture:sourceFixture}=require('./shot-screenplay-fixture'),writer=require('../app/shot-screenplay'),director=require('../app/agent-production-decisions');
 const doc=sourceFixture(),second=structuredClone(doc.shots[0]);second.id='S02';second.dialogue[0].id='D02';second.beats[0].dialogueIds=['D02'];doc.shots.push(second);
 const raw=writer.render(doc),record=writer.makeRecord(doc,raw,{},'upload'),data=writer.projectData(record),p={...data,script:{raw,shotScreenplay:record},assetLibraries:{props:data.props,wardrobes:data.wardrobes},product:{},generation:{mode:'asset_direct'}};
 const before=director.sourceFingerprint(p,p.shots[0]);p.shots[1].agentProductionDecision={item:{duration:12,dialogue:[{id:'D02',start:.8,end:11}]}};
 boundary.packet(p,[p.shots[0].id],[p.shots[0].id],['S02']);assert.equal(director.sourceFingerprint(p,p.shots[0]),before);
});
