'use strict';
// Software verifies receipt identity and completeness. The reviewing Agent
// alone decides whether the proposed creative defect exists in the source.
const VERSION='source-finding-verification-v2-independent-evidence';
const hash=require('./foundry/canonical').fingerprint;
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const evidence={type:'string',minLength:1};
const keys=['story','commerce','dialogue'];
const REPORTED_FACTS=`区分当前对白首次报告的画外背景事实与对已确立事实的错误回指。人物可以通过对白报告此前未逐场演出的案件、人数或经历；没有逐件拍出来不等于没有发生，不能只凭“此前只演了几件”要求改数字或增戏。仍要核对明确的总数、对象、知情来源及前后陈述：已经明确发生的动作不能改说尚未发生，不同物体不能混为一物，未转交的在场道具不能无故换手。新报告本身若与当前稿的明确事实冲突，必须列出双方原文；不能自行假设角色说谎来消除矛盾。`;
const INSTRUCTION=`你是源剧本问题复核Agent。输入包含当前完整稿、用户事实和初审提出的具体问题。任务不是重写或重新挑毛病，而是逐项独立确认这些问题是否真实成立。初审不是权威；创作稿也不能自证正确。每个finding ID只交付一次：upheld表示按当前实际原文和有效要求确有缺陷，dismissed表示指控不成立、所需内容已经存在、混淆事件阶段或客观算术错误。reason必须引用具体镜号和实际事实说明理由；不能因为方便推进就撤销问题。证据不足返回needs_evidence并说明具体缺少的事实；不能当作upheld，也不能当作通过。不要新增问题、替代台词、镜头或修改建议；保留的原问题会送回编剧Agent定向修订。
先独立还原当前稿的事实或可演方案，再检验初审指控，不要先接受指控后替它寻找理由。为避免受修订方案影响，输入不提供初审建议改成什么。时长指控尤其要检查反例：只要10–15秒内存在一套按正确语速说完所有原句、同步完成允许重叠的原动作、所有无人声间隔≤3秒的清晰方案，超载指控就不成立。在reason中给出该具体可行安排；若保留超载，必须证明最快允许说话与不可重叠的必要动作仍超上限。不能用区间较慢一端超过15秒来证明所有安排都不可能，不能把系围裙、别工牌等可在他人发言时完成的动作统统挤进剩余无声时间。不要为保留一个算错的指控临时发明原稿没有的额外时长。
conclusion是你对本次问题影响的明确结论，结合已完成初审的职责范围：有任何upheld则ok=false；全部dismissed才可在各项有证据时返回ok=true。storyComplete指是否确实覆盖完整故事，sourcePreserved指是否忠实保留原稿中必须保留的信息；原创无原稿时说明适用性。criteria分别回答story、commerce、dialogue。不能在否定结论时不给任何保留问题，也不能接受问题仍声明ok=true。未被初审质疑的检查结果保留其范围，不声称执行过媒体审核。`+'\n'+REPORTED_FACTS+'\n'+require('./screenplay-source-authority').INSTRUCTION+'\n'+require('./production-content-requirements').INSTRUCTION+'\n'+require('./agent-speech-authority').SOURCE_INSTRUCTION+'\n'+require('./product-claim-authority').INSTRUCTION;
function prepare(audit){return (audit.issues||[]).map((finding,index)=>({id:'F'+(index+1),finding}));}
function schema(findings){return object({decisions:object(Object.fromEntries(findings.map(f=>[f.id,object({verdict:{enum:['upheld','dismissed','needs_evidence']},reason:evidence})]))),conclusion:object({ok:{type:'boolean'},storyComplete:{type:'boolean'},sourcePreserved:{type:'boolean'},criteria:object(Object.fromEntries(keys.map(k=>[k,object({passed:{type:'boolean'},evidence})])))})});}
function validate(findings,answer){
 if(!require('./typed-output-receipt').conforms(answer,schema(findings)))return '按完整ID表交付每个原问题的verdict与原文reason，以及全部conclusion字段。不得遗漏或增加问题ID。';
 const upheld=findings.filter(f=>answer.decisions[f.id].verdict==='upheld'),pending=findings.filter(f=>answer.decisions[f.id].verdict==='needs_evidence'),c=answer.conclusion;
 if((upheld.length||pending.length)&&c.ok)return '仍有upheld的原问题，conclusion.ok不能为true。保留实质判断，修正矛盾的汇总结论。';
 if(!upheld.length&&!pending.length&&(!c.ok||!c.storyComplete||!c.sourcePreserved||keys.some(k=>!c.criteria[k].passed)))return '结论仍否定但全部问题已dismissed，无法定位修稿。核对原问题：实际缺陷应保留upheld；如指控均不成立，按具体证据明确对应结论，不能凭空另造问题。';
 return null;
}
function apply(audit,findings,answer,inputHash){
 const issue=validate(findings,answer);if(issue)throw Object.assign(Error(issue),{code:'SOURCE_FINDING_VERIFICATION_DELIVERY'});
 return {...audit,...answer.conclusion,issues:findings.filter(f=>answer.decisions[f.id].verdict==='upheld').map(f=>f.finding),unresolvedFindings:findings.filter(f=>answer.decisions[f.id].verdict==='needs_evidence').map(f=>({...f.finding,reason:answer.decisions[f.id].reason})),findingVerification:{version:VERSION,inputHash,completedAt:new Date().toISOString(),primaryConclusion:{ok:audit.ok,storyComplete:audit.storyComplete,sourcePreserved:audit.sourcePreserved,criteria:audit.criteria},findings,decisions:answer.decisions,conclusion:answer.conclusion}};
}
function task(input,audit){
 const findings=prepare(audit),primary={ok:audit.ok,storyComplete:audit.storyComplete,sourcePreserved:audit.sourcePreserved,criteria:audit.criteria};
 const packet={...input,primaryConclusion:primary,findings:findings.map(({id,finding})=>({id,finding:{shotIds:finding.shotIds,field:finding.field,evidence:finding.evidence}})),speechMeasurements:require('./agent-speech-authority').screenplayMeasurements(input.screenplay)};
 const messages=[{role:'system',content:INSTRUCTION},{role:'user',content:JSON.stringify(packet)}],responseSchema=schema(findings);
 return {findings,messages,schema:responseSchema,inputHash:hash({version:VERSION,messages,responseSchema})};
}
async function verify({input,audit,call,status=()=>{},signal}){
 if(!audit.issues?.length&&!audit.findingVerification)return audit;
 // Completed repairs must be accepted by their original scope before review.
 // This function only receives unapplied semantic findings from the caller.
 const previous=audit.findingVerification;
 const primaryAudit=previous?{...audit,...previous.primaryConclusion,issues:previous.findings.map(f=>f.finding)}:audit;
 const t=task(input,primaryAudit);
 if(previous?.version===VERSION&&previous.inputHash===t.inputHash)return audit;
 let deliveryIssue=null;const progress=new Set();
 for(;;){
  require('./agent-stage-tasks').throwIfCancelled(signal);
  status(`审核 Agent 正在对照源稿复核 ${t.findings.length} 项问题，确认真实缺陷后才定向修稿`);
  const messages=deliveryIssue?[...t.messages,{role:'user',content:'保留原文证据与判断，只补正本次回执：'+deliveryIssue}]:t.messages;
  const answer=await call('review_findings',messages,t.schema);
  deliveryIssue=validate(t.findings,answer);
  if(!deliveryIssue){
   const pending=t.findings.filter(f=>answer.decisions[f.id].verdict==='needs_evidence');
   if(!pending.length)return apply(primaryAudit,t.findings,answer,t.inputHash);
   const key=hash(pending.map(f=>f.id));
   if(progress.has(key))return apply(primaryAudit,t.findings,answer,t.inputHash);
   progress.add(key);deliveryIssue='请依据已提供的完整源稿与用户要求补足这些问题的事实分析，不重写、不凭不确定保留缺陷。确实需用户新事实才能判断时仍标needs_evidence：'+JSON.stringify(pending.map(f=>({id:f.id,missing:answer.decisions[f.id].reason})));
  }else {const key=hash({deliveryIssue,answer});if(progress.has(key))throw Object.assign(Error('审核回执补全暂无进展，原结果已保留'),{code:'AGENT_EVIDENCE_PENDING',recoverable:true});progress.add(key);}
 }
}
module.exports={VERSION,REPORTED_FACTS,INSTRUCTION,prepare,schema,validate,apply,task,verify};
