'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const screenplay=require('../app/shot-screenplay');
const director=require('../app/agent-production-decisions');
const fixture=require('./shot-screenplay-fixture').fixture;
function project(mode,count=2){
 const d=fixture();for(let i=2;i<=count;i++)d.shots.push({...structuredClone(d.shots[0]),id:'S'+String(i).padStart(2,'0'),dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]});
 const raw=screenplay.render(d),record=screenplay.makeRecord(d,raw,{}),data=screenplay.projectData(record);
 return {...data,id:'scoped-test',script:{raw,shotScreenplay:record,runtimePolicy:{targetSeconds:20,minSeconds:20,maxSeconds:20}},generation:{engine:'hailuo-h3',mode},product:{},assetLibraries:{props:data.props||[],wardrobes:data.wardrobes||[]}};
}
function item(s){return {shotId:s.id,identityContractVersion:1,duration:s.duration,visibleCharacterIds:s.visibleCharacterIds,visiblePropIds:s.propIds,productVisible:s.productVisible,states:s.visibleCharacterIds.map(characterId=>({characterId,openingEn:'Seated beside the table, empty hands.',openingZh:'桌旁原位坐着，空手。',endingEn:'Still seated, looking toward the other person.',endingZh:'仍在原位坐着，看向对方。'})),environmentEn:'A quiet living room with a table beside the north window.',environmentZh:'北窗桌旁的安静客厅。',objectStates:[],events:[{id:'E01',actorIds:s.visibleCharacterIds,offscreenActorIds:[],propIds:[],usesProduct:false,start:0,end:s.duration,after:[],continuityActionIds:[],throughoutDialogueIds:[],recordedSpeech:null,descriptionEn:'C01 looks toward C02 while C02 listens and smiles, both remain seated.',descriptionZh:'小梅看向母亲，母亲倾听微笑，两人保持坐姿。'}],cameras:[{at:0,size:'medium',angle:'front',movement:'locked',subjectIds:s.visibleCharacterIds}],dialogue:s.dialogue.map(d=>({id:d.id,start:d.start,end:d.end,listenerIds:d.listenerIds,addressMode:d.addressMode,deliveryEn:'Warm and relaxed.',deliveryZh:d.delivery})),summaryEn:'A quiet reunion between family members.',soundscapeEn:'Quiet room ambience.'};}
test('accepted screenplay is not second-guessed by fixed speech-rate or camera heuristics',()=>{
 const p=project('asset_direct'),shot=p.shots[0],decision=item(shot.shotExecution);
 decision.cameras.push({...decision.cameras[0],at:2});
 decision.programReviewSuggestions=['legacy warning'];
 assert.equal(director.validate(p,shot,decision),true);
 assert.equal(decision.programReviewSuggestions,undefined);
 decision.visibleCharacterIds=['missing'];
 assert.throws(()=>director.validate(p,shot,decision),e=>e.issues.some(x=>x.includes('unknown asset ID')));
});
test('review input retires old heuristic notes without mutating saved receipts or Agent evidence',()=>{
 const {reviewBatchSource}=require('../app/agent-stage-tasks');
 const source={acceptedShotScreenplay:true,script:'complete source',shots:[{id:'S01',masterAgentDecision:{programReviewSuggestions:['speech rate outside heuristic'],summaryEn:'Actual Agent decision'},dialogueTurns:[]}],characters:[],scenes:[],props:[]};
 const data=reviewBatchSource(source,[{entityType:'shot',entityId:'S01',group:'videos',prompt:'Exact prompt'}]);
 assert.equal(data.shots[0].masterAgentDecision.programReviewSuggestions,undefined);
 assert.equal(data.shots[0].masterAgentDecision.summaryEn,'Actual Agent decision');
 assert.deepEqual(source.shots[0].masterAgentDecision.programReviewSuggestions,['speech rate outside heuristic']);
});

