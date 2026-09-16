'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const requirements=require('../app/screenplay-user-requirements'),contract=require('../app/screenplay-output-contract'),solver=require('../app/production-clock-solver');
test('explicit user line count is shared, source attachment counts cannot override it',()=>{
 const r=requirements.extract({synopsis:'单一客厅，严格六条独立完整台词。',reference:'必须九条台词'});
 assert.equal(r.dialogueCount,6);assert.equal(r.singleScene,true);
 const schema=contract.schemaFor(r);assert.equal(schema.properties.scenes.maxItems,1);assert.equal(schema.properties.scenes.items.properties.lines.maxItems,6);
 assert.equal(requirements.issues([{lines:Array.from({length:5},()=>({kind:'dialogue'}))}],r)[0].actual,5);
 assert.equal(requirements.issues([{lines:Array.from({length:6},()=>({kind:'dialogue'}))}],r).length,0);
 assert.equal(requirements.extract({synopsis:'六个人在客厅谈论九条新闻'}).dialogueCount,null);
 assert.equal(requirements.extract({synopsis:'只写六条各自独立的完整台词'}).dialogueCount,6);
 assert.throws(()=>requirements.extract({synopsis:'严格六条台词。必须九条台词。'}),{code:'SCRIPT_REQUIREMENT_CONFLICT'});
});
function timeline(){return {shot:{dialogueTurns:[{text:'一二三四五六七八九十'},{text:'甲乙丙丁戊己庚辛壬癸'}]},item:{duration:10,dialogue:[{id:'d1',start:1,end:3},{id:'d2',start:5,end:7}],events:[{id:'a',start:0,end:.8,after:[],descriptionEn:'A transfers the key.'},{id:'b',start:7.2,end:8,after:['a'],descriptionEn:'B uses the received key.'}],cameras:[{at:0},{at:2}]}};}
test('clock solver fixes a cut inside speech while preserving narrative and action durations',()=>{
 const {shot,item}=timeline(),before=structuredClone(item),out=solver.solve(shot,item);assert.ok(out);assert.deepEqual(item,before);
 assert.ok(!out.item.dialogue.some(d=>out.item.cameras[1].at>d.start&&out.item.cameras[1].at<d.end));
 out.item.events.forEach((e,i)=>{assert.equal(e.descriptionEn,item.events[i].descriptionEn);assert.deepEqual(e.after,item.events[i].after);assert.ok(Math.abs(e.end-e.start-(item.events[i].end-item.events[i].start))<.001);});
 assert.deepEqual(require('../app/drama-performance-timeline').performanceTimelineFailures({duration:out.item.duration,dialogueTurns:shot.dialogueTurns.map((t,i)=>({...t,...out.item.dialogue[i]}))},''),[]);
});
test('impossible silent action, cyclic prerequisites and absent cameras are never accepted',()=>{
 const {shot,item}=timeline();item.events=[{id:'a',start:0,end:5,after:[]}];item.dialogue[0]={...item.dialogue[0],start:5,end:7};item.dialogue[1]={...item.dialogue[1],start:7,end:9};assert.equal(solver.solve(shot,item),null);
 const v=timeline();v.item.events[0].after=['b'];assert.equal(solver.solve(v.shot,v.item),null);v.item.cameras=[];assert.equal(solver.solve(v.shot,v.item),null);
});
test('compressed audit transport keeps every source fact and prompt line with original IDs',()=>{
 const e=require('../app/prompt-review-evidence'),items=[{id:'i1',prompt:'First exact line.\nSecond exact line.',displayPrompt:'逐字译文'}],sourceFacts=e.catalog({shots:[{id:'S01',action:'Exact action',duration:10}]});
 const p={items,sourceFacts,promptFacts:e.promptCatalog(items)},w=e.wirePayload(p);
 assert.deepEqual(w.sourceFacts.rows.map(([id,c,paths,text])=>({id,context:w.sourceFacts.contexts[c],paths,text})),sourceFacts);
 assert.equal(w.promptFacts.map(f=>f.text).join('\n'),items[0].prompt);assert.equal(w.items[0].displayPrompt,items[0].displayPrompt);assert.ok(!('prompt' in w.items[0]));
});
test('source-authored inscription is literal image content, ungrounded Chinese prose still fails',()=>{
 const a=require('../app/asset-description-language'),terms=a.sourceInscriptionLiterals('照片背面还写着随时回家……');assert.deepEqual(terms,['随时回家']);
 assert.equal(a.hasChineseNarrative("The back reads '随时回家'.",terms),false);assert.equal(a.hasChineseNarrative('A man 正在走路',terms),true);
});
test('empty native success and interrupted transport retry once, quota and cancellation never do',async()=>{
 const r=require('../app/local-agent-runtime');for(const code of ['LOCAL_AGENT_RESULT_EMPTY','LOCAL_AGENT_TRANSPORT_INTERRUPTED']){let calls=0;assert.equal(await r.runTextWithEmptyRetry(async()=>{if(++calls===1)throw Object.assign(Error(code),{code});return 'real result';}), 'real result');assert.equal(calls,2);}
 let calls=0;await assert.rejects(r.runTextWithEmptyRetry(async()=>{calls++;throw Object.assign(Error('quota'),{code:'LOCAL_AGENT_QUOTA'});}));assert.equal(calls,1);
 assert.equal(r.processFailureCode('', 'subscriber fell behind updates, stalled for 5s'),'LOCAL_AGENT_TRANSPORT_INTERRUPTED');
});
test('equivalent saved timing aliases reuse review; a real timing edit still requests a new review',async()=>{
 const t=require('../app/agent-stage-tasks'),config={textProvider:{},localAgents:{text:'codex',stages:{review:'codex'},providers:{codex:{model:'test-model'}}}};
 const items=()=>[{id:'shot:S01',entityType:'shot',entityId:'S01',stage:'shot_video',prompt:'Exact fixed prompt.'}];
 const source={shots:[{id:'S01',dialogueTurns:[{sourceDialogueId:'D01',text:'原台词',speakerId:'C01',start:1,end:3,startSecond:1,endSecond:3}]}]};let calls=0,checkpoint;
 const generate=async()=>{calls++;return {items:[{id:'shot:S01',issues:[]}]};};const opts={source,saveCheckpoint:c=>{checkpoint=structuredClone(c);}};
 await t.reviewStagePrompts(items(),config,generate,opts);delete source.shots[0].dialogueTurns[0].start;delete source.shots[0].dialogueTurns[0].end;
 await t.reviewStagePrompts(items(),config,generate,{...opts,checkpoint});assert.equal(calls,1);
 source.shots[0].dialogueTurns[0].startSecond=1.1;await t.reviewStagePrompts(items(),config,generate,{...opts,checkpoint});assert.equal(calls,2);
});
