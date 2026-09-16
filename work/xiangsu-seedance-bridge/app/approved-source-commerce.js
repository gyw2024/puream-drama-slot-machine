'use strict';
const crypto=require('node:crypto');
const VERSION='approved-source-timed-projection-v1';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function proof(project,mode,targetRatio){
 const ed=require('./commerce-editorial-contract'),state=project.script?.adaptiveAuthoring,receipt=state?.editorialReview;
 if(state?.status!=='ready'||state.text!==project.script.raw||receipt?.ok!==true||receipt.version!==ed.VERSION||!state.parts?.length)return null;
 const units=ed.sourceUnits(state.parts),inputFingerprint=ed.fingerprint(units,project.product,mode,targetRatio);
 if(receipt.inputFingerprint!==inputFingerprint)return null;
 const checked=ed.evaluate({units,product:project.product,mode,targetRatio,report:receipt.rawReport||state.audit});
 if(!checked.ok)return null;
 const whole=require('./whole-script-preparation');
 const turns=(project.shots||[]).flatMap(s=>(s.dialogueTurns||[]).map(t=>({...t,speakerName:project.characters?.find(c=>c.id===t.speakerId)?.name||t.speaker})));
 if(JSON.stringify(whole.dialogueSequence(whole.sourceLedger(project.script.raw)))!==JSON.stringify(whole.dialogueSequence(turns)))return null;
 return {inputFingerprint,sourceSha256:hash(project.script.raw),dialogueSequenceVerified:true,receipt:checked};
}
const PURPOSES=['none','feature_explanation','verified_demonstration','selection_question','offer','purchase_decision'];
function schema(){return {type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,required:['id','purpose','start','end','reason'],properties:{id:{type:'string',minLength:1},purpose:{type:'string',enum:PURPOSES},start:{type:'number'},end:{type:'number'},reason:{type:'string',minLength:1}}}}}};}
async function review({project,mode,targetRatio,execution,generate,checkpoint,sourceProof}){
 const ed=require('./commerce-editorial-contract'),units=ed.projectUnits(project);
 if(!sourceProof?.inputFingerprint)return ed.review({units,product:project.product,mode,targetRatio,execution,generate,checkpoint});
 const events=ed.timedSourceEvents(units),key=hash({version:ed.VERSION,policy:require('./unified-audit-policy').VERSION,units,product:ed.productFacts(project.product),mode,targetRatio,execution,sourceProof:sourceProof.inputFingerprint});
 if(checkpoint?.inputFingerprint===key&&checkpoint.rawReport)return {...finish(checkpoint.rawReport),reused:true};
 if(!ed.timingReady(units))return {ok:false,status:'needs_evidence',issues:[],unresolvedFindings:['待导演完成对白实际时间窗'],inputFingerprint:key,semanticApproval:false};
 const answer=await generate([{role:'system',content:ed.POLICY+'\n'+require('./unified-audit-policy').INSTRUCTION+'\nSource story/commerce semantics ALREADY passed the current independent source review. Only classify NEW actual timed events; do not re-open unchanged source semantics. Every supplied dialogue/action event gets one result ID. For mixed content select only the effective subinterval inside its event; background visibility and unrelated words are none. Include demonstrations in actions, not only dialogue. Overlap will be summed once. Return items with id,purpose,start,end,reason. Use source times for none; no invented action or speech.'},{role:'user',content:JSON.stringify({events:events.map(e=>({...e,id:e.eventId})),product:project.product,sourceApproval:sourceProof.inputFingerprint})}],{json:true,responseSchema:schema(),requiredKeys:['items'],agentStage:'review',costOperation:'commerce_timed_projection'});
 return finish(answer);
 function finish(answer){
  if(!Array.isArray(answer?.items)||answer.items.length!==events.length||new Set(answer.items.map(r=>r.id)).size!==events.length||answer.items.some(r=>!events.some(e=>e.eventId===r.id)||!PURPOSES.includes(r.purpose)||!Number.isFinite(r.start)||!Number.isFinite(r.end)||!String(r.reason||'').trim()))throw Object.assign(Error('带货计时证据待补全，已保留源稿审核'),{code:'EDITORIAL_CLASSIFICATION_INCOMPLETE',recoverable:true});
  const bound=ed.bindEvidenceClock(units,{editorial:{intervals:answer.items.filter(r=>r.purpose!=='none').map(r=>({...r,eventId:r.id}))}});
  const measured=ed.timedEvidence(units,bound.editorial.intervals,targetRatio),issues=measured.issues;
  if(measured.timing.shortfallSeconds>.001)issues.push({message:'实际有效带货时长低于已确认基线，需要 Agent 定位补充；不按包装露出计时。',targetSceneIds:[],repair:'依据已审核人物动机和商品事实定位最小补充，保留无关剧情。'});
  return {version:ed.VERSION,status:issues.length?'needs_review':'approved',ok:!issues.length,issues,timing:measured.timing,semanticApproval:false,sourceSemanticApproval:sourceProof.inputFingerprint,inputFingerprint:key,rawReport:answer};
 }
}
module.exports={VERSION,proof,schema,review};