test('audit catalogs distinguish original story chronology from the generated proposal being reviewed',()=>{
 const evidence=require('../app/prompt-review-evidence');
 const facts=evidence.catalog({storyContext:{synopsis:'同一夜晚冲茶，次日才向邻居介绍。'},shots:[{id:'S01',stateBefore:'同一夜晚冲茶',masterAgentDecision:{environmentZh:'清晨天光'}}]});
 const clock=facts.find(f=>f.text==='同一夜晚冲茶，次日才向邻居介绍。'),proposal=facts.find(f=>f.text==='清晨天光');
 assert.equal(clock.context.role,'read_only_story_chronology');assert.equal(clock.context.namespace,'original_screenplay');
 assert.equal(proposal.context.authority,'derived_proposal_under_review');assert.equal(proposal.context.entityId,'S01');
 const rules=require('../app/agent-stage-tasks').promptReviewRules([{entityType:'shot',group:'videos',prompt:''}]);assert.match(rules,/STORY CLOCK AND EVIDENCE AUTHORITY/);
});

test('canonical offscreen recording remains expressible without allowing live on-screen words into playback',()=>{
 const p=project('asset_direct'),s=p.shots[0],d=s.shotExecution.dialogue[0],turn=s.dialogueTurns[0];
 d.onScreen=false;turn.onScreen=false;const decision=item(s.shotExecution);
 decision.events[0].recordedSpeech={speakerId:turn.speakerId,sourceDialogueIds:[d.id],deliveryEn:'An established recorded voice from the source playback.',deliveryZh:'原稿既定录音播放。'};
 assert.equal(require('../app/typed-output-receipt').conforms({items:[decision]},director.schema(p,[s])),true);assert.equal(director.validate(p,s,decision),true);
 d.onScreen=true;turn.onScreen=true;
 assert.equal(require('../app/typed-output-receipt').conforms({items:[decision]},director.schema(p,[s])),false);
 assert.throws(()=>director.validate(p,s,decision),e=>e.issues.some(i=>i.includes('Set this field to null')));
});
test('five-shot batch conversion and review retain read-only story chronology and track it as a dependency',async()=>{
 let p=project('asset_direct');p.script.shotScreenplay.document.story.synopsis='争执和冲茶都发生在同一夜晚；次日清晨才向邻居介绍商品。';
 // Refresh the accepted record after an Agent-authored source update.
 p.script.raw=screenplay.render(p.script.shotScreenplay.document);p.script.shotScreenplay=screenplay.makeRecord(p.script.shotScreenplay.document,p.script.raw,{});
 let calls=0;await director.author({getProject:()=>structuredClone(p),saveProject:x=>p=x,projectId:p.id,settings:{textProvider:{}},optionsFor:(_id,_stage,o)=>o,generate:async(_config,m)=>{
  calls++;const input=JSON.parse(m[1].content);assert.equal(input.shots.length,2);assert.equal(input.completeOriginalSource,undefined);assert.match(input.storyContext.synopsis,/同一夜晚/);return {items:input.shots.map(s=>item(s.shotExecution))};
 }});
 assert.equal(calls,1);assert.ok(p.shots.every(s=>director.current(p,s)));
 const {reviewBatchSource}=require('../app/agent-stage-tasks');const context={synopsis:p.script.shotScreenplay.document.story.synopsis};
 const view=reviewBatchSource({acceptedShotScreenplay:true,script:p.script.raw,storyContext:context,shots:p.shots,characters:[],scenes:[],props:[]},[{entityType:'shot',entityId:'S01',group:'videos',prompt:'test'}]);
 assert.deepEqual(view.storyContext,context);assert.equal(view.script,undefined);
 p.script.shotScreenplay.document.story.synopsis='冲茶改为次日清晨。';assert.equal(director.current(p,p.shots[0]),false);
});
test('legacy analyzed text reaches Agent intake once before five-shot batch conversion and then reuses receipts',async()=>{
 const {WorkbenchWorkflow}=require('../app/workbench-workflow');let p=project('asset_direct');
 const doc=structuredClone(p.script.shotScreenplay.document);delete p.script.shotScreenplay;
 p.script.analyzedAt=new Date().toISOString();p.script.sourceFingerprint=require('crypto').createHash('sha256').update(p.script.raw).digest('hex');
 const settings={generation:{agentDecisionAuthority:true},textProvider:{}},calls=[];
 const flow=new WorkbenchWorkflow({store:{getProject:()=>structuredClone(p),saveProject:x=>(p=x),getSettings:()=>settings},bridge:{}});
 flow.setAutomation=()=>{};flow.productionTextOptions=(_id,stage,o)=>({...o,stage});
 flow.generateText=async(_config,m,o)=>{calls.push(o.stage);
  if(o.stage==='shot_screenplay_draft')return p.script.raw;
  if(o.stage==='shot_screenplay_structure')return doc;
  if(o.stage==='shot_screenplay_review')return {ok:true,storyComplete:true,sourcePreserved:true,checks:doc.shots.map(s=>({shotId:s.id,evidence:'Complete source checked'})),issues:[]};
  assert.equal(o.stage,'master_production_decisions');const input=JSON.parse(m[1].content);
  assert.equal(input.shots.length,2);assert.equal(input.completeOriginalSource,undefined);
  return {items:input.shots.map(s=>item(s.shotExecution))};
 };
 await flow.authorAgentProductionDecisions(p.id);const first=[...calls];
 assert.equal(calls.filter(s=>s==='shot_screenplay_structure').length,1);assert.equal(calls.filter(s=>s==='master_production_decisions').length,1);
 assert.ok(screenplay.runtimeCurrent(p));await flow.authorAgentProductionDecisions(p.id);assert.deepEqual(calls,first);
});
test('a distant edit cannot discard an in-flight shot, while its own neighbor and actor changes invalidate it',async()=>{
 let p=project('asset_direct',5),calls=0;
 await director.author({getProject:()=>structuredClone(p),saveProject:x=>(p=x),projectId:p.id,shotIds:['S01'],settings:{textProvider:{}},optionsFor:(_id,stage,o)=>({...o,stage}),generate:async(_c,m,o)=>{
  calls++;assert.equal(o.stage,'master_production_decisions');const input=JSON.parse(m[1].content);
  assert.equal(input.product,undefined);assert.equal(input.shots.length,1);
  p.shots[4].action+='远处镜头的新动作';p.product.price='新价格';
  return {items:[item(input.shots[0].shotExecution)]};
 }});
 assert.equal(calls,1);assert.ok(director.current(p,p.shots[0]));
 p.shots[1].shotExecution.opening+='邻镜起始位置已改变';assert.equal(director.current(p,p.shots[0]),false);
});
test('required actor descriptions are dependencies even when IDs and names stay the same',()=>{
 const p=project('asset_direct'),s=p.shots[0];director.apply(p,s,item(s.shotExecution));
 assert.ok(director.current(p,s));p.characters[0].description+='不同服装';assert.equal(director.current(p,s),false);
});
for(const mode of ['asset_direct','keyframe','storyboard_sheet'])test(`${mode}: independent Agents receive five-shot batches and neighbors in parallel, with no whole-film replanning`,async()=>{
 let p=project(mode,12),calls=[],groups=[],active=0,peak=0;const words=p.shots.flatMap(s=>s.dialogueTurns.map(t=>t.text));
 await director.author({getProject:()=>structuredClone(p),saveProject:x=>(p=x),projectId:p.id,settings:{textProvider:{}},optionsFor:(_id,stage,o)=>({...o,stage}),generate:async(_c,m,o)=>{
  calls.push(o.stage);assert.equal(o.stage,'master_production_decisions');assert.ok(calls.length<=3,'no unexpected retry');
  const input=JSON.parse(m[1].content);groups.push(input.shots.length);assert.ok(input.shots.length<=5);active++;peak=Math.max(peak,active);await new Promise(setImmediate);active--;
  for(const field of ['completeOriginalSource','wholeFilmSource','filmRuntimeBudget','wholeFilmRuntimePlan','acceptedDecisions'])assert.equal(input[field],undefined,field);
  assert.equal(input.shots[0].referenceSpeechGrid,undefined);assert.match(m[0].content,/导演结构化决定作者/);assert.match(m[0].content,/只执行指定目标镜的完整剧本/);
  assert.doesNotMatch(m[0].content,/DO NOT import old generated timing|Then fit speech around|Choose 10-15 seconds/,'fixed-screenplay conversion must not receive replanning instructions');
  assert.ok(!m[0].content.includes(require('../app/screenplay-execution-authority').FORMAT),'video director must not inherit screenplay-writing output format');
  assert.ok(m[0].content.includes(require('../app/screenplay-execution-authority').CONTACT_CONTINUITY),'all modes receive the same physical contact reasoning');
  return {items:input.shots.map(s=>item(s.shotExecution))};
 }});
 assert.equal(calls.length,3);assert.deepEqual(groups,[5,5,2]);assert.ok(peak>1);assert.ok(screenplay.runtimeCurrent(p));assert.deepEqual(p.shots.flatMap(s=>s.dialogueTurns.map(t=>t.text)),words);
 p.product.visualEvidence={status:'observed',sha256:'new-observation',containerType:'jar'};
 assert.ok(director.current(p,p.shots[0]),'an unseen product observation must not replay this non-product shot');
 p.product.price='changed input';assert.equal(director.current(p,p.shots[0]),true,'unseen commercial terms must not replay a non-product shot');delete p.product.price;delete p.product.visualEvidence;
 const workflow=require('../app/workbench-workflow');
 for(const s of p.shots){assert.ok(director.current(p,s));const refs=workflow.promptReviewReferencePlan(p,s,mode,'image_only');const prompt=workflow.renderApprovedVideoPrompt(p,s,refs);for(const d of s.dialogueTurns)assert.ok(prompt.includes(d.text));}
});
test('a failed pending writing request resumes with the same session, without discarding the checkpoint',async()=>{
 let saved,session;const d=fixture(),input={topic:{title:'resume'},save:s=>{saved=structuredClone(s);}};
 await assert.rejects(screenplay.author({...input,generate:async(_m,o)=>{session=o.sessionId;throw Object.assign(Error('network interrupted'),{code:'NETWORK'});}}),{code:'NETWORK'});
 const result=await screenplay.author({...input,checkpoint:saved,generate:async(_m,o)=>{if(o.stage==='shot_screenplay_draft'){assert.equal(o.sessionId,session);return '完整中文剧本首稿';}if(o.stage==='shot_screenplay_structure')return d;return {ok:true,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'source matches'}],issues:[]};}});
 assert.equal(result.status,'ready');assert.equal(result.attempts.length,1);
});

