"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const runtime=require("../app/local-agent-runtime"),routing=require("../app/agent-stage-routing"),tasks=require("../app/agent-stage-tasks"),{catalogWithFiles}=require("../app/fixed-sfx-library");
const base=path.resolve(__dirname,"../../../.codex_tests/TASK-20260906-AGENT-STAGES-182/runtime");fs.mkdirSync(base,{recursive:true});
const settings=()=>runtime.bindAgentSettings({textProvider:{apiKey:"offline-only"},localAgents:{text:"codex",stages:{planning:"antigravity",review:"workbuddy",postProduction:"grokbuild"},providers:Object.fromEntries(runtime.AGENTS.map(a=>[a.id,{transport:"mcp"}]))}},base);
test("four stages route independently and keep API secrets unmodified",()=>{
 const config=settings();for(const [costOperation,id]of [["topics","codex"],["script_units","codex"],["script_analysis_chunk_1","antigravity"],["hailuo_prompt_S01","antigravity"],["script_review","workbuddy"],["post_sfx_match","grokbuild"]])assert.equal(routing.resolveStageProvider(config.textProvider,{costOperation}).localAgent.id,id);
 assert.equal(config.textProvider.apiKey,"offline-only");config.textProvider.localAgentRouting.settings.stages.review="api";assert.equal(routing.resolveStageProvider(config.textProvider,{agentStage:"review"}).localAgent,undefined);
});
test("legacy config inherits writing; post stays free local; invalid IDs cannot bypass normalization",()=>{
 const s=runtime.normalizeSettings({text:"codex",stages:{review:"invalid"}});assert.equal(routing.stageSource(s,"planning"),"codex");assert.equal(routing.stageSource(s,"review"),"codex");assert.equal(routing.stageSource(s,"postProduction"),"local");
});
test("real broker receives four different stage assignments without upstream generation",async()=>{
 const config=settings(),hub=runtime.getHub(config.textProvider.localAgentRouting.rootDir);
 for(const stage of ["writing","planning","review","postProduction"]){const id=routing.stageSource(config.localAgents,stage),workerId=`offline-${stage}`;hub.register({agentId:id,workerId,capabilities:{text:true}});
 const pending=require("../app/ai-provider").generateText(config.textProvider,[{role:"user",content:"offline stage fixture"}],{agentStage:stage,json:true});
 for(let n=0;n<30&&!hub.list().some(j=>j.status==="waiting_agent");n++)await new Promise(r=>setTimeout(r,10));
 const job=hub.list().find(j=>j.status==="waiting_agent");assert.equal(job.agentId,id);const claim=hub.claim({jobId:job.id,workerId});hub.complete({...claim,workerId,text:JSON.stringify({stage})});assert.deepEqual(await pending,{stage});}
});
test("stderr-only help is retained separately from generated stdout",async()=>{
 const r=await runtime.runProcess(process.execPath,["-e","process.stderr.write('Usage of agy.exe: --input-format --output-format')"],{cwd:base,timeoutMs:1000});assert.equal(r.output,"");assert.match(r.stderr,/agy.exe/);
 assert.throws(()=>runtime.finalEvent({event:"result",result:{status:"ERROR",error:"fixture"}}),{code:"LOCAL_AGENT_RESULT_FAILED"});
});
const project=()=>({id:"offline",shots:Array.from({length:7},(_,i)=>({id:`S${i+1}`,number:i+1,duration:12,action:"推门，脚步停下"}))});
test('SFX events bind the selected video and are retimed after head trim',()=>{
 const shot={id:'S1',duration:11,sourceCandidateId:'v2',trimStartSeconds:1,actualMediaAudit:{sourceCandidateId:'v2',sourceSha256:'hash',observedEvents:[{start:2,end:2.5,action:'door latch'}]}};
 const result=tasks.sfxSourceEvidence(shot);assert.equal(result.basis,'sampled-actual-video-events');assert.equal(result.observedEvents[0].start,1);assert.equal(result.observedEvents[0].end,1.5);
 assert.equal(tasks.sfxSourceEvidence({...shot,sourceCandidateId:'v3'}).basis,'script-plan-not-video-verified');
 assert.notEqual(tasks.sfxEvidenceKey({shots:[shot]}),tasks.sfxEvidenceKey({shots:[{...shot,trimStartSeconds:0}]}));
});
test("SFX selected agent runs in five-shot batches with only existing assets",async()=>{
 const catalog=catalogWithFiles(),calls=[];const plan=await tasks.matchStageSfx(project(),settings(),catalog,async(c,m,o)=>{const data=JSON.parse(m[1].content);calls.push({o,data});return {shots:data.shots.map(s=>({shotId:s.shotId,cues:[{effectId:catalog[0].id,localTimeSeconds:1,reason:"门被推开"}]}))};});
 assert.deepEqual(calls.map(c=>c.data.shots.length),[5,2]);assert.equal(calls[0].o.agentStage,"postProduction");assert.equal(plan.cueCount,7);assert.equal(plan.shots[1].cues[0].programmeTimeSeconds,13);
});
test("invalid SFX is explicit, empty and does not block clean-video delivery",async()=>{
 let calls=0;const plan=await tasks.matchStageSfx(project(),settings(),catalogWithFiles(),async()=>{calls++;return {shots:[]};});assert.equal(plan.status,"needs_attention");assert.equal(plan.cueCount,0);assert.match(plan.warning,/未完成音效匹配（\d+ 镜待补）/);assert.match(plan.warning,/净音视频仍可交付/);assert.equal(calls,1);
});
test("local SFX default makes no model calls; setting change invalidates cache",async()=>{
 const s={localAgents:{text:"api"}},plan=await tasks.matchStageSfx(project(),s,catalogWithFiles(),()=>{throw new Error("must not call");});assert.ok(plan.routingKey);assert.notEqual(plan.routingKey,routing.sfxRoutingKey(settings()));
});
test("prompt reviewer batches five, checks identity and never rewrites",async()=>{
 const items=Array.from({length:11},(_,i)=>({id:`p${i}`,prompt:"unchanged"})),sizes=[];
 const result=await tasks.reviewStagePrompts(items,settings(),async(c,m,o)=>{const batch=JSON.parse(m[1].content).items;sizes.push(batch.length);assert.equal(o.agentStage,"review");return {items:batch.map(b=>({id:b.id,issues:[]}))};});assert.deepEqual(sizes,[5,5,1]);assert.equal(result.status,"reviewed");assert.ok(items.every(i=>i.prompt==="unchanged"&&i.agentAudit));
});

