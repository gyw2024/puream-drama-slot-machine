"use strict";
const crypto=require('node:crypto');
const VERSION='complete-scenes-then-causal-boundaries-v2';
const CAUSAL_VERSION='complete-performed-causal-source-v3-commerce';
// Include the actual review implementation/instructions, not a manually bumped
// label that can leave an outer authoring checkpoint on obsolete inner advice.
const REVIEW_REVISION=VERSION+':'+CAUSAL_VERSION+':'+crypto.createHash('sha256').update(require('node:fs').readFileSync(__filename)).update(require('node:fs').readFileSync(require.resolve('./scene-review-recovery'))).update(require('./commerce-editorial-contract').POLICY).digest('hex');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function previousSource(state,part){const i=state.parts.findIndex(p=>p.sceneId===part.sceneId);return i>0?state.parts[i-1]:null;}
function sceneFingerprint(state,part,plan,product,reviewPolicy=''){return hash({VERSION,reviewPolicy,plan,product,part,previousSource:previousSource(state,part)});}
function valid(report){return typeof report?.ok==='boolean'&&Array.isArray(report.issues)&&Array.isArray(report.checks)&&report.checks.length>0;}
function exactQuotes(fact,part){
 const quoted=String(fact.quote||'');
 const candidates=Array.isArray(fact.quotes)?fact.quotes:part.scriptText.includes(quoted)&&quoted?[quoted]:quoted.split('”“');
 let after=0;
 if(!candidates.length)return null;
 for(const quote of candidates){if(typeof quote!=='string'||!quote.trim())return null;const at=part.scriptText.indexOf(quote,after);if(at<0)return null;after=at+quote.length;}
 return candidates;
}
function bindFacts(report,part){
 if(!valid(report)||!Array.isArray(report.facts)||!report.facts.length)throw Object.assign(Error(`${part.sceneId} 审核事实没有可核对的原句证据，未判为合格`),{code:'SCRIPT_REVIEW_EVIDENCE_INVALID'});
 const invalid=report.facts.filter(f=>!f.fact||!exactQuotes(f,part));
 if(invalid.length&&(report.ok||!report.issues.length))throw Object.assign(Error(`${part.sceneId} 审核引文不属于原稿，不能批准`),{code:'SCRIPT_REVIEW_EVIDENCE_INVALID'});
 // A negative review remains usable for targeted repair, even if a fact's
 // supporting quote was paraphrased. Such facts never reach causal approval.
 return {...report,facts:report.facts.filter(f=>!invalid.includes(f)).map(f=>({...f,quotes:exactQuotes(f,part)})),unverifiedFactCount:invalid.length};
}
async function repairFactQuotes(report,part,call){
 if(!valid(report)||report.ok!==true||!Array.isArray(report.facts))return report;
 const invalid=report.facts.map((fact,index)=>({index,...fact})).filter(f=>!f.fact||!exactQuotes(f,part));
 if(!invalid.length)return report;
 // Repair citations only; a completed semantic review is not repeated merely
 // because the reviewer joined quotations. Never change its verdict or facts.
 const repaired=await call(`review_evidence_${part.sceneId}`,`只修正已完成审核的逐字引文，不重新审稿，不写剧本，不改变事实或结论。下面 quote 有拼接或省略号，不能当作连续原句。每个 index 保持 fact 逐字不变，从本场原文摘录能共同支持该事实的 quotes 数组。单条引文必须连续且逐字一致，不得拼接、省略、改标点；多条按它们在原文中出现的顺序排列。同一事实含多个动作或多句知情变化时允许分开引用，不能仅因无法用一段覆盖便判 unsupported。只有原文确实没有支撑该事实时返回 supported:false，不编造证据。返回 {items:[{index,fact,quotes:["原句1","原句2"],supported}]}，必须恰好覆盖每个待修 index。\n本场完整原文：${part.scriptText}\n待修证据：${JSON.stringify(invalid)}`,['items'],3500);
 if(!Array.isArray(repaired.items)||repaired.items.length!==invalid.length||new Set(repaired.items.map(x=>x.index)).size!==invalid.length)throw Object.assign(Error(`${part.sceneId} 引文修复未完整返回`),{code:'SCRIPT_REVIEW_EVIDENCE_INVALID'});
 const facts=report.facts.map(f=>({...f}));
 for(const row of repaired.items){const source=invalid.find(f=>f.index===row.index);
  if(!source||row.fact!==source.fact||row.supported!==true||!exactQuotes(row,part))throw Object.assign(Error(`${part.sceneId} 审核事实未能绑定真实原句，尚未批准`),{code:'SCRIPT_REVIEW_EVIDENCE_INVALID'});
  facts[row.index]={fact:row.fact,...(row.quote?{quote:row.quote}:{}),quotes:exactQuotes(row,part)};
 }
 return {...report,facts,evidenceRepair:{count:invalid.length,method:'verdict-preserving-exact-source-quotes'}};
}
function carryForwardUnchangedBodyReview(state,before,after,plan,product,reviewPolicy=''){
 const row=state.sceneReviews?.[before.sceneId];
 if(before.sceneId!==after.sceneId || before.scriptText!==after.scriptText || !row || row.report?.ok!==true || row.report.issues?.length || row.fingerprint!==sceneFingerprint(state,before,plan,product,reviewPolicy))return false;
 try{bindFacts(row.report,after);}catch{return false;}
 const fingerprint=sceneFingerprint(state,after,plan,product,reviewPolicy);if(fingerprint===row.fingerprint)return true;
 state.sceneReviews[after.sceneId]={...row,fingerprint,bodyReuse:{priorSourceFingerprint:row.fingerprint,reason:'Only the end-state summary changed; performed source and every verified quote are identical',summaryRequiresCausalReview:true}};
 return true;
}
async function audit({state,plan,topic,product,reviewPolicy='',call:generateReview,save,status=()=>{}}){
 state.sceneReviews ||= {};
 state.pendingSceneReviews ||= {};
 const call=(stage,...args)=>{
  args[0]=require('./commerce-editorial-contract').POLICY+'\n'+args[0];
  const part=state.parts.find(p=>stage===`review_scene_${p.sceneId}`);
  const cached=part&&state.pendingSceneReviews[part.sceneId];
  if(part)args[0]+=`\n只读前场完整表演及末态：${JSON.stringify(previousSource(state,part))}\n前场只用于核对继承的人物位置、已完成动作与持物状态，不是本轮重写目标。认定本场“漏掉拾取、入场、交接”等前，必须核对这个完整前场：前场已经发生的动作不得要求重演。本场事实引文仍只摘本场；已由前场确立且本场延续的状态无需伪造一次新接触。其他更早场未提供正文时，不得仅凭规划/摘要没有记载就断言原稿缺失，交给后续完整跨场审核确认。`;
  if(part&&cached&&cached.fingerprint===sceneFingerprint(state,part,plan,product,reviewPolicy))return Promise.resolve(cached.report);
  if(part)return require('./scene-review-recovery').review({state,part,fingerprint:sceneFingerprint(state,part,plan,product,reviewPolicy),prompt:args[0],keys:args[1],maxTokens:args[2],call:generateReview,save});
  return generateReview(stage,...args);
 };
 const pending=state.parts.filter(part=>state.sceneReviews[part.sceneId]?.fingerprint!==sceneFingerprint(state,part,plan,product,reviewPolicy));
 // Independent read-only scene reviews can run together; authorship and repairs
 // remain chronological. allSettled preserves other completed reviews on failure.
 for(let start=0;start<pending.length;start+=5){
  const results=await Promise.allSettled(pending.slice(start,start+5).map(async part=>{
   status(`审核 Agent 正在核对完整场次 ${part.sceneId}，不重复审核已通过正文`);
   const report=await call(`review_scene_${part.sceneId}`,`只审核当前场完整正文，不生成提示词、不改写，不重复剧情全文。只读统一规划：${JSON.stringify(plan)}\n用户商品事实：${JSON.stringify(product)}\n当前场：${JSON.stringify(part)}\n返回 {ok,issues:[{sceneId,targetSceneIds,message,repair}],checks:[{dimension,evidence}],facts:[{fact,quotes:[\"逐字连续原句1\",\"逐字连续原句2\"]}]}。检查本场每句对白的说话人、听者、情绪语速及完整性，动作准备/接触/结果、物件持有人、出入场、音效来源、商品价格活动购买入口与原包装。第一场还要核对前30秒能听懂人物关系、事件、冲突和代价，末场核对可见结局。无商品的场次只核对未提前编造商品效果，不强塞广告；食品不承担救治或无依据医生背书。facts 提取本场实际建立的关系、知情变化、伏笔、证据、物件交接和兑现，quotes 每一项必须逐字摘录本场连续原句，复合事实使用按原文先后排序的多条引文，不拼接、不省略、不改标点，不能仅依据规划猜测已表演。音效括注表示与已命名动作同步，不因排在动作段后就判定延迟；只有明确时刻、次序或触发源冲突才提出问题，不为批注位置捏造额外动作。每条检查给短原句证据，每条问题指出定位和具体改法。facts 事实应简洁，每条独立引文不超过120字，多句事实使用多条引文；不要长篇论述，无证据不能通过。`,['ok','issues','checks','facts'],6000);
   state.pendingSceneReviews[part.sceneId]={fingerprint:sceneFingerprint(state,part,plan,product,reviewPolicy),report};save(state);
   const evidenced=await repairFactQuotes(report,part,call);
   state.sceneReviews[part.sceneId]={fingerprint:sceneFingerprint(state,part,plan,product,reviewPolicy),report:bindFacts(evidenced,part)};delete state.pendingSceneReviews[part.sceneId];save(state);
  }));
  const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
 }
 const reviewed=state.parts.map(part=>({sceneId:part.sceneId,report:state.sceneReviews[part.sceneId].report}));
 const sceneIssues=reviewed.flatMap(r=>r.report.issues.map(issue=>({sceneId:r.sceneId,...issue})));
 const checks=reviewed.flatMap(r=>r.report.checks.map(c=>({...c,sceneId:r.sceneId})));
 if(sceneIssues.length||reviewed.some(r=>!r.report.ok))return {ok:false,issues:sceneIssues.length?sceneIssues:[{message:'场次审核返回未通过但缺少问题定位，须补全审核证据'}],checks,method:VERSION};
 status('所有场次正文已审核，正在核对跨场因果、伏笔回收与商品植入闭环');
 // A summary can establish a quoted positive fact, never the absence of an
 // action it omitted. Causal approval therefore reads every performed scene,
 // not only fact excerpts. Complete scene reviews above remain checkpointed.
 const boundary=reviewed.map((r,i)=>({sceneId:r.sceneId,location:state.plan.scenes[i]?.location,scriptText:state.parts[i].scriptText,endState:state.parts[i].endState}));
 const fingerprint=hash({VERSION,CAUSAL_VERSION,reviewPolicy,topic,plan,product,boundary});
 if(state.causalReview?.fingerprint!==fingerprint){
  const report=await call('review_causal_boundaries',`逐场完整正文已另行审核。下面仍提供每场完整表演正文而不是省略动作的事实摘要；你只审跨场因果，不重复局部审美或抄写全文。缺失结论必须在完整正文中回查：摘要没摘出的动作不等于正文没写。不要重复添加已经发生的拾取、入场或持物交接；末态摘要若与正文不符，指出应修正摘要而不是重复表演。选题：${JSON.stringify(topic)}\n统一规划：${JSON.stringify(plan)}\n商品原始事实：${JSON.stringify(product)}\n按时序的完整正文及待核对末态：${JSON.stringify(boundary)}\n返回 {ok,issues:[{sceneId,targetSceneIds,message,repair}],checks:[{dimension,evidence}]}。核对开头交代、冲突升级、合理知情、关系与年代、反转伏笔和兑现、持物与入场连续、商品自然承接且价格活动购买入口齐全、结局行动。以原句证据而不是规划承诺为准；依赖前场补铺垫的问题同时列出前后场 targetSceneIds。不得把有篇幅的书写或未表演场外行为认定为已在镜头内完成。每条证据简洁地引用场次和关键短句，每条最多150字，不输出长篇论述。`,['ok','issues','checks'],6500);
  if(!valid(report))throw Object.assign(Error('跨场审核未返回完整证据'),{code:'SCRIPT_REVIEW_EVIDENCE_INVALID'});
  state.causalReview={fingerprint,report};save(state);
 }
 return {...state.causalReview.report,checks:[...checks,...state.causalReview.report.checks],method:VERSION};
}
module.exports={VERSION,CAUSAL_VERSION,REVIEW_REVISION,audit,bindFacts,repairFactQuotes,exactQuotes,hash,carryForwardUnchangedBodyReview};
