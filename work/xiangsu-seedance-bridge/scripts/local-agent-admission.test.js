'use strict';
// Regression guard for the two admission defects found in production runs:
// a stage re-triggered by its own checkpoint save started four separately
// billed Agent turns inside 0.45 seconds, and a rejected MCP submission could
// retry forever while the interface kept saying "正在保存结果".
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AgentHub}=require('../app/local-agent-runtime');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
const recovery=require('../app/agent-delivery-recovery');
function hubWithRecorder(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-admission-'));
  const hub=new AgentHub(root),turns=[];
  // Stand in for a real turn: it registers the same stage bookkeeping the
  // production runner registers, and it can finish immediately.
  hub.runFresh=async function(config,request,options={}){
    turns.push({config,request,options});
    const jobId=`agent_${String(turns.length).padStart(8,'0')}-0000-4000-8000-000000000000`;
    if(options.stageKey){this.stageStarts.set(options.stageKey,Date.now());this.latestByStage.set(options.stageKey,jobId);}
    return {text:`turn-${turns.length}`,jobId,agentId:config.id,execution:{},streamed:false};
  };
  return {root,hub,turns};
}
const agent={id:'workbuddy',authoringMode:'mcp',transport:'cli'};
const textRequest={modality:'text',messages:[{role:'user',content:'写这一批镜头'}]};
// A project-level singleton stage must declare its logical-stage identity; the
// transport will not guess one, because a guessed identity would fold legitimate
// parallel per-asset batches into a single paid turn.
const stageOptions={costProjectId:'project_a',costOperation:'master_production_decisions',dedupeScope:'project-singleton'};
test('a stage re-triggered while its turn is in flight folds onto that same turn',async()=>{
  const {hub,turns}=hubWithRecorder();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const realRunFresh=hub.runFresh;
  hub.runFresh=async function(config,request,options){const started=await realRunFresh.call(this,config,request,options);await gate;return started;};
  const first=hub.run(agent,textRequest,{...stageOptions});
  const second=hub.run(agent,textRequest,{...stageOptions});
  const third=hub.run(agent,textRequest,{...stageOptions});
  release();
  const results=await Promise.all([first,second,third]);
  assert.equal(turns.length,1,'同一阶段并发只应产生一次 Agent 调用');
  assert.equal(results[0].jobId,results[1].jobId);
  assert.equal(results[1].jobId,results[2].jobId);
  assert.equal(hub.stageAdmissions.get(hub.stageKeyOf(agent,textRequest,stageOptions)).merged,2);
});
test('a stage re-triggered right after its turn ended reuses the saved result instead of paying again',async()=>{
  const {root,hub,turns}=hubWithRecorder();
  const jobId='agent_00000001-0000-4000-8000-000000000000';
  fs.mkdirSync(path.join(root,jobId),{recursive:true});
  fs.writeFileSync(path.join(root,jobId,'result.txt'),'已保存的舞台结果','utf8');
  hub.jobs.set(jobId,{id:jobId,agentId:'workbuddy',modality:'text',projectId:'project_a',operation:'master_production_decisions',status:'completed'});
  const key=hub.stageKeyOf(agent,textRequest,stageOptions);
  hub.stageStarts.set(key,Date.now());hub.latestByStage.set(key,jobId);
  const result=await hub.run(agent,{...textRequest,json:false},{...stageOptions});
  assert.equal(turns.length,0,'窗口内重复启动不应再开一次 Agent');
  assert.equal(result.text,'已保存的舞台结果');
  assert.equal(result.foldedDuplicateStart,true);
  assert.equal(hub.stageAdmissions.get(key).reused,1);
});
test('a duplicate start with no reusable artifact is refused with the original turn named',async()=>{
  const {hub,turns}=hubWithRecorder();
  const key=hub.stageKeyOf(agent,textRequest,stageOptions);
  hub.jobs.set('agent_deadbeef-0000-4000-8000-000000000000',{id:'agent_deadbeef-0000-4000-8000-000000000000',agentId:'workbuddy',modality:'text',status:'failed'});
  hub.stageStarts.set(key,Date.now());hub.latestByStage.set(key,'agent_deadbeef-0000-4000-8000-000000000000');
  await assert.rejects(hub.run(agent,textRequest,{...stageOptions}),error=>(error.code==='LOCAL_AGENT_DUPLICATE_START'&&error.duplicateOfJobId==='agent_deadbeef-0000-4000-8000-000000000000'));
  assert.equal(turns.length,0,'被拒绝的重复启动不得创建 Agent 进程');
});
test('different assets in one stage, and different stages, are never folded together',async()=>{
  const {hub,turns}=hubWithRecorder();
  await hub.run(agent,{modality:'image',prompt:'场景A'},{costProjectId:'project_a',costOperation:'scene_asset',dedupeScope:'scene_asset:scene_a'});
  await hub.run(agent,{modality:'image',prompt:'场景B'},{costProjectId:'project_a',costOperation:'scene_asset',dedupeScope:'scene_asset:scene_b'});
  await hub.run(agent,textRequest,{...stageOptions});
  assert.equal(turns.length,3,'不同资产与不同阶段必须各自独立启动');
});
test('an explicit重新生成 request past the window is still admitted',async()=>{
  const {hub,turns}=hubWithRecorder();
  const key=hub.stageKeyOf(agent,textRequest,stageOptions);
  hub.stageStarts.set(key,Date.now()-60_000);hub.latestByStage.set(key,'agent_old-0000-4000-8000-000000000000');
  await hub.run(agent,textRequest,{...stageOptions});
  assert.equal(turns.length,1,'超出窗口的正常重跑不应被拒绝');
});
test('calls without a project never fold across projects',async()=>{
  const {hub,turns}=hubWithRecorder();
  // No costProjectId: folding here could serve one project another project's
  // saved result, which is worse than paying for the turn twice.
  await hub.run(agent,textRequest,{costOperation:'some_shared_stage',dedupeScope:'project-singleton'});
  await hub.run(agent,textRequest,{costOperation:'some_shared_stage',dedupeScope:'project-singleton'});
  assert.equal(turns.length,2,'缺少项目上下文时不得跨项目折叠');
});
test('a stage that declares no scope is never folded, even in the same instant',async()=>{
  const {hub,turns}=hubWithRecorder();
  // Real evidence: four `asset_execution_prompt` turns 430ms apart with four
  // different bodies are four different assets, each of which deserves its own
  // paid draw. Without a declared identity the transport must not guess one, or
  // three assets would silently lose their prompt.
  const perAsset=scoped=>({costProjectId:'project_a',costOperation:'asset_execution_prompt',...(scoped?{dedupeScope:'entity:asset_1'}:{})});
  await hub.run(agent,textRequest,perAsset(false));
  await hub.run(agent,textRequest,perAsset(false));
  await hub.run(agent,textRequest,perAsset(false));
  assert.equal(turns.length,3,'未声明身份的阶段不得被折叠');
  assert.equal(hub.stageKeyOf(agent,textRequest,perAsset(false)),'','未声明身份不得产生折叠键');
});
test('the folding identity of a stage is the exact logical turn, not the stage name',async()=>{
  const workflow=Object.create(WorkbenchWorkflow.prototype);
  // Real evidence: one project started `master_production_decisions` four times
  // in 0.2-0.3s and all four carried the same 42-shot set. That is one turn paid
  // for four times, and the identical shot set must therefore fold...
  const fourtyTwo=Array.from({length:42},(_,i)=>`shot_${String(i+1).padStart(2,'0')}`);
  const first=workflow.textStageDedupeScope('master_production_decisions',{dedupeShotIds:fourtyTwo});
  const again=workflow.textStageDedupeScope('master_production_decisions',{dedupeShotIds:[...fourtyTwo].reverse()});
  assert.ok(first,'同一镜头集合必须得到折叠身份');
  assert.equal(first,again,'镜头集合相同（与顺序无关）即同一逻辑轮次');
  // ...while a different shot set is the legitimate parallel batch mode of the
  // same stage (parallelism up to 4) and must stay a separate paid turn.
  const batch=workflow.textStageDedupeScope('master_production_decisions',{dedupeShotIds:fourtyTwo.slice(0,10)});
  assert.notEqual(batch,first,'不同镜头批次不得被折叠');
  // A stage that declares no identity is never folded: four `asset_execution_prompt`
  // batches 430ms apart with four different bodies are four different assets.
  assert.equal(workflow.textStageDedupeScope('asset_execution_prompt',{}),'','按资产并行的阶段不得获得共享身份');
  assert.equal(workflow.textStageDedupeScope('asset_execution_prompt',{entityId:'asset_1'}),'entity:asset_1');
  assert.equal(workflow.textStageDedupeScope('asset_execution_prompt',{dedupeIds:['a','b']}),workflow.textStageDedupeScope('asset_execution_prompt',{dedupeIds:['b','a']}));
  assert.equal(workflow.textStageDedupeScope('asset_execution_prompt',{dedupeScope:'explicit'}),'explicit');
});
test('production stage options really carry the declared identity to the transport',async()=>{
  const workflow=Object.create(WorkbenchWorkflow.prototype);
  workflow.operationControls=new Map();
  workflow.setAutomation=()=>{};
  const decisions=workflow.productionTextOptions('project_a','master_production_decisions',{dedupeShotIds:['shot_01','shot_02']});
  assert.equal(decisions.costProjectId,'project_a');
  assert.equal(decisions.costOperation,'master_production_decisions');
  assert.ok(decisions.dedupeScope,'主编排阶段必须把镜头集合身份传给接入层');
  const assets=workflow.productionTextOptions('project_a','asset_execution_prompt',{});
  assert.equal(assets.dedupeScope,'','按资产并行的阶段不得声明共享身份');
  const assetsScoped=workflow.productionTextOptions('project_a','asset_execution_prompt',{dedupeIds:['asset_1','asset_2']});
  assert.ok(assetsScoped.dedupeScope,'同一批次重复触发必须可以识别为同一逻辑轮次');
});
test('resubmission recovery is bounded and ends in an explicit failed state',async()=>{
  let calls=0;
  await assert.rejects(
    recovery.recover({read:()=>null,invoke:async()=>{calls+=1;},status:()=>{},diagnose:()=>({previewStatus:'needs_revision',findings:[{path:'$.data.shots[0]',reason:'缺少说话人'}]})}),
    error=>(error.code==='LOCAL_AGENT_DELIVERY_RECOVERY_EXHAUSTED'
      && error.deliveryAttempts===recovery.MAX_DELIVERY_RECOVERY_ATTEMPTS
      && /缺少说话人/.test(error.rejectionSummary))
  );
  assert.equal(calls,recovery.MAX_DELIVERY_RECOVERY_ATTEMPTS,'补交次数必须等于上限，不能继续无限重试');
});
test('a submission that lands late is still accepted before the cap',async()=>{
  let receipt=null,calls=0;
  const result=await recovery.recover({read:()=>receipt,invoke:async()=>{if(++calls===4)receipt={value:{saved:true}};}});
  assert.deepEqual(result,{value:{saved:true}});
  assert.equal(calls,4);
});
test('a failed resubmission turn reports the MCP reason instead of a bare transport error',async()=>{
  await assert.rejects(
    recovery.recover({read:()=>null,invoke:async()=>{throw Object.assign(new Error('补交进程未正常结束'),{code:'LOCAL_AGENT_RESULT_FAILED'});},diagnose:()=>({submissions:9,savedParts:5,mcpResultPresent:false})}),
    error=>(error.code==='LOCAL_AGENT_RESULT_FAILED'&&error.deliveryAttempts===1&&/已提交 9 次/.test(error.rejectionSummary))
  );
});
function fakeWorkflow(){
  const workflow=Object.create(WorkbenchWorkflow.prototype);
  const draws=[],leases=[];
  workflow.store={getProject:()=>({id:'project_a',generation:{mode:'asset_direct'},productionRevision:'rev-1'})};
  workflow.imageGenerationPromises=new Map();
  workflow.imageGenerationStarts=new Map();
  workflow.imageAdmissions=new Map();
  workflow.preparePromptReviewBundle=async()=>{};
  workflow.assertPromptReviewApproved=()=>{};
  workflow.withLicenseLease=async(kind,leaseTaskId,meta,fn)=>{leases.push(leaseTaskId);return fn(null);};
  workflow._generateImageCandidateUnlocked=async(projectId,stage,entityId)=>{draws.push(`${stage}:${entityId}`);return {candidateId:`${stage}:${entityId}`};};
  return {workflow,draws,leases};
}
test('two concurrent draws of one asset start only one paid image task',async()=>{
  const {workflow,draws,leases}=fakeWorkflow();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const realUnlocked=workflow._generateImageCandidateUnlocked;
  workflow._generateImageCandidateUnlocked=async(...args)=>{const out=await realUnlocked(...args);await gate;return out;};
  const first=workflow.generateImageCandidate('project_a','character_intro','character_1');
  const second=workflow.generateImageCandidate('project_a','character_intro','character_1');
  release();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(draws.length,1,'同一资产并发抽卡只应发出一次付费请求');
  assert.deepEqual(a,b);
  assert.equal(leases.length,1);
  assert.equal(workflow.imageAdmissions.get('project_a:character_intro:character_1').merged,1);
});
test('a draw re-triggered inside the window is refused instead of charged twice',async()=>{
  const {workflow,draws}=fakeWorkflow();
  await workflow.generateImageCandidate('project_a','scene_asset','scene_1');
  await assert.rejects(workflow.generateImageCandidate('project_a','scene_asset','scene_1'),error=>(error.code==='IMAGE_DUPLICATE_START'&&error.stage==='scene_asset'&&error.entityId==='scene_1'));
  assert.equal(draws.length,1,'被拒绝的重复抽卡不得发起请求');
  assert.equal(workflow.imageAdmissions.get('project_a:scene_asset:scene_1').rejected,1);
});
test('a deliberate re-draw past the window keeps one stable lease identity',async()=>{
  const {workflow,draws,leases}=fakeWorkflow();
  await workflow.generateImageCandidate('project_a','scene_asset','scene_1');
  workflow.imageGenerationStarts.set('project_a:scene_asset:scene_1',Date.now()-60_000);
  await workflow.generateImageCandidate('project_a','scene_asset','scene_1');
  assert.equal(draws.length,2);
  assert.equal(leases[0],leases[1],'同一逻辑抽卡的重试必须复用同一 lease 身份，不能注册成新任务');
  assert.ok(!/:1[0-9]{12}$/.test(leases[0]),'lease 不得包含时间戳，否则服务端无法识别为同一任务');
});
test('different assets in the same stage each get their own paid draw',async()=>{
  const {workflow,draws}=fakeWorkflow();
  await workflow.generateImageCandidate('project_a','scene_asset','scene_1');
  await workflow.generateImageCandidate('project_a','scene_asset','scene_2');
  assert.equal(draws.length,2,'不同资产不得被折叠成一次抽卡');
});
