'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('original duration estimation is one cached Agent request, not a prose character heuristic',async()=>{
 const runtime=require('../app/adaptation-runtime-evidence');let cached,calls=0;
 const args={source:'阿婆：这瓶是你送给我的？',contract:{kind:'adaptation'},execution:{model:'hy4'},save:v=>cached=v,generate:async(m,o)=>{calls++;assert.equal(o.agentStage,'review');const result={seconds:80,evidence:'Original complete dialogue and concurrent physical performance estimate.'};assert.equal(require('../app/typed-output-receipt').conforms(result,o.responseSchema),true);return result;}};
 const a=await runtime.resolve(args);assert.equal(a.minSeconds,50);assert.equal(a.maxSeconds,110);assert.match(a.basis,/estimate/);
 assert.deepEqual(await runtime.resolve({...args,checkpoint:{runtimeEstimate:cached}}),a);assert.equal(calls,1);
 await runtime.resolve({...args,checkpoint:{runtimeEstimate:cached},execution:{model:'glm'}});assert.equal(calls,2);
 await runtime.resolve({...args,contract:{kind:'adaptation',basis:'source-explicit-timeline',sourceSeconds:90}});assert.equal(calls,2);
});
test('asset review depends on relevant canonical facts, not unrelated film changes',()=>{
 const source={script:'whole story',acceptedShotScreenplay:true,product:{},characters:[{id:'A',name:'甲'},{id:'B',name:'乙'}],scenes:[],props:[],shots:[],canonicalAssetSource:{characters:[{id:'A',name:'甲'},{id:'B',name:'乙'}],shots:[{id:'S1',characterIds:['A'],action:'甲出门'},{id:'S2',characterIds:['B'],action:'乙收拾桌子'}]}};
 const tasks=require('../app/agent-stage-tasks'),items=[{entityType:'character',entityId:'A',stage:'character_intro'}],a=tasks.reviewBatchSource(source,items);
 assert.equal(a.script,undefined);assert.equal(a.canonicalAssetSource,undefined);assert.equal(a.canonicalAssetEvidence.shots.length,1);
 source.script+=' new unrelated scene';source.canonicalAssetSource.shots[1].action='乙离开';source.characters[1].name='丙';assert.deepEqual(tasks.reviewBatchSource(source,items),a);
 source.canonicalAssetSource.shots[0].action='甲拿伞出门';assert.notDeepEqual(tasks.reviewBatchSource(source,items),a);
 const unmapped=tasks.reviewBatchSource(source,[{entityType:'prop',entityId:'unknown'}]);assert.ok(unmapped.script);
});
test('automatic repair does not repeat unchanged content merely because the round counter advances',()=>{
 const reserve=require('../app/prompt-repair-progress').reserve,p={script:{raw:'source'}},items=[{id:'S1',prompt:'words',agentAudit:{issues:['source mismatch']}}];
 reserve(p,items,{model:'hy4'});assert.throws(()=>reserve(p,items,{model:'hy4'}),{code:'AGENT_EVIDENCE_PENDING'});
 items[0].prompt='corrected';reserve(p,items,{model:'hy4'});assert.equal(Object.keys(p.promptRepairProgress.attempted).length,2);
});
test('frontend and backend use the same evidence state and cannot label missing evidence approved',()=>{
 const ui=require('../app/renderer/review-receipt-state'),p=require('../app/unified-audit-policy');assert.equal(ui.state,p.receiptState);
 const item={status:'confirmed',userConfirmed:true,agentAudit:{issues:[],status:'needs_evidence',unresolvedFindings:[{reason:'缺少原始商品图'}]}};
 assert.equal(ui.approved({status:'approved',items:[item]}),false);assert.match(ui.label(item.agentAudit),/待补齐.*商品图/);assert.doesNotMatch(ui.label(item.agentAudit),/通过|未发现/);
 item.agentAudit={issues:[]};assert.equal(ui.approved({status:'approved',items:[item]}),true);
});
test('custom reference instructions are preserved and only default settings migration upgrades legacy prose',()=>{
 const r=require('../app/reference-parity-prompts'),key=r.referenceParityPromptKey('story_bible');assert.ok(key);
 const custom='用户自定义：保留恰好两个角色，不追加自动替换。';assert.ok(r.referenceParityFor({[key]:custom},'story_bible').includes(custom));
 assert.ok(r.appendReferenceParity(custom,{[key]:custom},'story_bible').startsWith(custom));
});
test('fallback final writer receives complete current-shot facts and can deliver a continuous shot',async()=>{
 const editor=require('../app/h3-final-prompt-editor');let project={id:'P',characters:[],shots:[{id:'S1',duration:10,providerSemanticCompileSource:'ai-batch',action:'她拿起原来的杯子',providerTimedDirections:[{start:0,end:10,actionEn:'She raises the original cup without a cut.'}],dialogueTurns:[{sourceDialogueId:'D1',speakerId:'C1',text:'这杯茶是你留给我的。',start:1,end:3,listenerIds:[],onScreen:true}]}]},calls=0;
 await editor.author({getProject:()=>structuredClone(project),saveProject:p=>{project=p;},projectId:'P',settings:{textProvider:{}},optionsFor:(p,s,o)=>o,generate:async(c,m,o)=>{calls++;assert.equal(o.agentStage,'planning');const input=JSON.parse(m[1].content);assert.equal(input.shots[0].requiredCameraLayout,undefined);assert.equal(input.shots[0].directions.length,1);assert.ok(o.responseSchema.properties.items.items.anyOf[0].properties.detailedDescriptionEn);return {items:[{shotId:'S1',detailedDescriptionEn:'[Shot 1] One continuous shot. C1 (S1) speaks: <d>[Chinese] 这杯茶是你留给我的。</d>',detailedDescriptionZh:'一个连续镜头，人物拿起杯子说原台词。',summaryEn:'She raises the cup and answers.',soundscapeEn:'Quiet room.'}]};}});
 assert.equal(calls,1);assert.equal(editor.current(project.shots[0]),true);assert.doesNotMatch(project.shots[0].finalPromptEditing.detailedDescriptionEn,/\[Shot 2\]/);
});
test('transport normalization stops unchanged invalid responses after diagnosis and preserves raw evidence',async()=>{
 const recovery=require('../app/agent-output-normalization');let calls=0;const receipts=[];
 await assert.rejects(recovery.recover({rawText:'original',messages:[],options:{json:true,responseSchema:{type:'object',required:['items'],properties:{items:{type:'array'}}}},invoke:async()=>{calls++;return 'still not JSON';},onAttempt:r=>receipts.push(r)}),e=>e.code==='AGENT_EVIDENCE_PENDING'&&e.originalRawText==='original'&&e.rawText==='still not JSON');
 assert.equal(calls,3);assert.equal(receipts.at(-1).status,'needs_evidence');
});

