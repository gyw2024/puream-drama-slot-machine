'use strict';
const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:require('./foundry/canonical').canonicalJson(value)).digest('hex');
const transportText=value=>String(value||'').replace(/\r/g,'').trim();
const approved=(audit,prompt)=>audit&&audit.requirementsVersion===require('./production-content-requirements').VERSION&&require('./unified-audit-policy').receiptState(audit)==='passed'&&audit.promptSha256===digest(prompt);
async function prepare({project,shot,prompt,references,settings,save,signal}) {
 require('./agent-stage-tasks').throwIfCancelled(signal);
 const original=String(prompt||'');
 const reviewed=project.promptReview?.items?.find(i=>i.entityId===shot.id&&i.stage==='shot_video');
 const workflow=require('./workbench-workflow');
 const sourceCurrent=project.promptReview?.sourceFingerprint===workflow.promptReviewSourceFingerprint(project);
 const settingsCurrent=project.promptReview?.settingsFingerprint===workflow.promptReviewSettingsFingerprint(settings);
 const actualReferences=references||{};
 // Eligibility realignment (方案A follow-through): the confirmed plan may still
 // enumerate silent, asset-ineligible entrants that the corrected reference
 // assembly excludes. That shrinkage alone does not invalidate the approval —
 // the submitted manifest must win, and the execution prompt must be the
 // deterministic re-render from the same approved facts for that manifest.
 const referencesAligned=workflow.referenceManifestEligibilityAligned(project,shot,actualReferences);
 const referencesCurrent=workflow.promptReviewReferenceManifestMatches(shot,actualReferences)||referencesAligned;
 let promptRecompiledFromApprovedFacts=false;
 if(referencesAligned&&transportText(reviewed?.prompt)!==transportText(original)){
  try{
   promptRecompiledFromApprovedFacts=transportText(original)===transportText(workflow.renderApprovedVideoPrompt(project,shot,actualReferences));
  }catch{promptRecompiledFromApprovedFacts=false;}
 }
 // Submission cannot silently author a replacement after user confirmation.
 // Approval semantics must match the rest of the workflow: approvedPromptReviewItem
 // (bundle currency + user confirmation). Legacy bundles carry audits without
 // promptSha256 receipts; requiring the stricter receipt here permanently
 // bricked every pre-receipt project even when everything else was current.
 const userApprovedCurrent=(!!workflow.approvedPromptReviewItem(project,'shot',shot.id,'shot_video')
   && transportText(reviewed?.prompt)===transportText(workflow.approvedPromptReviewItem(project,'shot',shot.id,'shot_video')?.prompt||''))
   || approved(reviewed?.agentAudit,reviewed?.prompt);
 // When the manifest realigned, the ONLY acceptable execution text is the
 // deterministic re-render over the corrected manifest — the stored confirmed
 // text still binds <Picture N> to roles that no longer exist.
 const textAccepted=referencesAligned?promptRecompiledFromApprovedFacts:transportText(reviewed?.prompt)===transportText(original);
 if(project.promptReview?.status!=='approved'||reviewed?.status!=='confirmed'||!sourceCurrent||!settingsCurrent||!referencesCurrent||!textAccepted||!userApprovedCurrent){
  const key=digest({policy:require('./unified-audit-policy').VERSION,shotId:shot.id,prompt:original});
  await save?.(key,{shotId:shot.id,status:'awaiting_prompt_review',prompt:original,reviewedPrompt:reviewed?.prompt||'',sourceCurrent,settingsCurrent,referencesCurrent,referencesAligned,promptRecompiledFromApprovedFacts,reason:'Current displayed confirmed prompt and review required; no replacement generated.',checkedAt:new Date().toISOString()});
  throw Object.assign(Error('提示词或引用已变化，请确认当前已审核版本；已保留完成内容，尚未提交生视频'),{code:'PROMPT_CONFIRMATION_REQUIRED',expectedControl:true,recoverable:true,stage:'prompt_review',shotId:shot.id});
 }
 return original;
}
module.exports={prepare,approved,digest};