test('large prompt audits separate production stages without truncating a prompt',()=>{
 const items=[{id:'asset',entityType:'character',prompt:'one identity'},...Array.from({length:5},(_,i)=>({id:`v${i}`,entityType:'shot',stage:'shot_video',prompt:'x'.repeat(10000)}))];
 const batches=tasks.promptReviewBatches(items);assert.equal(batches.length,6);assert.deepEqual(batches.flat(),items);assert.ok(batches.every(b=>b.length<=5));
});

test('audit capacity includes source and preserves complete speech and boundary actions',()=>{
 const turn=id=>({sourceDialogueId:id,text:'完整对白不能截掉。',speakerId:'C1',primaryListenerId:'C2',onScreen:true,deliveryZh:'语气'.repeat(1000),bodyEn:'Right hand holds the original jar.'});
 const source={script:'完整剧本',characters:[{id:'C1'},{id:'C2'},{id:'C9'}],shots:Array.from({length:4},(_,i)=>({id:'S'+i,action:'enter only in S0; stay thereafter',stateAfter:'jar remains in the right hand',dialogueTurns:[turn('D'+i)],referencePlan:{images:[{entityId:'C1'},{entityId:'C2'}]}}))};
 const items=[1,2].map(i=>({id:'v'+i,entityType:'shot',entityId:'S'+i,stage:'shot_video',prompt:'English complete prompt '.repeat(1000)}));
 const before=JSON.stringify(source),batches=tasks.promptReviewBatches(items,source);
 assert.deepEqual(batches.map(b=>b.length),[1,1]);assert.deepEqual(batches.flat(),items);
 const projected=tasks.reviewBatchSource(source,batches[0]);
 assert.deepEqual(projected.characters.map(c=>c.id),['C1','C2']);
 assert.equal(projected.shots[0].dialogueTurns[0].text,source.shots[0].dialogueTurns[0].text);
 assert.equal(projected.shots[0].dialogueTurns[0].deliveryZh,undefined);
 assert.equal(projected.shots[0].dialogueTurns[0].bodyEn,source.shots[0].dialogueTurns[0].bodyEn);
 assert.equal(projected.shots[0].stateAfter,source.shots[0].stateAfter);
 assert.equal(projected.shots[1].dialogueTurns[0].deliveryZh,source.shots[1].dialogueTurns[0].deliveryZh);
 assert.equal(JSON.stringify(source),before);
});
test("missing reviewer is not marked approved and preserves manual review",async()=>{
 const items=[{id:"p1",prompt:"keep"}];const result=await tasks.reviewStagePrompts(items,settings(),async()=>{throw new Error("offline");});assert.equal(result.status,"needs_attention");assert.equal(items[0].prompt,"keep");assert.match(items[0].agentAudit.issues[0],/人工确认/);
});

