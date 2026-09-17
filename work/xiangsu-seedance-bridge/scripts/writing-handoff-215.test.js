'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const path=require('node:path');
const appPath=name=>path.join(process.env.DRAMA_TEST_APP_ROOT||path.resolve(__dirname,'../app'),name);
const {WorkbenchWorkflow,ideaSignature,scriptPipelineEntryRoute}=require(appPath('workbench-workflow'));
function fixture(){
 const project={id:'handoff',productionPlan:{executionMode:'step',commerceMode:'none',inputMode:'ai',scriptFormat:'production',scriptFormatConfirmed:true},generation:{mode:'asset_direct',modeConfirmed:true,engine:'hailuo-h3',videoProviderKind:'puream-hailuo-h3'},product:{},ideation:{selectedTopicId:'topic',topics:[{id:'topic',title:'测试',hook:'冲突',logline:'主线',reversal:'反转',emotionalPayoff:'和解'}]},script:{raw:''},shots:[],automation:{}};
 const calls=[],store={getProject:()=>project,saveProject:p=>Object.assign(project,p),getSettings:()=>({videoProvider:{kind:'puream-hailuo-h3'}})};
 const w=new WorkbenchWorkflow({store,bridge:{}});
 w.generateCompleteScript=async()=>{calls.push('write');project.script={raw:'已保存的完整正文',authoredWithoutDurationTarget:true,adaptiveAuthoring:{status:'ready'},ideaSignature:ideaSignature(project)};return project;};
 w.analyzeScript=async()=>{calls.push('analyze');project.shots=[{id:'S01',duration:10}];return project;};
 w.requestPromptReview=async()=>{calls.push('review');project.promptReview={status:'ready',items:[{id:'fixture',prompt:'完整提示词'}]};return {required:true,project};};
 return {w,project,calls};
}
test('new AI script reaches analysis before materialization guard, then waits for prompt confirmation',async()=>{
 const {w,project,calls}=fixture();await w.runPipelineFromStage(project.id,'script',{track:false});assert.deepEqual(calls,['write','analyze','review']);assert.equal(project.shots.length,1);
});
test('existing complete authored source resumes analysis without rewriting',async()=>{
 const {w,project,calls}=fixture();await w.generateCompleteScript();calls.length=0;await w.runPipelineFromStage(project.id,'script',{track:false});assert.deepEqual(calls,['analyze','review']);
});
test('idea-to-full retry reuses approved source after analysis failed',async()=>{
 const {w,project,calls}=fixture();await w.generateCompleteScript();calls.length=0;w.runFullPipeline=async()=>{calls.push('full');return project;};await w.runIdeaToFullPipeline(project.id,{track:false});assert.deepEqual(calls,['analyze','full']);
});
test('analysis failure preserves original error and source, does not enter prompt or paid stages',async()=>{
 const {w,project,calls}=fixture();w.analyzeScript=async()=>{throw Object.assign(Error('upstream timeout'),{code:'LOCAL_AGENT_TIMEOUT'});};await assert.rejects(w.runPipelineFromStage(project.id,'script',{track:false}),{code:'LOCAL_AGENT_TIMEOUT'});assert.equal(project.script.raw,'已保存的完整正文');assert.deepEqual(calls,['write']);
});
test('analysis returning no shots is rejected, never bypasses materialization',async()=>{
 const {w,project,calls}=fixture();w.analyzeScript=async()=>project;await assert.rejects(w.runPipelineFromStage(project.id,'script',{track:false}),{code:'SCRIPT_NOT_MATERIALIZED'});assert.deepEqual(calls,['write']);
});
for(const status of ['failed','paused_user','paused'])test(`adaptive writing ${status} resumes saved checkpoint`,async()=>{
 const {w,project,calls}=fixture();project.script.adaptiveAuthoring={plan:{scenes:[{id:'one'}]},parts:[{sceneId:'one',scriptText:'保留'}]};project.automation={status,operation:'idea_script'};await w.resumeScriptGeneration(project.id);assert.deepEqual(calls,['write']);
});
test('old screenshot failure resumes saved source through analysis into prompt confirmation',async()=>{
 const {w,project,calls}=fixture();await w.generateCompleteScript();calls.length=0;project.automation={status:'failed',operation:'idea_script',errorCode:'SCRIPT_NOT_MATERIALIZED'};await w.resumeScriptGeneration(project.id);assert.deepEqual(calls,['analyze','review']);
});
test('incomplete adaptive draft routes to writer, not imported-text parser',()=>{
 const {project}=fixture();project.script={raw:'未完成正文',adaptiveAuthoring:{parts:[{}]}};assert.equal(scriptPipelineEntryRoute(project),'resume_generation');
});
test('unapproved adaptive source resumes review instead of bypassing it through analysis',()=>{
 const {project}=fixture();project.script={raw:'完整但尚未通过审核',authoredWithoutDurationTarget:true,adaptiveAuthoring:{status:'needs_review'}};assert.equal(scriptPipelineEntryRoute(project),'resume_generation');
});
test('manual-resume adaptive review cannot restart the legacy rewrite supervisor',async()=>{
 const {w,project}=fixture();project.script.adaptiveAuthoring={status:'needs_review'};
 assert.equal(await w.recoverAutonomousPipelineFailure(project.id,{code:'SCRIPT_SEMANTIC_REVIEW_FAILED',retryRequiresExplicitResume:true},{}),false);
});
test('real writer orchestration preserves interrupted shot draft without reporting completion',async t=>{
 const {w,project}=fixture();delete w.generateCompleteScript;
 const author=require(appPath('shot-screenplay')),original=author.author;
 t.after(()=>{author.author=original;});
 author.author=async({save})=>{save({status:'reviewing',document:require('./shot-screenplay-fixture').fixture()});throw Object.assign(Error('service interrupted'),{code:'NETWORK_ERROR'});};
 await assert.rejects(w.generateCompleteScript(project.id,{track:false}),{code:'NETWORK_ERROR'});
 assert.equal(project.script.shotAuthoring.status,'reviewing');assert.equal(project.script.raw,'');assert.equal(project.shots.length,0);
});
const renderer=fs.readFileSync(appPath('renderer/workbench.js'),'utf8');
const stateFunction=renderer.slice(renderer.indexOf('function scriptWorkflowState('),renderer.indexOf('\nfunction renderScriptTask('));
const uiState=vm.runInNewContext('('+stateFunction+')',{videoStatusApi:require(appPath('workbench-status'))});
test('UI recovery stage follows the same accepted source revision as the backend',()=>{
 const {project}=fixture();project.script={raw:'完整正文',authoredWithoutDurationTarget:false,adaptiveAuthoring:{status:'ready',text:'完整正文'}};
 project.automation={operation:'idea_script',status:'failed',errorCode:'SCRIPT_NOT_MATERIALIZED'};
 assert.equal(uiState(project).recoveryKind,'analysis');
 project.script.raw='新修订正文';assert.equal(uiState(project).recoveryKind,'adaptive');
});
test('complete document with Agent quality advice can proceed to analysis without claiming review approval',()=>{
 const {project}=fixture();project.script={raw:'完整但有审核建议的正文',adaptiveAuthoring:{status:'needs_review',documentComplete:true,text:'完整但有审核建议的正文',audit:{ok:false,issues:[{message:'请核对情绪'}]}}};assert.equal(scriptPipelineEntryRoute(project),'analyze_imported');assert.equal(project.script.adaptiveAuthoring.audit.ok,false);
});
test('Codex text overrides identify quoted MCP names and deduplicate nested sections',()=>{
 const {serverNames}=require(appPath('codex-text-isolation'));
 assert.deepEqual(serverNames('[mcp_servers.workbench]\n[mcp_servers.workbench.env]\n[mcp_servers."space.name"]\n[mcp_servers.\'quoted-name\']\n# [mcp_servers.ignored]'),['workbench','space.name','quoted-name']);
});
test('native author running status is active so pause controls remain available',()=>{
 const {project}=fixture();project.automation={operation:'idea_script',stage:'idea_script',status:'running'};assert.equal(uiState(project).active,true);
});
test('new adaptive checkpoint exposes explicit retry and manual pause in UI',()=>{
 const {project}=fixture();project.script.adaptiveAuthoring={plan:{}};project.automation={operation:'idea_script',stage:'idea_script',status:'failed'};assert.equal(uiState(project).recoverableFailure,true);assert.equal(uiState(project).recoveryKind,'adaptive');project.automation.status='paused';assert.equal(uiState(project).paused,true);
});
test('whole-script timing payload removes repeated prose but retains every sentence timing',()=>{
 const source='王芳（对母亲；压住委屈，吐字清楚；说话同时把收据放在桌上）：这张收据是我留下的。我没有忘记你。';
 const rows=require(appPath('staged-upload-preparation')).sourceSpeechTiming(source.split('\n'));
 const compact=require(appPath('whole-script-preparation')).compactSpeechTiming(source);
 assert.equal(compact.length,rows.length);assert.equal(compact[0].sourceLine,1);
 assert.equal(compact[0].calculatedSpeechWindow.targetSeconds,rows[0].calculatedSpeechWindow.targetSeconds);
 assert.deepEqual(compact[0].completeSentenceOptions.map(s=>s.maxSeconds),rows[0].completeSentenceOptions.map(s=>s.calculatedSpeechWindow.maxSeconds));
 assert.ok(JSON.stringify(compact).length<JSON.stringify(rows).length);assert.ok(!JSON.stringify(compact).includes('这张收据'));
});
test('real complete-writer return feeds one-click analysis without the retired duration flag',async t=>{
 const {w,project,calls}=fixture();delete w.generateCompleteScript;
 const author=require(appPath('shot-screenplay')),original=author.author;
 t.after(()=>{author.author=original;});
 author.author=async()=>{calls.push('author');const document=require('./shot-screenplay-fixture').fixture();return {status:'ready',document,text:author.render(document),attempts:[{stage:'write'}],reviews:[{ok:true,issues:[]}]};};
 await w.runPipelineFromStage(project.id,'script',{track:false});
 assert.equal(project.script.authoredWithoutDurationTarget,false);
 assert.equal(require(appPath('workbench-workflow')).projectInputMode(project),'manual');
 assert.equal(project.productionPlan.inputMode,'ai');
 assert.deepEqual(calls,['author','analyze','review']);assert.equal(project.shots.length,1);
});

