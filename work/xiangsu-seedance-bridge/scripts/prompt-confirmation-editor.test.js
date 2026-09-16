'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const editor=require('../app/prompt-review-editor'),screenplay=require('../app/shot-screenplay');
const {fixture}=require('./shot-screenplay-fixture');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
const applyItem=(...args)=>WorkbenchWorkflow.prototype.applyPromptReviewItem(...args);
function project(){
 const doc=fixture(),raw=screenplay.render(doc),record=screenplay.makeRecord(doc,raw,null),data=screenplay.projectData(record);
 return {id:'protocol-fixture',productionRevision:'rev1',product:{name:'测试商品',price:'模拟 29.9 元'},script:{raw,originalRaw:'用户原文保持不变',shotScreenplay:record},shots:data.shots,characters:data.characters,scenes:data.scenes,assetLibraries:{props:data.props,wardrobes:data.wardrobes},candidates:[{id:'keep'}],promptReview:{status:'ready',items:[{id:'shot:S01:shot_video',entityId:'S01',entityType:'shot',stage:'shot_video',group:'videos',prompt:'Xiaobai faces mother. Exactly one line: 妈，我回来了。',displayPrompt:'小白面对母亲。对白只说一次：妈，我回来了。',executionLanguage:'en',displayLanguage:'zh-CN',status:'draft'}]}};
}
function change(p,path,before,after){const t=editor.targets(p).find(t=>JSON.stringify(t.path)===JSON.stringify(path));assert.ok(t,'target exists '+path);return {targetId:t.targetId,before,after,reason:'测试精确字段替换'};}
test('exact edits persist both language mirrors and leave unrelated text/data unchanged',()=>{
 const p=project(),edits=[change(p,['promptReview','items',0,'prompt'],'Xiaobai','Xiaohei'),change(p,['promptReview','items',0,'displayPrompt'],'小白','小黑')];
 const result=editor.applyResult(p,p,{edits,unresolved:[]},applyItem);assert.equal(result.ok,true);
 assert.equal(result.project.shots[0].manualVideoPrompt,p.promptReview.items[0].prompt.replace('Xiaobai','Xiaohei'));
 assert.equal(result.project.promptReview.items[0].displayPrompt,p.promptReview.items[0].displayPrompt.replace('小白','小黑'));
 assert.equal(result.project.promptReview.items[0].status,'draft');assert.equal(result.project.promptReview.items[0].confirmedAt,'');
 assert.deepEqual(result.project.candidates,p.candidates);assert.equal(result.project.script.originalRaw,p.script.originalRaw);assert.equal(result.project.promptReview.editHistory.length,1);
});
test('English-only edit is used by the real generation override',()=>{
 const p=project(),a=editor.applyResult(p,p,{edits:[change(p,['promptReview','items',0,'prompt'],'Xiaobai','Xiaohei')],unresolved:[]},applyItem);
 assert.equal(a.ok,true);assert.match(a.project.shots[0].manualVideoPrompt,/Xiaohei/);assert.equal(a.project.promptReview.items[0].displayPrompt,p.promptReview.items[0].displayPrompt);
});
test('source field edit updates structural mirrors without restarting authoring or dropping assets',()=>{
 const p=project();p.shots[0].systemVideoPrompt='keep compiled prompt';p.shots[0].finalPromptEditing={status:'authored',detailedDescriptionEn:'keep'};
 const a=editor.applyResult(p,p,{edits:[change(p,['script','shotScreenplay','document','characters',0,'name'],'小梅','小黑')],unresolved:[]},applyItem);
 assert.equal(a.ok,true);assert.equal(a.project.characters[0].name,'小黑');assert.equal(a.project.shots[0].dialogueTurns[0].speakerName,'小黑');
 assert.equal(screenplay.runtimeCurrent(a.project),true);assert.equal(a.project.shots[0].systemVideoPrompt,'keep compiled prompt');assert.deepEqual(a.project.shots[0].finalPromptEditing,p.shots[0].finalPromptEditing);assert.equal(a.project.script.originalRaw,p.script.originalRaw);
});
test('source synchronization cannot overwrite an explicit coupled timing edit',()=>{
 const p=project();const a=editor.applyResult(p,p,{edits:[change(p,['script','shotScreenplay','document','shots',0,'dialogue',0,'text'],'妈，我回来了。','妈，我到家了。'),change(p,['shots',0,'dialogueTurns',0,'startSecond'],'1','0.5')],unresolved:[]},applyItem);
 assert.equal(a.ok,true);assert.equal(a.project.shots[0].dialogueTurns[0].text,'妈，我到家了。');assert.equal(a.project.shots[0].dialogueTurns[0].startSecond,0.5);assert.equal(screenplay.runtimeCurrent(a.project),true);
});
test('source-owned facts have one editable owner; display mirrors cannot drift',()=>{
 const paths=editor.targets(project()).map(t=>t.path.join('/'));
 assert.ok(paths.includes('script/shotScreenplay/document/shots/0/dialogue/0/text'));
 assert.ok(!paths.includes('shots/0/dialogueTurns/0/text'));assert.ok(!paths.includes('characters/0/name'));
});
test('stale Agent result cannot overwrite a concurrent user edit',()=>{
 const p=project(),current=structuredClone(p);current.promptReview.items[0].displayPrompt='用户刚保存的新编辑';
 const answer={edits:[change(p,['promptReview','items',0,'displayPrompt'],'小白','小黑')],unresolved:[]};
 const a=editor.applyResult(current,p,answer,applyItem);assert.equal(a.conflict,true);assert.equal(current.promptReview.items[0].displayPrompt,'用户刚保存的新编辑');
});
test('unrelated background persistence is retained by the atomic transaction',()=>{
 const p=project(),current=structuredClone(p);current.candidates.push({id:'new-result'});current.automation={message:'live'};
 const a=editor.applyResult(current,p,{edits:[change(p,['promptReview','items',0,'displayPrompt'],'小白','小黑')],unresolved:[]},applyItem);
 assert.equal(a.ok,true);assert.equal(a.project.candidates.length,2);assert.deepEqual(a.project.automation,current.automation);
});
test('ambiguous or overlapping text patches are returned as delivery feedback with no partial mutation',()=>{
 const p=project();p.promptReview.items[0].displayPrompt='小白和小白';
 assert.equal(editor.parseEdits(p,{edits:[change(p,['promptReview','items',0,'displayPrompt'],'小白','小黑')],unresolved:[]}).ok,false);
 assert.equal(p.promptReview.items[0].displayPrompt,'小白和小白');
 const q=project(),a=change(q,['promptReview','items',0,'displayPrompt'],'小白','小黑'),b=change(q,['promptReview','items',0,'displayPrompt'],'小白面对','小黑转向');
 assert.equal(editor.parseEdits(q,{edits:[a,b],unresolved:[]}).ok,false);
});
test('all three screenplay entry modes defer content audits while preserving a complete draft',async()=>{
 for(const mode of ['original','upload','adapt']){
  const doc=fixture(),result=await screenplay.author({mode,draftDocument:doc,generate:async()=>{throw Error('must not call a writer or early reviewer');}});
  assert.equal(result.status,'ready');assert.equal(result.contentReview.status,'deferred');assert.equal(result.contentReview.ok,null);assert.deepEqual(result.document,doc);assert.equal(result.reviews.length,0);
 }
});
test('deferred/editing review is never a content pass',()=>{
 const receipt=require('../app/renderer/review-receipt-state');
 for(const status of ['deferred','reviewing','editing','not_verified'])assert.equal(receipt.state({status,issues:[]}), 'not_verified');
});
test('confirmation editor reviews then patches the same document without calling generation stages',async()=>{
 let p=project(),audits=0,writes=0;const tasks=require('../app/agent-stage-tasks'),original=tasks.reviewStagePrompts;
 tasks.reviewStagePrompts=async(items)=>{audits++;for(const item of items)item.agentAudit={source:'fixture',status:'reviewed',issues:item.prompt.includes('Xiaobai')?['姓名应为小黑']:[]};return {status:'reviewed'};};
 try{
  const result=await editor.edit({projectId:p.id,settings:{},getProject:()=>structuredClone(p),saveProject:x=>(p=structuredClone(x)),applyItem,generate:async(_config,messages,opts)=>{writes++;assert.equal(opts.stage,'prompt_confirmation_edit');const packet=JSON.parse(messages[1].content);return {edits:packet.targets.filter(t=>t.owner.itemId&&['Xiaobai','小白'].some(n=>t.value.includes(n))).map(t=>({targetId:t.targetId,before:t.value.includes('Xiaobai')?'Xiaobai':'小白',after:t.value.includes('Xiaobai')?'Xiaohei':'小黑',reason:'只修改姓名'})),unresolved:[]};}});
  assert.equal(result.promptReview.editor.status,'completed');assert.equal(writes,1);assert.equal(audits,2);assert.equal(result.promptReview.items[0].status,'draft');assert.equal(result.promptReview.editHistory.length,1);
 }finally{tasks.reviewStagePrompts=original;}
});
test('real store round-trip keeps edited prompts, source projection and edit history',()=>{
 const fs=require('node:fs'),path=require('node:path'),{WorkbenchStore}=require('../app/workbench-store');
 const dir=fs.mkdtempSync(path.resolve(__dirname,'../../../.codex_tests/TASK-20260915-INPLACE-REVIEW/store-'));
 const store=new WorkbenchStore(dir),created=store.createProject('仅协议检查，不调用模型'),p={...created,...project(),id:created.id};
 let saved=store.saveProject(p),snapshot=store.getProject(saved.id);
 const a=editor.applyResult(snapshot,snapshot,{edits:[change(snapshot,['promptReview','items',0,'prompt'],'Xiaobai','Xiaohei'),change(snapshot,['promptReview','items',0,'displayPrompt'],'小白','小黑'),change(snapshot,['script','shotScreenplay','document','characters',0,'name'],'小梅','小黑')],unresolved:[]},applyItem);
 assert.equal(a.ok,true);store.saveProject(a.project);saved=store.getProject(p.id);
 assert.match(saved.shots[0].manualVideoPrompt,/Xiaohei/);assert.equal(saved.promptReview.editHistory.length,1);assert.equal(saved.promptReview.items[0].editOrigin,'agent');assert.equal(screenplay.runtimeCurrent(saved),true);
});
test('manual confirmation does not silently trigger optional AI editing',async()=>{
 let p=project();p.promptReview.counts={total:1};p.promptReview.editor={status:'waiting'};
 p.promptReview.items[0].agentAudit={source:'fixture',status:'reviewed',issues:[]};
 const store={getProject:()=>structuredClone(p),saveProject:x=>(p=structuredClone(x)),getSettings:()=>({})};
 const w=Object.create(WorkbenchWorkflow.prototype);w.store=store;w.operationControls=new Map();w.promptReviewIsCurrent=()=>true;
 let edits=0;w.editPromptReviewDocument=async()=>{edits++;let current=store.getProject();current.promptReview.items[0]={...applyItem(current,{...current.promptReview.items[0],mode:'manual'},'修改后的文本','edited execution',''),status:'draft',agentAudit:{source:'fixture',status:'reviewed',issues:[]}};current.promptReview.editor={status:'completed'};store.saveProject(current);return current;};
 const original=p.promptReview.items[0].prompt;
 const result=await w.confirmAllPromptReview(p.id,[]);assert.equal(edits,0);assert.equal(result.promptReview.status,'approved');assert.equal(result.promptReview.items[0].userConfirmed,true);assert.equal(result.promptReview.items[0].prompt,original);
});
test('missing video prompts do not start review or produce an approval',async()=>{
 let p=project();p.promptReview.items=[];
 const result=await editor.edit({projectId:p.id,settings:{},getProject:()=>p,saveProject:x=>(p=x),applyItem,generate:async()=>{throw Error('must not call Agent');}});
 assert.equal(result.promptReview.status,'pending');assert.equal(result.promptReview.editor.waitingReason,'prompt_delivery');
});