test('still audit receives the performed timeline but video review avoids duplicating its own draft',()=>{
 const source={script:'原稿',shots:[{id:'S1',action:'先推门后说话',sourcePerformanceBudget:{beforeSeconds:2},authoredTimelineForCrossStageReview:'Door contact at 2.450; speak from 3.000 to 5.000 seconds.',dialogueTurns:[]}]};
 const frame=tasks.reviewBatchSource(source,[{entityType:'shot',entityId:'S1',stage:'storyboard_start'}]);
 const video=tasks.reviewBatchSource(source,[{entityType:'shot',entityId:'S1',stage:'shot_video'}]);
 assert.equal(frame.shots[0].authoredTimelineForCrossStageReview,source.shots[0].authoredTimelineForCrossStageReview);
 assert.equal(frame.shots[0].sourcePerformanceBudget.beforeSeconds,2);
 assert.equal(video.shots[0].authoredTimelineForCrossStageReview,undefined);
 assert.ok(source.shots[0].authoredTimelineForCrossStageReview);
 assert.match(tasks.promptReviewRules([{entityType:'shot',stage:'storyboard_sheet'}]),/cell indices are not action deadlines/);
});
test('stage review receives complete relevant rules without unrelated workflow demands',()=>{
 const asset=tasks.promptReviewRules([{entityType:'character',stage:'character'}]);
 const frame=tasks.promptReviewRules([{entityType:'shot',stage:'storyboard_start'}]);
 const video=tasks.promptReviewRules([{entityType:'shot',stage:'shot_video'}]);
 assert.match(asset,/Asset-stage scope is exclusive/);
 for(const scoped of [asset,frame,video])assert.match(scoped,/genuinely incompatible/);
 assert.doesNotMatch(asset,/6\. H3 official full-reference prompt|Actual-video evidence is distinct/);
 assert.match(frame,/3\. Shot execution/);
 assert.doesNotMatch(frame,/Asset-stage scope is exclusive|6\. H3 official/);
 for(const required of ['Official task types','3. Shot execution','4. Timing','5. Sound','6. H3 official','7. Final binding','Semantic compilation must receive','Sound annotations describe synchronization'])assert.ok(video.includes(required),required);
 assert.doesNotMatch(video,/Asset-stage scope is exclusive|For long scripts, review every complete scene/);
 // Keep the relevant paragraphs intact while omitting unrelated stages.
 const full=fs.readFileSync(path.resolve(__dirname,'../app/skills/puream-drama-production-package/references/prompt-review-standard.md'),'utf8');
 assert.ok(video.length-require("../app/h3-official-agent-standard").INSTRUCTION.length<full.length*0.75,'scoped rules stay well below a full-standard dump');
 assert.ok(asset.length<30000,'asset rules stay far below a full-standard dump');
});

