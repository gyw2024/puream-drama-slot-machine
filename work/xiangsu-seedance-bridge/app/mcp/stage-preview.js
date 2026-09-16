'use strict';
function preview(request,input){
 // Preview and commit must accept the same envelope before rendering. Otherwise
 // missing fields become generic formatter exceptions (or literal undefined).
 if(request.json&&request.responseSchema){
  const findings=require('../agent-output-normalization').inspect(input?.data,request.responseSchema);
  if(findings.length)return {ok:false,status:'needs_revision',findings,instruction:'Correct these exact data fields in this same task, preserving all other authored content.'};
 }
 const context=request.deliveryPreview;
 if(context?.kind==='screenplay-writing')return {ok:true,status:'ready',constructionFacts:require('../authoring-workspace').sourceFacts(input?.data),instruction:require('../authoring-workspace').DATA_INSTRUCTION};
 if(['screenplay-repair','screenplay-repair-fields'].includes(context?.kind)){
  try{const delivery=require('../screenplay-repair-delivery'),patch=context.kind==='screenplay-repair-fields'?delivery.correct(context.basePatch,input?.data):input?.data,result=delivery.assemble(context,patch);return {ok:result.ok,status:result.ok?'ready':'needs_revision',findings:result.findings,...(result.ok?{constructionFacts:require('../authoring-workspace').sourceFacts(result.candidate,[...patch.shots.map(s=>s.id),...(patch.additions||[]).map(a=>a.shot.id)])}:{}),instruction:'Correct only these exact IDs or reference fields in the same saved result. Preserve all other authored text. Construction measurements are available to you before this draft is committed; they are not semantic approval.'};}
  catch(e){return {ok:false,status:'needs_revision',findings:e.findings||[{path:'$',reason:e.message}],instruction:'Correct the addressed fields in this same task; preserve saved content.'};}
 }
 if(context?.kind==='master-production-patch'){
  try{const data=require('../agent-decision-patch').apply(context.baseItems,input?.data,context.decisionSchema);return preview({...request,responseSchema:context.decisionSchema,deliveryPreview:{...context,kind:'master-production-decision'}},{data});}
  catch(e){return {ok:false,status:'needs_revision',issues:e.issues||[e.message],instruction:'Correct only the submitted patch fields; all unmodified base fields are preserved.'};}
 }
 if(context?.kind!=='master-production-decision')return {ok:true,status:'not_required',items:[]};
 const project=structuredClone(context.project),rows=structuredClone(input?.data?.items);
 if(!Array.isArray(rows)||!rows.length)return {ok:false,status:'needs_revision',issues:['Submit nonempty data.items for preview']};
 const results=rows.map(item=>{const shot=project.shots.find(s=>s.id===item.shotId);if(!shot)return {ok:false,shotId:item.shotId,issues:['Unknown shot ID']};try{require('../agent-production-decisions').apply(project,shot,item);return {shotId:shot.id,...require('../production-delivery-contract').inspect(project,shot,{includePrompt:true}),reviewSuggestions:shot.agentProductionDecision.item.programReviewSuggestions||[]};}catch(e){return {ok:false,shotId:shot.id,issues:e.issues||e.failures||[e.message]};}});
 return {ok:results.every(r=>r.ok),status:results.every(r=>r.ok)?'ready':'needs_revision',items:results,performanceFacts:require('../authoring-workspace').performanceFacts(project,rows.map(r=>r.shotId)),instruction:'This is your exact final request after reference binding, with capacity and authored speech-clock measurements. Use the neutral performanceFacts while constructing this same draft, before handing it downstream. Preserve source dialogue, actions and identities; plan compatible source actions and complete speech across the actual neighboring clocks. These arithmetic observations are not a content verdict. Do not restart the script.'};
}
module.exports={preview};
