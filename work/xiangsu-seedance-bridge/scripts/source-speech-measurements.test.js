'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const speech=require('../app/agent-speech-authority'),writer=require('../app/shot-screenplay');
const {fixture}=require('./compact-screenplay-fixtures');
const words=['来，围裙系上，工牌别好——林收银，正式上岗。','姐，头一天，你可得在旁边盯着。','盯着呢。规矩三条：钱货两清、单据当日清、先登记后留宿。','登记本我带来了，新买的，一页没写过。','就从今天记，这一页比什么都金贵。'];
test('captured overcount gives both exact neutral alternatives and leaves source unchanged',()=>{
 const d=fixture();d.shots[0].dialogue=words.map((text,i)=>({...d.shots[0].dialogue[0],id:'D'+i,text}));
 const before=structuredClone(d),lines=speech.screenplayMeasurements(d)[0].lines;
 assert.deepEqual(lines.map(l=>l.effectiveCharacters),[16,12,22,15,14]);
 assert.equal(lines.reduce((s,l)=>s+l.effectiveCharacters,0),79);
 for(const row of lines){assert.equal(row.kind,undefined);assert.ok(row.ordinarySeconds.minimum>row.highEmotionMaximumSeconds);}
 assert.deepEqual(d,before);
});
test('local review evidence includes target and boundary measurements without inflating film packet',()=>{
 const d=fixture();d.shots=Array.from({length:12},(_,i)=>({...structuredClone(d.shots[0]),id:'S'+i,dialogue:words.map((text,n)=>({...d.shots[0].dialogue[0],id:`D${i}_${n}`,text}))}));
 const tasks=require('../app/screenplay-review-partitions').plan({screenplay:d,mode:'upload'},writer.REVIEW_RULES);
 const local=tasks.find(t=>t.kind==='local'&&t.ids[0]==='S5'),packet=JSON.parse(local.messages[1].content);
 assert.deepEqual(packet.speechMeasurements.map(m=>m.shotId),['S4','S5','S6','S7','S8','S9','S10']);
 assert.ok(local.messages[0].content.includes(speech.SOURCE_INSTRUCTION));
 assert.equal(JSON.parse(tasks[0].messages[1].content).speechMeasurements,undefined);
 const before=require('../app/screenplay-review-partitions').evidenceFingerprint(local);
 packet.speechMeasurements[0].lines[0].effectiveCharacters++;
 const changed={...local,messages:[local.messages[0],{role:'user',content:JSON.stringify(packet)}]};
 assert.notEqual(require('../app/screenplay-review-partitions').evidenceFingerprint(changed),before);
});
test('small source review and repair receive exact evidence and Agent verdict alone decides',async()=>{
 const d=fixture();let reviews=0,repairs=0;
 const result=await writer.author({mode:'upload',source:writer.render(d),draftDocument:d,generate:async(messages,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(messages);
  const packet=JSON.parse(messages[1].content);
  assert.deepEqual(packet.speechMeasurements,speech.screenplayMeasurements(d));
  assert.ok(messages[0].content.includes(speech.SOURCE_INSTRUCTION));
  if(o.stage==='shot_screenplay_repair'){repairs++;return {shots:[],additions:[],characters:[],scenes:[],props:[]};}
  assert.equal(o.stage,'shot_screenplay_review');reviews++;
  return {ok:reviews>1,storyComplete:true,sourcePreserved:true,checks:{S01:{evidence:'Actual source compared'}},criteria:Object.fromEntries(['story','commerce','dialogue'].map(k=>[k,{passed:true,evidence:'Compared current input'}])),issues:reviews===1?[{shotIds:['S01'],field:'performance',evidence:'Agent requests independent timing verification',repair:'Recheck actual counts and overlapping actions before splitting'}]:[]};
 }});
 // T05 延期审核：干净已存稿迁移直接 ready，不触发随稿语义审核/修复；语音证据改为在确认页分区审核中断言
 assert.equal(reviews,0);assert.equal(repairs,0);assert.equal(result.status,'ready');assert.deepEqual(result.document,d);
});