test('new production still performs review when its source inherits the writing Agent',async()=>{
 const config=settings();config.localAgents.text='codex';config.localAgents.stages.review='inherit';let calls=0;
 const result=await tasks.reviewStagePrompts([{id:'new-source',prompt:'source'}],config,async(c,m,o)=>{calls++;assert.equal(o.agentStage,'review');return {items:[{id:'new-source',issues:[]}]};},{requireReview:true});
 assert.equal(calls,1);assert.equal(result.source,'codex');assert.equal(result.status,'reviewed');
});

test('prompt audit resumes exact completed batches and invalidates changed source or provider model',async()=>{
 const items=()=>Array.from({length:6},(_,i)=>({id:`cache-${i}`,prompt:'source bound prompt'}));
 const config=settings();let checkpoint,calls=0;
 const generate=async(c,m)=>{calls++;const data=JSON.parse(m[1].content);if(calls===2)throw Error('offline');return {items:data.items.map(i=>({id:i.id,issues:[]}))};};
 const opts={source:{script:'原稿'},saveCheckpoint:c=>{checkpoint=structuredClone(c);}};
 const first=await tasks.reviewStagePrompts(items(),config,generate,opts);assert.equal(first.status,'needs_attention');assert.equal(checkpoint.batches.filter(b=>b.status==='reviewed').length,1);assert.equal(checkpoint.batches.filter(b=>b.status==='needs_attention').length,1);
 const second=await tasks.reviewStagePrompts(items(),config,generate,{...opts,checkpoint});assert.equal(second.status,'reviewed');assert.equal(calls,3);assert.equal(second.batches[0].reused,true);
 await tasks.reviewStagePrompts(items(),config,generate,{...opts,checkpoint});assert.equal(calls,3);
 await tasks.reviewStagePrompts(items(),config,generate,{...opts,source:{script:'修改后的原稿'},checkpoint});assert.equal(calls,5);
 config.localAgents.providers.workbuddy.model='changed-model';
 await tasks.reviewStagePrompts(items(),config,generate,{...opts,source:{script:'修改后的原稿'},checkpoint});assert.equal(calls,7);
});
test('API review cache is invalidated by model changes but never serializes credentials',async()=>{
 const config=settings();config.localAgents.stages.review='api';config.textProvider.model='model-a';let checkpoint,calls=0;
 const generate=async(c,m)=>{calls++;return {items:JSON.parse(m[1].content).items.map(i=>({id:i.id,issues:[]}))};};
 const items=()=>[{id:'api-check',prompt:'fixed'}];const options={saveCheckpoint:c=>checkpoint=structuredClone(c)};
 await tasks.reviewStagePrompts(items(),config,generate,options);
 await tasks.reviewStagePrompts(items(),config,generate,{...options,checkpoint});assert.equal(calls,1);
 config.textProvider.model='model-b';await tasks.reviewStagePrompts(items(),config,generate,{...options,checkpoint});assert.equal(calls,2);
 assert.ok(!JSON.stringify(checkpoint).includes('offline-only'));
});

test('independent reviews run together only within five items and preserve successful siblings on failure',async()=>{
 const config=settings(),items=()=>Array.from({length:6},(_,i)=>({id:'parallel-'+i,entityType:'shot',entityId:'S0'+i,stage:'shot_video',prompt:'complete clause. '.repeat(1300)}));
 let active=0,peak=0,calls=0,checkpoint,fail=true;const started=[];
 const generate=async(c,m)=>{const batch=JSON.parse(m[1].content).items;const id=batch[0].id;calls++;started.push(id);active++;peak=Math.max(peak,active);if(id==='parallel-5')assert.equal(active,1,'next batch started before preceding reviews settled');await new Promise(r=>setTimeout(r,12));active--;if(id==='parallel-2'&&fail){fail=false;throw Error('review fixture timeout');}return {items:batch.map(i=>({id:i.id,issues:[]}))};};
 const options={parallelWithinBatch:true,saveCheckpoint:c=>checkpoint=structuredClone(c)};
 const first=await tasks.reviewStagePrompts(items(),config,generate,options);assert.equal(first.status,'needs_attention');assert.equal(peak,5);assert.equal(calls,5);assert.equal(checkpoint.batches.filter(b=>b.status==='reviewed').length,4);
 const second=await tasks.reviewStagePrompts(items(),config,generate,{...options,checkpoint});assert.equal(second.status,'reviewed');assert.equal(calls,7);assert.equal(second.batches.length,6);
});
test('interleaved UI cards are reviewed by production stage and keep shot order within each stage',()=>{
 const items=[{id:'asset',entityType:'character',prompt:'portrait'},...Array.from({length:6},(_,i)=>[{id:'frame-'+i,entityType:'shot',entityId:'S'+i,stage:'storyboard_start',prompt:'frame'},{id:'video-'+i,entityType:'shot',entityId:'S'+i,stage:'shot_video',prompt:'video'}]).flat()];
 const batches=tasks.promptReviewBatches(items);assert.deepEqual(batches.map(b=>b.map(i=>i.id)),[['asset'],['frame-0','frame-1','frame-2','frame-3','frame-4'],['frame-5'],['video-0','video-1','video-2','video-3','video-4'],['video-5']]);
});

