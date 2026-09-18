'use strict';
const {fail,hash,nonempty}=require('./contracts');
// No built-in guesses for H3/Seedance limits. The registry is created from the existing verified adapter configurations.
function compile({providerId,modelId,contractId,promptSegments,references,durationSeconds},registry){
  const key=`${providerId}:${modelId}:${contractId}`,c=registry.get(key);
  if(!c||c.verified!==true)throw fail('PROVIDER_CONTRACT_UNAVAILABLE',key);
  if(!c.maxReferences||!Number.isFinite(c.maxPromptUnits)||c.maxPromptUnits<1||typeof c.hash!=='string'||!c.hash||typeof c.supportsDuration!=='function'||typeof c.tokenFor!=='function'||typeof c.measurePrompt!=='function'||typeof c.renderPrompt!=='function'||typeof c.buildRequest!=='function')throw fail('PROVIDER_ADAPTER_MISSING',key);
  if(!Array.isArray(references)||!Array.isArray(promptSegments))throw fail('COMPILE_INPUT_INVALID','Arrays required');
  const groups={image:[],audio:[],video:[]};const seen=new Set();
  for(const ref of references){
    if(!groups[ref.mediaType])throw fail('REFERENCE_MEDIA_TYPE_INVALID',ref.mediaType);
    nonempty(ref.bindingId,'bindingId');nonempty(ref.artifactHash,'artifactHash');
    if(seen.has(ref.bindingId))throw fail('DUPLICATE_BINDING',ref.bindingId);seen.add(ref.bindingId);groups[ref.mediaType].push(ref);
  }
  for(const type of Object.keys(groups)){
    const max=c.maxReferences[type];if(!Number.isSafeInteger(max)||max<0)throw fail('REFERENCE_LIMIT_UNKNOWN',type);
    if(groups[type].length>max)throw fail('REFERENCE_LIMIT_EXCEEDED',type,{count:groups[type].length,max});
  }
  if(!Number.isFinite(durationSeconds)||!c.supportsDuration(durationSeconds))throw fail('VIDEO_DURATION_UNSUPPORTED',key);
  const slots=[];
  for(const type of Object.keys(groups))groups[type].forEach((r,i)=>slots.push({...r,index:i+1,token:c.tokenFor(type,i+1)}));
  // Segments distinguish speech/reference/action. Never regex-delete brackets from source dialogue.
  const execution=c.renderPrompt(promptSegments,slots);
  nonempty(execution,'compiledExecution');
  const length=c.measurePrompt(execution);if(!Number.isFinite(length)||length>c.maxPromptUnits)throw fail('PROVIDER_PROMPT_TOO_LONG',key,{length,max:c.maxPromptUnits});
  const body=c.buildRequest({execution,slots,durationSeconds});
  const snapshot={providerId,modelId,contractId,contractHash:c.hash,execution,slots,durationSeconds,body};
  return {...snapshot,compiledHash:hash(snapshot)};
}
module.exports={compile};
