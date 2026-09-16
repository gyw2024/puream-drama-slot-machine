'use strict';
const crypto=require('node:crypto');
const VERSION='film-runtime-v1';
const AUTHORITY_VERSION='runtime-authority-v2-original-guidance';
const ORIGINAL_AUTHORITY='原创通常8–10分钟，保存的随机目标和450–630秒旧区间是创作指导，不是硬性验收边界。用户允许略短略长；不能仅因预计或实际总时长比旧区间略多或少而判不通过、要求全片返工或压缩对白。由 Agent 判断故事体量是否明显偏离用户要求，并给真实剧情证据；小幅时差列建议即可。简稿各镜duration是估计，最终导演在合法单镜范围内决定可演时长。完整对白、清晰语速、无人声间隔不超过3秒、真实动作与剧情优先，不能为凑指导数值删除、赶读、重复或填空镜。';
function agentPolicy(contract){
 if(!contract||contract.kind!=='original')return contract;
 return {version:contract.version,authorityVersion:AUTHORITY_VERSION,kind:'original',targetSeconds:contract.targetSeconds,guidance:{usualMinSeconds:480,usualMaxSeconds:600,legacyMinSeconds:contract.minSeconds,legacyMaxSeconds:contract.maxSeconds},constraint:'creative-guidance',authority:ORIGINAL_AUTHORITY};
}
const digest=source=>crypto.createHash('sha256').update(String(source).replace(/\r/g,'').trim()).digest('hex');
function original(previous,random=()=>crypto.randomInt(480,601)){
 if(previous?.version===VERSION&&previous.kind==='original')return previous;
 return {version:VERSION,kind:'original',targetSeconds:random(),minSeconds:450,maxSeconds:630,targetMinSeconds:480,targetMaxSeconds:600,toleranceSeconds:30,basis:'random-original-target'};
}
function measure(source){
 const timing=require('./script-duration');
 const explicit=timing.explicitTimelineDurationTarget(source);
 const label=String(source).match(/(?:全片|剧总时长|总时长|成片时长)\s*[】\]）)]*\s*(?:约|大约|为|[:：=])*\s*([^\n]+)/)?.[1]||'';
 const clock=label.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\s|$|[（(])/);
 const mixed=label.match(/^(?:(\d+(?:\.\d+)?)小时)?\s*(\d+(?:\.\d+)?)分(?:钟)?\s*(\d+(?:\.\d+)?)秒/);
 const declared=clock?Number(clock[1]||0)*3600+Number(clock[2])*60+Number(clock[3]):mixed?Number(mixed[1]||0)*3600+Number(mixed[2])*60+Number(mixed[3]):0;
 const timeline=timing.explicitShotTimelinePlan(source);
 if(declared>0&&!(timeline?.complete&&timeline.rangeCount>1))return {seconds:declared,basis:'source-explicit-timeline'};
 if(explicit)return {seconds:explicit.requestedSeconds,basis:'source-explicit-timeline'};
 const ledger=require('./dialogue-parser').parseSourceDialogueLedger(source);
 const estimate=timing.estimateUploadedScriptDuration(source,ledger);
 return {seconds:estimate.estimatedSeconds,basis:ledger.length?'source-dialogue-estimate':'source-text-estimate',dialogueTurns:ledger.length};
}
function adaptation(source,previous){
 const sourceFingerprint=digest(source);
 if(previous?.version===VERSION&&previous.kind==='adaptation'&&previous.sourceFingerprint===sourceFingerprint)return previous;
 const measured=measure(source),seconds=measured.seconds;
 // Missing prose estimates are resolved by the Agent before authoring; preserve the source.

 return {version:VERSION,kind:'adaptation',sourceFingerprint,sourceSeconds:seconds,targetSeconds:seconds,minSeconds:Math.max(0,seconds-30),maxSeconds:seconds+30,toleranceSeconds:30,basis:measured.basis};
}
function directive(contract){
 if(!contract)return '';
 const range=`${contract.minSeconds}–${contract.maxSeconds}秒`;
 return contract.kind==='original'
 ? `【全新创作时长指导】本项目已在8–10分钟内随机选定目标${contract.targetSeconds}秒；重试沿用同一目标。${ORIGINAL_AUTHORITY} 先围绕目标规划充分的冲突升级、选择代价、证据、反转及结局兑现，再一次写完全部正文。不把人物说明、动作文字或剧情简介当成说话字数，不能仅写四五分钟的提纲式故事。`
 : `【上传改写全片时长合同】原稿基准${contract.sourceSeconds}秒（依据${contract.basis}），改稿及最终分镜总时长必须${range}，上下偏差不得超过30秒。基准绑定原始稿件，禁止用改稿重新估算并覆盖基准。保留完整剧情因果、信息、商品与结局，逐段分配原有表演预算，不能摘要缩写、快读或空镜补时。无原稿时码时基准是同一计时方法的估算，不冒称原视频实测。`; 
}
function check(contract,seconds){
 if(!contract)return {ok:true,applied:false};
 const measured=Number.isFinite(seconds)&&seconds>0;
 const inGuidanceRange=measured&&seconds>=contract.minSeconds&&seconds<=contract.maxSeconds;
 const advisory=contract.kind==='original';
 return {ok:advisory?measured:inGuidanceRange,applied:true,advisory,inGuidanceRange,contract,actualSeconds:seconds,deltaSeconds:seconds-contract.targetSeconds};
}
function forStage(contract,stage){
 if(!contract)return '';
 if(/^adaptive_script_(complete|explicit_repair)$/.test(stage))return directive(contract)+'\n当前是新创编写或已授权的新创局部修订阶段；正文尚未由用户确认，可增加确有必要的协作对白、调整表演衔接。保留用户事实和故事内核，修订时仅改授权场次，不把待修新稿误当不可改的上传原文。';
 if(contract.kind==='original')return `【原创时长权限】已保存的创作目标${contract.targetSeconds}秒，不能重新抽取。${ORIGINAL_AUTHORITY} 当前只完成所分配的写作、审核、拆镜或提示词工作；不得在这些阶段擅自改写源稿，只能在授权的编剧修订阶段修改有证据的问题。`;
 return `【当前阶段全片时长验收】全片目标${contract.targetSeconds}秒，允许${contract.minSeconds}–${contract.maxSeconds}秒，${contract.kind==='adaptation'?'基准来自原始上传稿，改写偏差最多30秒。':'这是已保存的新创随机目标，不能重新抽取。'}此处检查全片所有分镜时长之和，不是单镜时长。当前只完成所分配的审核、拆镜或提示词工作；不得在这些阶段擅自改写源稿或加台词，不用慢说、空镜或重复动作填时长。若源稿本身无法执行，定位原文和具体原因，由授权的编剧修订阶段处理。`;
}
function assertShots(project){
 const c=project.script?.runtimePolicy;
 if(!c)return null;
 const result=check(c,(project.shots||[]).reduce((n,s)=>n+Number(s.duration||0),0));
 if(!result.ok)return {...result,advisory:c.kind==='original',status:c.kind==='adaptation'?'needs_agent_review':'advisory',message:`实际${result.actualSeconds}秒，目标${c.minSeconds}–${c.maxSeconds}秒；请由 Agent 结合剧情判断是否调整，保留当前完整内容供用户确认。`};
 return result;
}
const assertCapacity=(...args)=>require('./film-runtime-capacity').assertCapacity(...args);
module.exports={VERSION,AUTHORITY_VERSION,ORIGINAL_AUTHORITY,agentPolicy,original,adaptation,measure,directive,forStage,check,assertShots,assertCapacity};