test("renderer collects and renders all independent stage settings",()=>{
 const source=fs.readFileSync(path.resolve(__dirname,"../app/renderer/local-agent-panel.js"),"utf8");for(const id of ["agentPlanningSource","agentReviewSource","agentPostSource"])assert.match(source,new RegExp(id));assert.match(source,/stages:Object.fromEntries/);
});

test('large shared screenplay does not force identical source into one request per small asset',()=>{
 const source={script:'完整剧本原文。'.repeat(12000),characters:[],scenes:[],props:[],shots:[]};
 const items=Array.from({length:11},(_,i)=>({id:'asset-'+i,entityType:'character',stage:'character_intro',prompt:'Complete identity prompt '+i}));
 const before=JSON.stringify(source),batches=tasks.promptReviewBatches(items,source);
 assert.deepEqual(batches.map(b=>b.length),[5,5,1]);assert.deepEqual(batches.flat(),items);assert.equal(JSON.stringify(source),before);
 for(const batch of batches)assert.equal(tasks.reviewBatchSource(source,batch).script,source.script);
});

test('accepted screenplay audits use the exact current shot and neighbors, while legacy manuscripts retain their whole source',()=>{
 const source={script:'WHOLE_FILM_MUST_NOT_REPEAT',acceptedShotScreenplay:true,characters:[],scenes:[],props:[],shots:Array.from({length:4},(_,i)=>({id:'S'+i,action:'source action '+i,dialogueTurns:[]}))},items=[{id:'v1',entityType:'shot',entityId:'S1',stage:'shot_video',prompt:'exact current prompt'}];
 const projected=tasks.reviewBatchSource(source,items);assert.equal(projected.script,undefined);assert.deepEqual(projected.shots.map(s=>s.id),['S0','S1','S2']);assert.equal(projected.shots[1].action,'source action 1');assert.equal(source.script,'WHOLE_FILM_MUST_NOT_REPEAT');assert.equal(tasks.reviewBatchSource({...source,acceptedShotScreenplay:false},items).script,source.script);
});
test('scope migration reuses exact prior audit evidence and still invalidates changed current content',async()=>{
 const source={script:'original manuscript',characters:[],scenes:[],props:[],shots:Array.from({length:4},(_,i)=>({id:'S'+i,action:'action '+i,dialogueTurns:[]}))};const items=[{id:'v1',entityType:'shot',entityId:'S1',stage:'shot_video',prompt:'unchanged executable prompt'}];let calls=0,checkpoint;
 const generate=async(c,m)=>{calls++;return {items:JSON.parse(m[1].content).items.map(i=>({id:i.id,issues:[]}))};};
 const run=async src=>tasks.reviewStagePrompts(structuredClone(items),settings(),generate,{source:src,checkpoint,saveCheckpoint:x=>checkpoint=structuredClone(x),skipChronology:true});
 await run(source);assert.equal(calls,1);const accepted={...source,acceptedShotScreenplay:true};await run(accepted);assert.equal(calls,1);
 const unrelated=structuredClone(accepted);unrelated.script='a new distant scene';unrelated.shots[3].action='different distant action';await run(unrelated);assert.equal(calls,1);
 const changed=structuredClone(unrelated);changed.shots[1].action='a real change in this shot';await run(changed);assert.equal(calls,2);
});
