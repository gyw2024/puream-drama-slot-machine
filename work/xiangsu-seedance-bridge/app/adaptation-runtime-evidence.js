'use strict';
const hash=require('./foundry/canonical').fingerprint;
async function resolve({source,contract,execution,checkpoint,generate,save=()=>{},signal}){
 if(contract?.kind!=='adaptation'||contract.basis==='source-explicit-timeline')return contract;
 const key=hash({source,execution,policy:require('./unified-audit-policy').VERSION,generation:require('./generation-prompts').VERSION});
 const old=checkpoint?.runtimeEstimate;
 if(old?.key===key&&old.contract)return old.contract;
 const schema={type:'object',additionalProperties:false,required:['seconds','evidence'],properties:{seconds:{type:'number',minimum:0.001},evidence:{type:'string',minLength:1}}};
 require('./agent-stage-tasks').throwIfCancelled(signal);
 const result=await generate([{role:'system',content:require('./generation-prompts').build('runtime')+'\nEstimate the ORIGINAL source runtime from complete spoken Chinese pronunciation, actual emotion and necessary physical action. Do not estimate from raw prose length, headings or summaries. Account for simultaneous action, and describe the basis briefly. This is an estimate, not source-video measurement. Do not rewrite the source. Return seconds and concise evidence.'},{role:'user',content:source}],{json:true,responseSchema:schema,requiredKeys:schema.required,agentStage:'review',stage:'source_runtime_estimate',maxTokens:1200,maxAttempts:1,signal});
 if(!Number.isFinite(result?.seconds)||result.seconds<=0||!String(result.evidence||'').trim())throw require('./audit-progress').pending('source-runtime',{reason:'Original runtime estimate needs source evidence'});
 const seconds=result.seconds,resolved={...contract,sourceSeconds:seconds,targetSeconds:seconds,minSeconds:Math.max(0,seconds-30),maxSeconds:seconds+30,basis:'agent-original-performance-estimate',evidence:result.evidence,estimateFingerprint:key};
 save({key,contract:resolved});return resolved;
}
module.exports={resolve};
