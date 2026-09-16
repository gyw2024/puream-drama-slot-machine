'use strict';
// A producer is accepted against the same fully bound request that consumers
// submit. Structural authoring success alone is not delivery success.
const VERSION='bound-delivery-v1';
const MAX_CHARACTERS=10000;
function inspect(project,shot,{includePrompt=false}={}){
 const wf=require('./workbench-workflow');
 const refs=wf.promptReviewReferencePlan(project,shot,project.generation?.mode,'image_only');
 let prompt='';
 try{
  prompt=wf.renderApprovedVideoPrompt(project,shot,refs);
  require('./hailuo-h3-prompt').assertAgentHailuoDelivery(prompt,MAX_CHARACTERS,{strictOfficial:true});
  // Agent stage review owns speaker/content judgment on this exact bound prompt.
  return {ok:true,version:VERSION,characters:prompt.length,maxCharacters:MAX_CHARACTERS,referenceCount:refs.images?.length||0,...(includePrompt?{prompt,remainingCharacters:MAX_CHARACTERS-prompt.length}:{} )};
 }catch(error){const characters=error.promptLength||prompt.length;return {ok:false,version:VERSION,characters,maxCharacters:MAX_CHARACTERS,referenceCount:refs.images?.length||0,code:error.code,issues:error.failures||error.issues||[error.message],...(includePrompt?{prompt:error.requestPreview||prompt,remainingCharacters:MAX_CHARACTERS-characters}:{} )};}
}
function assert(project,shot){
 const evidence=inspect(project,shot);
 if(!evidence.ok)throw Object.assign(Error('完整提交内容尚未满足执行合同，不能将上游方案标记为完成'),{code:'PRODUCTION_DELIVERY_CONFLICT',issues:evidence.issues,deliveryEvidence:evidence});
 return evidence;
}
function guidance(project,shot){
 const exactDialogueCharacters=(shot.dialogueTurns||[]).reduce((n,t)=>n+String(t.text||t.spokenText||'').length,0);
 return {version:VERSION,maxFinalCharacters:MAX_CHARACTERS,exactDialogueCharacters,includes:'All reference definitions, retention relationships, compiler-owned rules, timed physical events, dialogue and soundscape.',instruction:'The final bound request, not an individual field or word count, must fit this contract. C/prop IDs expand to official Subject tokens. Keep opening/ending as concise physical states; put each physical event only in events, without repeating it in environment or summary. Preserve every source event, exact word, actor, timing dependency and asset; never omit any to fit. Receipt validation compiles your complete candidate before acceptance. On delivery findings consolidate redundant prose only, not clocks or story facts.'};
}
module.exports={VERSION,MAX_CHARACTERS,inspect,assert,guidance};