test('repair resume reuses its exact pending request rather than drafting, structuring or repairing with a new session',async()=>{
 const d=fixture();let saved,repairSession,structures=0,drafts=0;
 const input={topic:{title:'repair resume'},save:s=>{saved=structuredClone(s);}};
 const bad=structuredClone(d);bad.shots[0].sceneId='__missing_scene__';
 await assert.rejects(screenplay.author({...input,generate:async(_m,o)=>{
  if(o.stage==='shot_screenplay_draft'){drafts++;return '完整中文剧本首稿';}
  if(o.stage==='shot_screenplay_structure'){structures++;return bad;}
  if(o.stage==='shot_screenplay_repair'){repairSession=o.sessionId;throw Object.assign(Error('network'),{code:'NETWORK'});}
  throw Object.assign(Error('unexpected stage '+o.stage),{code:'NETWORK'});
 }}),{code:'NETWORK'});
 // 结构修复预算耗尽后进入本地协议修复；断点已带完整文档，恢复时不得重跑起草/结构。
 let repaired=false;const result=await screenplay.author({...input,checkpoint:saved,generate:async(_m,o)=>{
  if(!repaired){assert.equal(o.stage,'shot_screenplay_repair');assert.equal(o.sessionId,repairSession);repaired=true;return {shots:[{...structuredClone(d.shots[0]),characterIds:d.shots[0].characterIds}],additions:[],characters:[],scenes:[],props:[],wardrobes:[]};}
  throw Object.assign(Error('unexpected stage '+o.stage),{code:'NETWORK'});
 }});assert.equal(result.status,'ready');assert.equal(drafts,1);assert.equal(structures,3);assert.equal(repaired,true);
});