test('source-planning findings are valid deliveries, retain successful siblings and go to independent source diagnosis',async()=>{
 const editor=require('../app/h3-final-prompt-editor');let p={id:'P',shots:['S1','S2'].map(id=>({id,duration:10,action:'source action',providerSemanticCompileSource:'ai-batch',dialogueTurns:[]}))},calls=0;
 const response={items:[{shotId:'S1',status:'source_planning_repair_required',reason:'Source names mutually exclusive ownership at the same moment.'},{shotId:'S2',detailedDescriptionEn:'One continuous source action.',detailedDescriptionZh:'同一源稿动作连续完成。',summaryEn:'The source action finishes.',soundscapeEn:'Quiet room.'}]};
 assert.equal(require('../app/typed-output-receipt').conforms(response,editor.DELIVERY_SCHEMA),true);
 await assert.rejects(editor.author({getProject:()=>structuredClone(p),saveProject:x=>{p=x;},generate:async()=>{calls++;return response;},optionsFor:(p,s,o)=>o,settings:{textProvider:{}},projectId:'P'}),e=>e.code==='H3_SOURCE_PLANNING_REPAIR_REQUIRED'&&e.sourceTimingIssues.length===1&&e.sourceTimingIssues[0].shotId==='S1');
 assert.equal(calls,1);assert.equal(editor.current(p.shots[1]),true);assert.ok(p.shots[0].finalPromptSourceFinding.reason);assert.equal(p.shots[0].finalPromptEditing,undefined);
});