for(const mode of ['asset_direct','keyframe','storyboard_sheet'])test(`runtime-targeted ready writer hands off in ${mode}`,async()=>{
 const {w,project,calls}=fixture();project.generation.mode=mode;
 w.generateCompleteScript=async()=>{calls.push('write');project.script={raw:'已审核的完整正文',authoredWithoutDurationTarget:false,adaptiveAuthoring:{status:'ready',text:'已审核的完整正文'},ideaSignature:ideaSignature(project)};return project;};
 await w.runPipelineFromStage(project.id,'script',{track:false});assert.deepEqual(calls,['write','analyze','review']);
 project.shots=[];calls.length=0;await w.runPipelineFromStage(project.id,'script',{track:false});assert.deepEqual(calls,['analyze','review']);
});

test('ready receipt for a different source revision cannot bypass writing review',()=>{
 const {project}=fixture();project.script={raw:'已修改的新正文',authoredWithoutDurationTarget:false,adaptiveAuthoring:{status:'ready',text:'旧正文'}};
 assert.equal(scriptPipelineEntryRoute(project),'resume_generation');
});

test('runtime-targeted source resumes prompt preparation without another writing call',async()=>{
 const {w,project,calls}=fixture();project.script={raw:'已审核的完整正文',authoredWithoutDurationTarget:false,adaptiveAuthoring:{status:'ready',text:'已审核的完整正文'},ideaSignature:ideaSignature(project)};
 project.automation={status:'failed',operation:'idea_script',errorCode:'SCRIPT_NOT_MATERIALIZED'};
 await w.resumeScriptGeneration(project.id);assert.deepEqual(calls,['analyze','review']);
});
test('product-image observation counts toward the same preproduction budget',async()=>{
 const {Budget}=require(appPath('preproduction-budget')),{VERSION}=require(appPath('preproduction-performance'));
 let now=0,p={id:'budget'};const store={getProject:()=>p,saveProject:v=>{p=v;}};
 const budget=new Budget(store,{now:()=>now,limitMs:1000});
 await budget.run({latencyProfile:VERSION,costProjectId:p.id,costOperation:'product_visual_evidence'},async()=>{now=1001;});
 assert.equal(p.preproductionTiming.elapsedMs,1001);
 assert.equal(await budget.run({latencyProfile:VERSION,costProjectId:p.id,costOperation:'adaptive_script_plan'},async()=>'continued'),'continued');
});
