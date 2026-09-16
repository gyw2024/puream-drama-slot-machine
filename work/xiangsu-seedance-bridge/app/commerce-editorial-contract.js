'use strict';
// Shared author/reviewer policy. Total runtime is derived; commerce share is a
// separate editorial objective, never a fixed total duration or visibility count.
const authoring=require('./commerce-authoring-policy');
const {DEFAULT_TARGET}=require('./commerce-target-policy');
const VERSION = 'commerce-editorial-20260915-v7-unified';
const POLICY = `COMMERCE EDITORIAL CONTRACT (${VERSION}). For commerce-enabled AI writing, use the reviewed reference-screenplay lower-bound target (${(DEFAULT_TARGET*100).toFixed(1)}%) unless the user explicitly specifies another target. This is a dialogue-only estimate from supplied reference scripts, not a verified source-video measurement. Longer reference advertisements do not impose a higher target on every story. Derive total runtime from complete dialogue and necessary actions; do not impose a film runtime or pad either side of the ratio. Count source-evidenced intervals that explain a real feature, demonstrate a verified characteristic, resolve a product-specific selection question, explain the real offer, or complete the motivated purchase decision. A visible jar, productMention flag, reference image, generic gratitude, silent handling or unrelated recognition is NOT effective commerce time. Use interval union, never double-count overlapping speech and actions. Before asset generation, provide total seconds, effective seconds, ratio and exact supporting source ranges; metadata alone is not evidence.
Establish the concrete character need before recommending or pricing the product. Selection may use explicit user features, name-supported characteristics or authorized ordinary category-use inference. Do not require unique patented superiority or an irreplaceable brand when a normal category fits the story. Explain the selected angle through complete character dialogue and a grounded visible action; a bare slogan is insufficient. Empty selling points never block writing: infer ordinary use and selection relevance from the name within the shared product policy. Never infer precise ingredients, dosage, certification, medical efficacy or prices. Prices/offers/CTA remain exact when supplied; absent prices need no fabricated offer. A viewer CTA follows the in-story decision and uses the same character and location. ${authoring.SYSTEM_PROMPT}\n${authoring.PRODUCT_POLICY}\n${authoring.VISUAL_POLICY}\n${authoring.FIRST_PASS_POLICY}
Plan meaningful physical locations and transitions alongside causal events before scene writing. Different camera angles or two names for one corridor are not additional locations. Do not confine a new story to one unchanged room by accident; use location changes when the dramatic event needs them. Respect an explicitly user-required single-location or verbatim uploaded script and report conflicts rather than silently rewriting it. Each location beat changes an objective, obstacle, knowledge or relationship; avoid moving merely to inflate a count.
Plan motivated coverage of action, evidence, product detail and listener reaction. Preserve axis and identities across cuts; continuity does not mean a blanket no-cuts rule. Choose only motivated camera/performance beats; no fixed count or compulsory cut applies. Preserve complete speech and necessary continuous contact. Review whole-film rhythm separately from each five-shot prompt batch. A stage may verify only its own evidence; a format pass or model praise is not commerce, story or media approval.`;
function unionSeconds(intervals, duration) {
  const rows = intervals.map(({start,end}) => [Number(start),Number(end)]);
  if (!Number.isFinite(duration) || duration <= 0 || rows.some(([a,b]) => !Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>duration)) throw new Error('Invalid editorial timing evidence');
  rows.sort((a,b)=>a[0]-b[0]); let total=0, end=0;
  for (const [a,b] of rows) { total+=Math.max(0,b-Math.max(a,end)); end=Math.max(end,b); }
  return total;
}
function measureCommerce({duration,intervals=[],targetRatio=DEFAULT_TARGET}) {
  if (!Number.isFinite(targetRatio)||targetRatio<0||targetRatio>1) throw new Error('Invalid commerce target');
  const allowed=new Set(['feature_explanation','verified_demonstration','selection_question','offer','purchase_decision']);
  const effective=intervals.filter(x=>allowed.has(x.purpose)&&typeof x.sourceQuote==='string'&&x.sourceQuote.trim()&&x.sourceVerified===true);
  const effectiveSeconds=unionSeconds(effective,duration);
  return {version:VERSION,duration,effectiveSeconds,ratio:effectiveSeconds/duration,targetRatio,shortfallSeconds:Math.max(0,duration*targetRatio-effectiveSeconds),evidenceCount:effective.length,semanticApproval:false};
}
const crypto=require('node:crypto');
const clean=value=>String(value??'').trim();
const enabled=mode=>!!mode&&!['none','off','disabled'].includes(mode);
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DIMENSIONS=['need_before_introduction','specific_product_selection','feature_explanation','motivated_offer_cta','location_progression','motivated_camera_coverage'];
const REVIEW_SCHEMA=`Return {ok,issues:[{sceneId,targetSceneIds,message,repair}],checks:[{dimension,evidence}],editorial:{checks:[{dimension,ok,explanation,evidence:[{unitId,quote}]}],anchors:{need:{unitId,quote},selection:{unitId,quote},introduction:{unitId,quote},ctaTransition:{unitId,quote},cta:{unitId,quote}},featureEvidence:[{unitId,quote,fact}],intervals:[{unitId,start,end,purpose,quote}]}}. Each editorial check must cover exactly one of ${DIMENSIONS.join(', ')} with actual exact source quotations, not outline promises. Quote the source verbatim, not its ID or a summary. The concrete need precedes introduction. Explain category-appropriate selection before the CTA; it may occur during or after naming the product in the same causal scene, as in natural conversation. A motivated purchase/offer transition precedes CTA. Care, gifts and gratitude can motivate selection when the character need and product relevance are established; judge their actual source context. featureEvidence.fact identifies the supported fact or ordinary-use inference; paraphrases and combined source evidence are valid. Judge actual meaning and relevance, not exact catalog wording. acceptedFacts includes authorized name/category-use inferences as well as user facts; missing user selling points alone is not an error. Reject unsupported precise attributes, prices or medical claims, not ordinary inferred use. At the unsplit screenplay stage leave intervals empty: total and commerce time are NOT yet verified. For timed shots, supply source-grounded effective intervals in local seconds, bounded by that shot's duration and actual dialogue/action windows, excluding background visibility, generic gratitude and unrelated action. Allowed purposes: feature_explanation, verified_demonstration, selection_question, offer, purchase_decision. Do not claim a whole shot for one short sentence. A single-location source is not inherently invalid: explain actual changes in scene objectives and coverage, and preserve an explicit user restriction. Return incomplete evidence as an issue, never invent quotes to pass.`;
function sourceUnits(parts=[]){return parts.map(p=>({id:clean(p.sceneId||p.id),text:clean(p.scriptText||p.text),duration:null}));}
function projectUnits(project={}){
 const director=require('./agent-production-decisions');
 return (project.shots||[]).map(s=>{
  // A current validated master owns execution time. Subshot/ledger timing is an
  // older planning projection and must never override the accepted performance.
  const master=director.current(project,s)?s.agentProductionDecision.item:null;
  const actions=master?master.events.map(e=>({text:e.descriptionZh,start:e.start,end:e.end})):(s.subshots||[]).map(t=>({text:t.action,start:t.start,end:t.end}));
  const turns=(s.dialogueTurns||[]).map((t,i)=>{const id=t.sourceDialogueId||t.id||`D${String(i+1).padStart(2,'0')}`,d=master?.dialogue.find(d=>d.id===id);return {text:t.text||t.spokenText,start:d?d.start:t.start??t.startSeconds??t.startSecond??t.metadata?.startSecond,end:d?d.end:t.end??t.endSeconds??t.endSecond??t.metadata?.endSecond};});
  return {id:clean(s.id),duration:Number(master?.duration??s.duration),text:[s.action,s.visualBeat,...actions.map(a=>a.text),...turns.map(t=>t.text),!turns.length?s.dialogue:''].filter(Boolean).join('\n'),sceneId:s.sceneId,actions,turns};
 });
}
function productFacts(product={}){return Object.fromEntries(['name','description','sellingPoints','price','offer','purchaseInstructions','commerceProfile'].map(k=>[k,product[k]??'']));}
function factCatalog(product={}){return authoring.acceptedFacts(product);}
function timingReady(units=[]){return units.length>0&&units.every(u=>Number.isFinite(u.duration)&&u.duration>0&&(u.turns||[]).length>0&&u.turns.every(t=>Number.isFinite(t.start)&&Number.isFinite(t.end)&&t.start>=0&&t.end>t.start&&t.end<=u.duration+.01));}
function fingerprint(units,product,mode,targetRatio=DEFAULT_TARGET){return digest({version:VERSION,policy:POLICY,schema:REVIEW_SCHEMA,units,product:productFacts(product),mode,targetRatio});}
function sourceRepairFeedback(project){
 const receipt=project.script?.editorialReview,state=project.script?.adaptiveAuthoring,parts=state?.parts||[];
 if(project.script?.authoredWithoutDurationTarget!==true||!parts.length||!receipt?.rawReport||receipt.ok!==false||!receipt.inputFingerprint)return null;
 const assets=[...(project.candidates||[]),...Object.values(project.assets||{})];
 if(assets.some(a=>a.filePath||a.localPath||a.status==='completed')||project.finalVideoPath||(project.videoJobs||[]).some(j=>j.taskId||j.upstreamTaskId))return null;
 const progress=project.script?.editorialRepairProgress;
 if(progress?.sourceSignature===state.signature&&progress.inputFingerprint===receipt.inputFingerprint)return null;
 const evidence=[...Object.values(receipt.rawReport.editorial?.anchors||{}),...(receipt.rawReport.editorial?.featureEvidence||[])];
 const owners=new Set(evidence.flatMap(e=>{const matches=parts.filter(p=>e?.quote&&p.scriptText.includes(e.quote));return matches.length===1?[matches[0].sceneId]:[];}));
 if(!owners.size)return null;
 const selected=parts.filter(p=>owners.has(p.sceneId));
 return {status:'pending',kind:'commerce_editorial',sourceHashes:Object.fromEntries(selected.map(p=>[p.sceneId,crypto.createHash('sha256').update(p.scriptText).digest('hex')])),
  issues:selected.map(p=>({sceneId:p.sceneId,targetSceneIds:[p.sceneId],message:'真实拆镜后的带货编辑审核未通过：'+receipt.issues.map(i=>i.message).join('；'),repair:'只修改本场已确认的选品引出、特色解释与购买转接。保留人物、场景、剧情推进、商品事实、原价格活动CTA。基于已知特色补充有信息的对话和可见展示；不可重复口号、发呆、拉慢语速、删除剧情来凑比例，也不可把包装露出当介绍。事实不足须明确报告，不编造功效、口感、配方或用法。返回完整原句定位的最小替换，然后重新拆镜和核算完整分母，不预先声称目标比例已通过。'})),at:new Date().toISOString()};
}
function timedEvidence(units,rows,targetRatio=DEFAULT_TARGET){
 const issues=[];const fail=(message,id)=>issues.push({sceneId:id,targetSceneIds:id?[id]:[],message,repair:'补齐当前原句和实际时间窗证据，再由 Agent 定位必要修订。'});
 const locate=a=>units.some(u=>u.id===a?.unitId&&clean(a.quote)&&u.text.includes(clean(a.quote)));
 const offsets=new Map();let duration=0;for(const u of units){offsets.set(u.id,duration);duration+=u.duration;}
  const intervals=[];
  for(const row of rows){const u=units.find(x=>x.id===row.unitId);if(!locate(row)||!u||!Number.isFinite(row.start)||!Number.isFinite(row.end)||row.start<0||row.end<=row.start||row.end>u.duration){fail('有效带货时段无当前正文依据或越过分镜时长',row.unitId);continue;}
   const matching=(u.turns||[]).filter(t=>clean(t.text).includes(clean(row.quote)));
   const turn=matching.find(t=>Number.isFinite(t.start)&&Number.isFinite(t.end)&&row.start>=t.start-0.001&&row.end<=t.end+0.001);
   if(matching.length&&!turn){fail('带货对白计时超过这句台词的实际编排窗口，或窗口缺失',u.id);continue;}
   // A mixed line can contain a shorter effective interval selected by the Agent.
   if(!matching.length && !(u.actions||[]).some(t=>clean(t.text).includes(clean(row.quote))&&Number.isFinite(t.start)&&Number.isFinite(t.end)&&row.start>=t.start&&row.end<=t.end)){
    fail('动作计时缺少同一完整动作的明确起止窗口，不能按整镜估算',u.id);continue;
   }
   intervals.push({...row,start:offsets.get(u.id)+row.start,end:offsets.get(u.id)+row.end,sourceQuote:row.quote,sourceVerified:true});
  }
  const timing=measureCommerce({duration,intervals,targetRatio});
 return {timing,issues};
}
function evaluate({units=[],product={},mode='explicit',report={},targetRatio=DEFAULT_TARGET}){
 const inputFingerprint=fingerprint(units,product,mode,targetRatio);
 if(!enabled(mode))return {ok:true,status:'not_applicable',inputFingerprint,issues:[],semanticApproval:false};
 const issues=[];const targets=units.map(u=>u.id);
 const fail=(message,id)=>issues.push({sceneId:id||targets[0],targetSceneIds:id?[id]:targets,message,repair:'按共享带货编辑合同补充或修正真实正文证据；保留用户原稿、产品事实与已完成项目，不把无证据的好评当通过。'});
 const locate=a=>{const i=units.findIndex(u=>u.id===a?.unitId);const quote=clean(a?.quote);if(i<0||!quote||!units[i].text.includes(quote))return null;return {i,at:units[i].text.indexOf(quote),quote};};
 if(!units.length||units.some(u=>!u.id||!u.text)||new Set(targets).size!==units.length)fail('源头编辑审核缺少唯一、完整的正文单元');
 const e=report.editorial;
 if(!e||!Array.isArray(e.checks)){fail('带货编辑审核没有返回逐项原句证据，不能依据笼统好评批准');return {ok:false,status:'needs_review',inputFingerprint,issues,semanticApproval:false};}
 for(const dimension of DIMENSIONS){const rows=e.checks.filter(c=>c.dimension===dimension),r=rows[0];
  if(rows.length!==1||r?.ok!==true||!clean(r.explanation)||!Array.isArray(r.evidence)||!r.evidence.length||r.evidence.some(a=>!locate(a)))fail(`带货/场景编辑检查 ${dimension} 未通过或引文不属于当前正文`);
 }
 const resolvedCtaTransition=e.anchors?.ctaTransition||null;
 // The Agent evaluates motive, ordering, feature relevance and combined lines.
 // Code checks that supplied evidence belongs to this source, not its wording.
 for(const row of e.featureEvidence||[])if(!locate(row)||!clean(row.fact))fail('特色审核证据未绑定当前正文',row.unitId);
 let timing=null;
 const timed=units.length>0&&units.every(u=>Number.isFinite(u.duration)&&u.duration>0);
 if(!timed&&units.some(u=>u.duration!==null))fail('已拆镜时长缺失或无效，不能降级成未拆稿并跳过带货核算');
 if(timed){const offsets=new Map();let duration=0;for(const u of units){offsets.set(u.id,duration);duration+=u.duration;}
  const measured=timedEvidence(units,e.intervals||[],targetRatio);issues.push(...measured.issues);timing=measured.timing;
  if(timing.shortfallSeconds>0.001)fail(`有效带货 ${timing.effectiveSeconds.toFixed(2)} 秒 / 全片 ${duration.toFixed(2)} 秒，仅 ${(timing.ratio*100).toFixed(2)}%；距目标 ${(targetRatio*100).toFixed(1)}% 仍缺 ${timing.shortfallSeconds.toFixed(2)} 秒。背景摆放不计入。`);
 }
 const prior=Array.isArray(report.issues)?report.issues:[];
 if(report.ok!==true||prior.length)issues.push(...(prior.length?prior:[{sceneId:targets[0],targetSceneIds:targets,message:'编辑审核未明确通过',repair:'补充具体缺项与真实原句'}]));
 return {ok:issues.length===0,status:issues.length?'needs_review':timed?'approved':'source_approved_timing_pending',inputFingerprint,issues,timing,semanticApproval:issues.length===0,editorial:e,resolvedCtaTransition,version:VERSION};
}
async function review({units,product,mode,targetRatio=DEFAULT_TARGET,generate,checkpoint,execution=null}){
 const key=fingerprint(units,product,mode,targetRatio),executionKey=digest(execution);
 const evidenceKey=digest({version:VERSION,schema:REVIEW_SCHEMA,units,product:productFacts(product),mode});
 const previousPolicy=POLICY.replace(/For commerce-enabled AI writing,[\s\S]*?Longer reference advertisements do not impose a higher target on every story\./,"For commerce-enabled AI writing, default to 20% effective commerce performance unless the user explicitly specifies another target.");
 const oldKey=digest({version:VERSION,policy:previousPolicy,schema:REVIEW_SCHEMA,units,product:productFacts(product),mode,targetRatio:checkpoint?.timing?.targetRatio??0.2});
 if(!enabled(mode))return evaluate({units,product,mode});
 if(checkpoint?.executionKey===executionKey&&checkpoint.rawReport&&(checkpoint.inputFingerprint===key||checkpoint.evidenceKey===evidenceKey||checkpoint.inputFingerprint===oldKey))return {...evaluate({units,product,mode,targetRatio,report:bindEvidenceClock(units,checkpoint.rawReport)}),rawReport:checkpoint.rawReport,executionKey,evidenceKey,reused:true};
 if(units.some(u=>u.duration!==null)&&!timingReady(units))return {ok:false,status:'timing_pending',inputFingerprint:key,executionKey,issues:[{message:'具体对白时间窗尚未完成，保留源稿，先完成表演编排后再核算。'}],timing:null,semanticApproval:false,version:VERSION};
 const rawReport=await generate([{role:'system',content:POLICY+'\n'+require('./unified-audit-policy').INSTRUCTION+'\n'+REVIEW_SCHEMA+'\nFor TIMED intervals use {eventId,purpose,start,end} inside the supplied event window. Select only the actual effective portion of a mixed event; background visibility and unrelated words do not count. The event ID binds immutable text and outer bounds; you author the effective subinterval. Choose only events whose actual content meets the listed commerce purposes. A product being named or seen before a need is revealed is not itself a recommendation; introduction means the motivated recommendation or feature explanation, not the first product noun. For featureEvidence.fact identify a supported fact or ordinary-use inference; audit actual meaning rather than exact catalog wording. Be concise: one exact evidence per successful dimension, detailed findings only for failures.'},{role:'user',content:JSON.stringify({units,timedSourceEvents:timedSourceEvents(units),product,acceptedFacts:factCatalog(product),commerceMode:mode,targetRatio,timingAvailable:timingReady(units)})}]);
 return {...evaluate({units,product,mode,targetRatio,report:bindEvidenceClock(units,rawReport)}),rawReport,executionKey,evidenceKey,reviewedAt:new Date().toISOString()};
}
function timedSourceEvents(units){return units.flatMap(u=>['turns','actions'].flatMap(kind=>(u[kind]||[]).map((row,index)=>({eventId:`${u.id}:${kind}:${index}`,unitId:u.id,quote:clean(row.text),start:row.start,end:row.end,kind})).filter(row=>row.quote&&Number.isFinite(row.start)&&Number.isFinite(row.end)&&row.start>=0&&row.end>row.start&&row.end<=u.duration)));}
function bindEvidenceClock(units,report){
 if(!report?.editorial?.intervals)return report;
  return {...report,editorial:{...report.editorial,intervals:report.editorial.intervals.map(row=>{
  if(row.eventId){const event=timedSourceEvents(units).find(e=>e.eventId===row.eventId);if(event)return {...row,...event,start:Number.isFinite(row.start)?row.start:event.start,end:Number.isFinite(row.end)?row.end:event.end,clockSource:'agent-effective-interval-within-source-event'};return row;}
  const u=units.find(u=>u.id===row.unitId),matches=(u?.turns||[]).filter(t=>clean(t.text)===clean(row.quote));
  // The reviewer classifies an entire exact utterance; its runtime belongs
  // to the source ledger. Ambiguous/partial quotes still fail evaluation.
  if(matches.length!==1||!Number.isFinite(matches[0].start)||!Number.isFinite(matches[0].end))return row;
  return {...row,reportedStart:row.start,reportedEnd:row.end,start:Number.isFinite(row.start)?row.start:matches[0].start,end:Number.isFinite(row.end)?row.end:matches[0].end,clockSource:'agent-effective-interval-within-source-utterance'};
 })}};
}
module.exports={VERSION,POLICY,REVIEW_SCHEMA,DIMENSIONS,unionSeconds,measureCommerce,enabled,sourceUnits,projectUnits,productFacts,factCatalog,timingReady,sourceRepairFeedback,fingerprint,evaluate,review};
module.exports.bindEvidenceClock=bindEvidenceClock;
module.exports.timedSourceEvents=timedSourceEvents;

module.exports.timedEvidence=timedEvidence;