test('director speech schema allows a clean early onset without imposing a 0.3 second silent lead',()=>{
 const s={id:'S1',dialogueTurns:[{id:'D1',speakerId:'C1',text:'开始。'}]},schema=require('../app/agent-production-decisions').schema({characters:[{id:'C1'}],assetLibraries:{props:[]}},[s]);
 const row=schema.properties.items.items.anyOf[0].properties.dialogue.items.anyOf[0];
 assert.equal(require('../app/typed-output-receipt').conforms({id:'D1',start:.05,end:1,deliveryEn:'Clean clear onset.',deliveryZh:'干净清楚起音。',listenerIds:[],addressMode:'self'},row),true);
});

test('workflow sends final-writer source conflicts to independent diagnosis and regenerates after source repair',async t=>{
 const editor=require('../app/h3-final-prompt-editor'),recovery=require('../app/screenplay-source-recovery'),oldAuthor=editor.author,oldRecover=recovery.recover;
 t.after(()=>{editor.author=oldAuthor;recovery.recover=oldRecover;});
 const w=Object.create(require('../app/workbench-workflow').WorkbenchWorkflow.prototype);let authored=0,diagnosed=0,compiled=0;
 w.store={getSettings:()=>({generation:{agentDecisionAuthority:false}}),getProject:()=>({id:'P'}),saveProject:p=>p};w.operationControls=new Map();w.generateText=()=>{};w.productionTextOptions=()=>{};
 editor.author=async()=>{if(++authored===1)throw Object.assign(Error('source finding'),{code:'H3_SOURCE_PLANNING_REPAIR_REQUIRED',sourceTimingIssues:[{shotId:'S1',reason:'conflicting source ownership'}]});return {id:'P',repaired:true};};
 recovery.recover=async args=>{diagnosed++;assert.deepEqual(Object.keys(args.findingsByShot),['S1']);return {changed:true};};
 w.compileH3AssetDirectSemanticsBatch=async()=>{compiled++;};
 const result=await w.authorFinalH3PromptBlocks('P');assert.equal(result.repaired,true);assert.equal(authored,2);assert.equal(diagnosed,1);assert.equal(compiled,1);
});
test('confirm all independently reviews edits and cannot advance an unresolved item',async t=>{
 const tasks=require('../app/agent-stage-tasks'),old=tasks.reviewStagePrompts;let calls=0,passed=false;
 tasks.reviewStagePrompts=async items=>{calls++;for(const i of items)i.agentAudit={issues:[],status:passed?'reviewed':'needs_evidence'};};t.after(()=>{tasks.reviewStagePrompts=old;});
 const W=require('../app/workbench-workflow').WorkbenchWorkflow,w=Object.create(W.prototype);let p={id:'P',script:{raw:''},characters:[],scenes:[],shots:[],product:{},promptReview:{status:'ready',items:[{id:'a',prompt:'words',displayPrompt:'原文',agentAudit:{issues:[],status:'needs_evidence'}}]}};
 w.store={getProject:()=>p,saveProject:x=>(p=x),getSettings:()=>({})};w.operationControls=new Map();w.promptReviewIsCurrent=()=>true;w.compilePromptReviewEdit=async()=> 'edited';w.applyPromptReviewItem=(p,i,display,prompt)=>({...i,prompt,displayPrompt:display,status:'confirmed',userConfirmed:true,agentAudit:null});
 await w.confirmAllPromptReview('P',[{id:'a',prompt:'修改稿'}]);assert.equal(calls,1);assert.equal(p.promptReview.status,'ready');assert.equal(p.promptReview.counts.confirmed,0);assert.equal(p.automation.status,'awaiting_prompt_review');
 passed=true;await w.confirmAllPromptReview('P');assert.equal(calls,2);assert.equal(p.promptReview.status,'approved');assert.equal(p.promptReview.counts.confirmed,1);
});
