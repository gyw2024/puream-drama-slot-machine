'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const writer=require('../app/shot-screenplay'),compact=require('../app/compact-screenplay'),director=require('../app/agent-production-decisions');
function fixture(){const d=require('./shot-screenplay-fixture').fixture();return {format:'compact-screenplay-v2',story:d.story,characters:d.characters.map(({id,name,description,assetRequired,role,voiceDescription})=>({id,name,description,assetRequired,role,voiceDescription})),scenes:d.scenes.map(({id,name,description,assetRequired})=>({id,name,description,assetRequired})),props:[],shots:d.shots.map(({wardrobeBindings,beats,transition,sound,...s})=>({...s,action:beats.map(b=>b.action).join('\n'),dialogue:s.dialogue.map(({start,end,...t})=>t)}))};}
function project(mode){const d=fixture(),raw=writer.render(d),record=writer.makeRecord(d,raw,{}),data=writer.projectData(record);return {...data,id:'compact-test',script:{raw,shotScreenplay:record},generation:{engine:'hailuo-h3',mode},product:{},assetLibraries:{props:data.props,wardrobes:data.wardrobes}};}
function decision(s){return {shotId:s.id,identityContractVersion:1,duration:12,visibleCharacterIds:s.visibleCharacterIds,visiblePropIds:s.propIds,productVisible:s.productVisible,states:s.visibleCharacterIds.map(characterId=>({characterId,openingEn:'Seated beside the table.',openingZh:'坐在桌旁。',endingEn:'Still seated.',endingZh:'仍坐原位。'})),environmentEn:'Living room, north window.',environmentZh:'有北窗的客厅。',objectStates:[],events:[{id:'E01',actorIds:s.visibleCharacterIds,offscreenActorIds:[],propIds:[],usesProduct:false,start:0,end:12,after:[],continuityActionIds:[],throughoutDialogueIds:[],recordedSpeech:null,descriptionEn:'The daughter looks toward her mother, who listens.',descriptionZh:'女儿看着母亲，母亲倾听。'}],cameras:[{at:0,size:'medium',angle:'front',movement:'locked',subjectIds:s.visibleCharacterIds}],dialogue:s.dialogue.map(d=>({id:d.id,start:.3,end:2,listenerIds:d.listenerIds,addressMode:d.addressMode,deliveryEn:'Warm and clear natural female voice.',deliveryZh:d.delivery})),summaryEn:'Daughter greets mother.',soundscapeEn:'Quiet room ambience.'};}
test('compact materialization preserves exact words/actions without inventing timeline or wardrobe',()=>{
 const d=fixture();assert.deepEqual(writer.issues(d),[]);const p=project('asset_direct');assert.ok(writer.runtimeCurrent(p));
 assert.equal(p.shots[0].action,d.shots[0].action);assert.equal(p.shots[0].dialogueTurns[0].text,d.shots[0].dialogue[0].text);
 assert.equal(p.shots[0].dialogueTurns[0].startSecond,undefined);assert.equal(p.shots[0].shotExecution.beats,undefined);assert.deepEqual(p.wardrobes,[]);
 assert.equal(p.script.raw.split(d.shots[0].dialogue[0].text).length-1,1);assert.ok(!p.script.raw.includes('undefined'));
});
for(const mode of ['original','upload','adapt'])test(mode+': compact writer uses one whole-script task and explicit story/commerce/dialogue receipts',async()=>{
 const d=fixture();if(mode==='adapt')d.adaptation={title:'一杯茶',kernel:'团聚',ending:'相伴',replacements:[],productName:'',productLocks:[],warnings:[],beats:[]};
 let writes=0,reviews=0;const result=await writer.author({mode,source:mode==='original'?'':'完整原稿',generate:async(messages,o)=>{
  // T05 延期审核：干净结构稿直接 ready；写稿拆为 draft(纯文本)+structure(文档) 两段
  if(o.stage==='shot_screenplay_draft'){writes++;assert.equal(JSON.parse(messages[1].content).mode,mode);assert.equal(JSON.parse(messages[1].content).source,mode==='original'?'':'完整原稿');return '整稿正文一次写完';}
  if(o.stage==='shot_screenplay_structure'){assert.equal(o.responseSchema.properties.shots.items.properties.beats,undefined);assert.equal(o.responseSchema.properties.shots.items.properties.dialogue.items.properties.start,undefined);return d;}
  reviews++;assert.ok(o.responseSchema.required.includes('criteria'));return {ok:true,storyComplete:true,sourcePreserved:true,checks:{S01:{evidence:'完整原文对应'}},criteria:{story:{passed:true,evidence:'冲突与结尾保持'},commerce:{passed:true,evidence:'本测试不带货'},dialogue:{passed:true,evidence:'原句完整一次'}},issues:[]};
 }});assert.equal(writes,1);assert.equal(reviews,0,'语义审核延期至提示词确认页，不随写作触发');assert.equal(result.status,'ready');
});
for(const mode of ['asset_direct','keyframe','storyboard_sheet'])test(mode+': compact director chooses timing, receives own source, and preserves dialogue identity',async()=>{
 let p=project(mode),calls=0;const original=structuredClone(p.shots[0].shotExecution);
 const schema=director.schema(p,p.shots),entry=schema.properties.items.items.anyOf[0].properties;
 assert.equal(entry.duration.const,undefined);assert.equal(entry.dialogue.items.anyOf[0].properties.start.const,undefined);
 await director.author({getProject:()=>structuredClone(p),saveProject:x=>p=x,projectId:p.id,settings:{textProvider:{}},optionsFor:(_id,stage,o)=>({...o,stage}),generate:async(_c,m,o)=>{
  calls++;assert.equal(o.stage,'master_production_decisions');const input=JSON.parse(m[1].content);assert.equal(input.completeOriginalSource,undefined);assert.equal(input.wholeFilmSource,undefined);assert.equal(input.shots[0].shotExecution.action,original.action);assert.ok(m[0].content.startsWith(require('../app/generation-prompts').build('director')));return {items:[decision(input.shots[0].shotExecution)]};
 }});assert.equal(calls,1);assert.equal(p.shots[0].duration,12);assert.deepEqual(p.shots[0].shotExecution,original);assert.equal(p.shots[0].dialogueTurns[0].text,original.dialogue[0].text);assert.ok(director.current(p,p.shots[0]));
 const bad=decision(original);bad.dialogue[0].id='missing';assert.throws(()=>director.validate(p,p.shots[0],bad));
});
module.exports={fixture,project,decision};
