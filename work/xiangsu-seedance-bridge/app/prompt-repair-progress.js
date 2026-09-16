'use strict';
// A round number, timestamp or a fresh task ID is not new creative evidence.
function reserve(project, items, execution) {
 const input={policy:require('./unified-audit-policy').VERSION,execution,source:project.script?.raw,items:items.filter(i=>i.agentAudit?.issues?.length).map(i=>({id:i.id,prompt:i.prompt,displayPrompt:i.displayPrompt,issues:i.agentAudit.issues,challenge:i.agentAudit.authorChallenge}))};
 if(!input.items.length)return;
 const key=require('./foundry/canonical').fingerprint(input);
 const journal=project.promptRepairProgress||(project.promptRepairProgress={attempted:{}});
 const previous=journal.attempted[key];
 const resumable=previous&&(!previous.status||previous.status==='interrupted'||previous.status==='in_progress'&&previous.ownerPid!==process.pid);
 if(previous&&!resumable)throw require('./audit-progress').pending('prompt-repair',{fingerprint:key,reason:previous.status==='in_progress'?'This exact repair is already active in this process; do not dispatch a duplicate.':'The same source, prompts and findings completed repair without an effective change. Preserve the diagnosis and completed results; obtain new evidence before another paid attempt.'});
 journal.attempted[key]={...previous,startedAt:previous?.startedAt||new Date().toISOString(),itemIds:input.items.map(i=>i.id),status:'in_progress',ownerPid:process.pid,...(previous?{resumedAt:new Date().toISOString(),resumeCount:(previous.resumeCount||0)+1,...(!previous.status?{legacyResume:true}:{})}:{})};
 return key;
}
function settle(project,key,error){
 const row=project.promptRepairProgress?.attempted?.[key];if(!row)return;
 const interrupted=error&&(error.expectedControl||/PROVIDER_REQUEST_ABORTED|CANCEL|NETWORK|TIMEOUT|TIMEDOUT|ECONN|ENET|EAI_AGAIN|QUOTA|BALANCE|PAYMENT|AUTH|LOGIN|RATE_LIMIT|CONCURRENCY/.test(String(error.code||'')));
 row.status=error?(interrupted?'interrupted':'failed'):'completed';row.finishedAt=new Date().toISOString();
 if(error)row.lastError={code:error.code||'',message:String(error.message||'')};
}
module.exports={reserve,settle};