test('local Agent idempotency shares a running call and replays a committed receipt without invoking the model',async t=>{
 const fs=require('fs'),path=require('path'),{AgentHub}=require('../app/local-agent-runtime'),delivery=require('../app/mcp/stage-delivery');
 const root=fs.mkdtempSync(path.resolve(__dirname,'../../../.codex_tests/TASK-20260913-AGENT-295/request-replay-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let calls=0;const fake=Object.assign(Object.create(AgentHub.prototype),{root,jobs:new Map(),activeRequests:new Map(),stageStarts:new Map(),latestByStage:new Map(),save:()=>{},runFresh:async function(config,request,options){calls++;await new Promise(r=>setTimeout(r,5));const id='agent_replay',dir=path.join(root,id);fs.mkdirSync(dir);const job={id,agentId:config.id,status:'running',requestKey:options.requestKey};this.jobs.set(id,job);fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({...request,jobId:id}));fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify(job));delivery.submit(dir,{text:'原话（完整）'});return {text:'原话（完整）',jobId:id};}});
 const invoke=()=>AgentHub.prototype.run.call(fake,{id:'workbuddy'},{modality:'text',json:false,messages:[]},{sessionId:'one-request',costProjectId:'test'});
 const both=await Promise.all([invoke(),invoke()]);assert.equal(calls,1);assert.deepEqual(both[0],both[1]);
 const replay=await invoke();assert.equal(calls,1);assert.equal(replay.text,'原话（完整）');assert.equal(replay.reused,true);
});

test('legacy library synchronization cannot delete or rename Agent-owned prop and wardrobe bindings',()=>{
 const d=fixture();d.props=[{id:'P01',name:'白杯',description:'白色陶瓷杯',descriptionEn:'',assetRequired:true,holder:'小梅',purpose:'装水',units:['S01']}];d.wardrobes=[{id:'W01',name:'工作围裙',description:'灰色围裙',descriptionEn:'',assetRequired:true,characterId:'C01',units:['S01']}];d.shots[0].propIds=['P01'];d.shots[0].wardrobeBindings=[{characterId:'C01',wardrobeId:'W01'}];
 const raw=screenplay.render(d),record=screenplay.makeRecord(d,raw,{}),data=screenplay.projectData(record),p={...data,script:{raw,shotScreenplay:record},assetLibraries:{props:data.props,wardrobes:data.wardrobes,voices:[]}};
 const before=JSON.stringify(p),Workflow=require('../app/workbench-workflow').WorkbenchWorkflow;
 const result=Workflow.prototype.syncReferenceLibraries.call({store:{getProject:()=>p,saveProject:()=>assert.fail('no inference or remapping permitted')}},'test');
 assert.equal(result,p.assetLibraries);assert.equal(JSON.stringify(p),before);assert.ok(screenplay.runtimeCurrent(p));
});

test('multiline source formatting cannot invalidate the final Agent prompt or introduce legacy camera cuts',()=>{
 const p=project('asset_direct'),s=p.shots[0];s.action+='\n[4–8秒] 同一固定机位，保持坐姿。';const decision=item(s.shotExecution);director.apply(p,s,decision);
 const wf=require('../app/workbench-workflow'),refs=wf.promptReviewReferencePlan(p,s,'asset_direct','image_only'),prompt=wf.renderApprovedVideoPrompt(p,s,refs);
 assert.match(prompt,/Physical event E01/);assert.doesNotMatch(prompt,/the camera cuts directly|no less than 5 effective/);assert.equal((prompt.match(/妈，我回来了。/g)||[]).length,1);
 const input={data:{items:[decision]}},before=JSON.stringify(input);const preview=require('../app/mcp/stage-preview').preview({deliveryPreview:{kind:'master-production-decision',project:p}},input);
 assert.equal(preview.ok,true);assert.equal(JSON.stringify(input),before,'preview must never add software metadata to Agent submissions');
});

test('nested response-shape feedback identifies the actual extra field instead of a generic union failure',()=>{
 const p=project('asset_direct'),i=item(p.shots[0].shotExecution);i.summaryZh='额外的中文摘要';
 const failures=require('../app/agent-output-normalization').inspect({items:[i]},director.schema(p,[p.shots[0]]));
 assert.ok(failures.some(f=>f.path==='$.items[0].summaryZh'));assert.equal(failures.some(f=>f.reason==='choose one complete declared response shape'),false);
});

test('a cached pending prompt bundle resumes preparation after interruption',async()=>{
 let p={promptReview:{status:'pending',items:[{id:'shot:S01:shot_video'}]},shots:[]},calls=0;
 const workflow={store:{getProject:()=>p,saveProject:x=>(p=x)},promptReviewIsCurrent:(_p,state)=>state!=='approved',preparePromptReviewBundle:async()=>{calls++;p.promptReview.status='ready';return p;}};
 const result=await require('../app/workbench-workflow').WorkbenchWorkflow.prototype.requestPromptReview.call(workflow,'test',{requireCompleteDelivery:true});
 assert.equal(calls,1);assert.equal(result.project.promptReview.status,'ready');assert.equal(result.project.automation.status,'awaiting_prompt_review');
});

for(const mode of ['asset_direct','keyframe','storyboard_sheet'])test(`${mode}: an audit wording correction submits only Agent-chosen field changes`,async()=>{
 let p=project(mode);for(const s of p.shots)director.apply(p,s,item(s.shotExecution));
 const before=structuredClone(p.shots),patcher=require('../app/agent-decision-patch');let calls=0;
 await director.author({getProject:()=>structuredClone(p),saveProject:x=>(p=x),projectId:p.id,settings:{textProvider:{}},findingsByShot:{S01:['The soundscape says three voices; there are two bound people. Change that wording only.']},optionsFor:(_id,stage,o)=>({...o,stage}),generate:async(_c,m,o)=>{
  calls++;assert.equal(o.stage,'master_production_decision_patch');assert.equal(o.deliveryPreview.kind,'master-production-patch');const input=JSON.parse(m[1].content);assert.equal(input.baseItems.length,1);assert.equal(input.screenplay.length,1);assert.equal(input.storyContext.synopsis,p.script.shotScreenplay.document.story.synopsis);
  const delta={items:[{shotId:'S01',changes:[{path:['soundscapeEn'],value:'Quiet room ambience and the two bound character voices only.'}]}]};
  assert.equal(require('../app/mcp/stage-preview').preview(o,{data:delta}).ok,true);
  return delta;
 }});
 assert.equal(calls,1);assert.equal(p.shots[0].agentProductionDecision.item.soundscapeEn,'Quiet room ambience and the two bound character voices only.');
 const old=patcher.wire(before[0].agentProductionDecision.item),after=patcher.wire(p.shots[0].agentProductionDecision.item);old.soundscapeEn=after.soundscapeEn;assert.deepEqual(after,old);assert.deepEqual(p.shots[1],before[1]);
});

test('an invalid field patch gives precise feedback and never mutates its base',()=>{
 const p=project('asset_direct'),base=[item(p.shots[0].shotExecution)],before=JSON.stringify(base),patcher=require('../app/agent-decision-patch'),schema=director.schema(p,[p.shots[0]]);
 for(const change of [{path:['duration'],value:15},{path:['__proto__','x'],value:1},{path:['events',0,'missing'],value:'x'},{path:['dialogue',0,'start'],value:9}])assert.throws(()=>patcher.apply(base,{items:[{shotId:'S01',changes:[change]}]},schema));
 assert.equal(JSON.stringify(base),before);
});

for(const mode of ['asset_direct','keyframe','storyboard_sheet'])test(`${mode}: Agent clears a mistaken recording field without losing live dialogue or touching other shots`,async()=>{
 let p=project(mode);for(const s of p.shots)director.apply(p,s,item(s.shotExecution));
 const shot=p.shots[0],line=shot.dialogueTurns[0];
 const wrong=structuredClone(shot.agentProductionDecision.item);wrong.events[0].recordedSpeech={speakerId:line.speakerId,sourceDialogueIds:[line.sourceDialogueId||line.id],deliveryEn:'Recorded voice.',deliveryZh:'录音。'};
 // Emulate a persisted older receipt; the new author must repair it itself.
 shot.agentProductionDecision.item=wrong;
 const before=structuredClone(p.shots),wf=require('../app/workbench-workflow');
 const rendered=()=>wf.renderApprovedVideoPrompt(p,p.shots[0],wf.promptReviewReferencePlan(p,p.shots[0],mode,'image_only'));
 assert.throws(()=>director.validate(p,shot,structuredClone(wrong)),e=>e.issues.some(i=>i.includes('recordedSpeech')));
 await director.author({getProject:()=>structuredClone(p),saveProject:x=>p=x,projectId:p.id,settings:{textProvider:{}},optionsFor:(_id,stage,o)=>({...o,stage}),generate:async(_c,m,o)=>{
  assert.equal(o.stage,'master_production_decision_patch');assert.match(m[0].content,/recordedSpeech.*null/);
  const delta={items:[{shotId:'S01',changes:[{path:['events',0,'recordedSpeech'],value:null}]}]};
  assert.equal(require('../app/mcp/stage-preview').preview(o,{data:delta}).ok,true);return delta;
 }});
 const prompt=rendered();assert.doesNotMatch(prompt,/in-scene recording/);assert.equal(prompt.split(line.text).length-1,1);
 assert.deepEqual(p.shots[0].agentProductionDecision.item.dialogue,before[0].agentProductionDecision.item.dialogue);
 assert.deepEqual(p.shots[1],before[1]);
});
