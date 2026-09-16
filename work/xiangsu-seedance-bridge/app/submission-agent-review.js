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
 const referencesCurrent=workflow.promptReviewReferenceManifestMatches(shot,references||{});
 // Submission cannot silently author a replacement after user confirmation.
 if(project.promptReview?.status!=='approved'||reviewed?.status!=='confirmed'||!sourceCurrent||!settingsCurrent||!referencesCurrent||transportText(reviewed?.prompt)!==transportText(original)||!approved(reviewed?.agentAudit,reviewed?.prompt)){
  const key=digest({policy:require('./unified-audit-policy').VERSION,shotId:shot.id,prompt:original});
  await save?.(key,{shotId:shot.id,status:'awaiting_prompt_review',prompt:original,reviewedPrompt:reviewed?.prompt||'',sourceCurrent,settingsCurrent,referencesCurrent,reason:'Current displayed confirmed prompt and review required; no replacement generated.',checkedAt:new Date().toISOString()});
  throw Object.assign(Error('提示词或引用已变化，请确认当前已审核版本；已保留完成内容，尚未提交生视频'),{code:'PROMPT_CONFIRMATION_REQUIRED',expectedControl:true,recoverable:true,stage:'prompt_review',shotId:shot.id});
 }
 return original;
}
module.exports={prepare,approved,digest};
