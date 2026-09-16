"use strict";
// A timed-out verdict is never approval. Reduce the breadth of each review,
// not the supplied source, reviewer selection, or total coverage.
const SCOPES = [
  {id:'performance', instruction:'只负责表演连续性：逐句说话人、听者、朝向、情绪语速及完整性；动作准备/接触/结果；物件持有人和空闲手；人物出入场与前场继承状态；画外音及每个场景音的实际来源。不要评价商品营销或另写剧情。'},
  {id:'causal_commerce', instruction:'只负责剧情与商品：当前场的关系、知情变化、证据、冲突推进、伏笔及兑现；第一场开头30秒的可理解性，最后一场的可见结局；商品信息的准确完整、持物介绍、价格活动购买入口及原包装；无依据疗效、医疗法律机制；本场与前场的因果衔接。不要重复逐帧站位或局部持物审查。'}
];
async function review({state,part,fingerprint,prompt,keys,maxTokens,call,save}) {
  state.sceneReviewRecovery ||= {};
  let recovery=state.sceneReviewRecovery[part.sceneId];
  if(recovery?.fingerprint!==fingerprint) recovery=null;
  if(!recovery){
    try{return await call(`review_scene_${part.sceneId}`,prompt,keys,maxTokens);}
    catch(error){
      if(error.code!=='LOCAL_AGENT_TIMEOUT')throw error;
      recovery={fingerprint,reason:error.code,at:new Date().toISOString(),scopes:{}};
      state.sceneReviewRecovery[part.sceneId]=recovery;save(state);
    }
  }
  const results=await Promise.allSettled(SCOPES.map(async scope=>{
    if(recovery.scopes[scope.id])return recovery.scopes[scope.id];
    const result=await call(`review_scope_${scope.id}_${part.sceneId}`,`${prompt}\n本次是一次完整场次审核超时后的分项审核。完整当前场、前场及事实均保留，但严格只审核下面的职责；另一独立分项覆盖其余职责，两个结果都完成后才能形成总判定。\n${scope.instruction}\n仍返回同一 JSON 结构。检查全范围，但结果只列发现的问题及精简证据，不逐句抄写正文；checks 按职责合并，facts 只摘本职责的关键状态与因果事实。无发现时 issues 为空，不为填满列表制造问题。`,keys,3500);
    if(typeof result?.ok!=='boolean'||!Array.isArray(result.issues)||!Array.isArray(result.checks)||!result.checks.length||!Array.isArray(result.facts)||!result.facts.length)throw Object.assign(Error(`${part.sceneId} 的 ${scope.id} 分项没有完整审核证据`),{code:'SCRIPT_REVIEW_EVIDENCE_INVALID'});
    recovery.scopes[scope.id]=result;save(state);return result;
  }));
  const failure=results.find(row=>row.status==='rejected');if(failure)throw failure.reason;
  const reports=SCOPES.map(scope=>recovery.scopes[scope.id]);
  return {ok:reports.every(row=>row.ok&&row.issues.length===0),issues:reports.flatMap(row=>row.issues),checks:reports.flatMap(row=>row.checks),facts:reports.flatMap(row=>row.facts),recovery:{method:'complete-source-split-review-dimensions',reason:recovery.reason,scopes:SCOPES.map(s=>s.id)}};
}
module.exports={review,SCOPES};
