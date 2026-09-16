'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const writer=require('../app/shot-screenplay');
test('continuing a saved complete text enters intake without another writer request',async()=>{
 const stages=[];
 const result=await writer.author({mode:'upload',source:'已完成原稿',preparedText:'已完成原稿',generate:async(m,o)=>{stages.push(o.stage);assert.equal(JSON.parse(m[1].content).screenplay,'已完成原稿');return document();}});
 assert.deepEqual(stages,['shot_screenplay_structure']);assert.equal(result.status,'ready');
});
function document(){const d=require('./shot-screenplay-fixture').fixture();return {format:'compact-screenplay-v2',story:d.story,characters:d.characters.map(({id,name,description,assetRequired,role,voiceDescription})=>({id,name,description,assetRequired,role,voiceDescription})),scenes:d.scenes.map(({id,name,description,assetRequired})=>({id,name,description,assetRequired})),props:[],shots:d.shots.map(({wardrobeBindings,beats,transition,sound,...s})=>({...s,action:beats.map(b=>b.action).join('\n'),dialogue:s.dialogue.map(({start,end,...t})=>t)}))};}
for(const mode of ['original','upload','adapt'])test(mode+' writes text once, then routes intake to planning without a review gate',async()=>{
 const stages=[],doc=document();let saved;
 const result=await writer.author({mode,source:mode==='original'?'':'完整上传原稿',save:s=>saved=structuredClone(s),generate:async(messages,o)=>{
  stages.push(o.stage);
  if(o.stage==='shot_screenplay_draft'){assert.equal(o.json,false);assert.equal(o.responseSchema,undefined);return '完整中文剧本首稿';}
  assert.equal(o.stage,'shot_screenplay_structure');assert.equal(o.agentStage,'planning');assert.equal(JSON.parse(messages[1].content).screenplay,'完整中文剧本首稿');return doc;
 }});
 assert.deepEqual(stages,['shot_screenplay_draft','shot_screenplay_structure']);assert.equal(saved.writerText,'完整中文剧本首稿');assert.equal(result.status,'ready');assert.equal(result.contentReview.status,'deferred');
});
test('invalid reference is repaired by intake only, preserving source and completed fields',async()=>{
 let drafts=0,intakes=0;const doc=document();
 const result=await writer.author({generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_draft'){drafts++;return '已保存完整首稿';}
  intakes++;if(intakes===1){const bad=structuredClone(doc);bad.shots[0].sceneId='missing';return bad;}
  const input=JSON.parse(m[1].content);assert.equal(input.screenplay,'已保存完整首稿');assert.ok(input.deliveryIssues.length);assert.equal(input.previousStructure.shots[0].sceneId,'missing');return doc;
 }});assert.equal(drafts,1);assert.equal(intakes,2);assert.equal(result.status,'ready');
});
test('interrupted intake resumes the saved writer text without another writer call',async()=>{
 let checkpoint;const doc=document();
 await assert.rejects(writer.author({save:s=>checkpoint=structuredClone(s),generate:async(_m,o)=>{if(o.stage==='shot_screenplay_draft')return '保留原稿';throw Object.assign(Error('network'),{code:'NETWORK_ERROR'});}}));
 const calls=[];const r=await writer.author({checkpoint,generate:async(m,o)=>{calls.push(o.stage);assert.equal(JSON.parse(m[1].content).screenplay,'保留原稿');return doc;}});
 assert.deepEqual(calls,['shot_screenplay_structure']);assert.equal(r.status,'ready');
});
