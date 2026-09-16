'use strict';
const hash=require('./foundry/canonical').fingerprint;
function pending(stage,details){return Object.assign(Error('Agent正在等待必要证据，已保留完成结果；不会重复提交相同请求'),{code:'AGENT_EVIDENCE_PENDING',recoverable:true,expectedControl:true,stage,details});}
// No wall-clock cap. A repeated unchanged request receives one explicit Agent
// diagnosis rather than blindly starting another identical author/reviewer.
async function request({journal={},stage,messages,schema,generate,save=()=>{}}){
 const key=hash({policy:require('./unified-audit-policy').VERSION,stage,messages,schema});
 const old=journal[stage];
 if(old?.key===key&&old.diagnosed)throw pending(stage,{inputFingerprint:key,reason:'unchanged request after evidence diagnosis'});
 const diagnosis=old?.key===key;
 const input=diagnosis?[...messages,{role:'user',content:'The same request already completed but its receipt could not advance the task. Diagnose and correct the actual evidence/receipt problem below. Preserve complete valid content and source facts; do not repeat an unchanged receipt, invent a pass, or rewrite unaffected scenes. Return the original requested schema. Previous receipt: '+JSON.stringify(old.result)}]:messages;
 const result=await generate(input,schema,{diagnosis});
 journal[stage]={key,result,diagnosed:diagnosis,at:new Date().toISOString()};save(journal);
 if(diagnosis&&hash(result)===hash(old.result))throw pending(stage,{inputFingerprint:key,reason:'diagnosis produced unchanged receipt'});
 return result;
}
module.exports={request,pending};
