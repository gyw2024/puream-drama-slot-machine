'use strict';
const {fail,textHash,hash,integer}=require('./contracts');
const {itemHash}=require('./domain');
function capture(text,start,end){
  integer(start,'startUtf16',0,text.length);integer(end,'endUtf16',start+1,text.length);
  const split=i=>i>0&&i<text.length&&/[\uD800-\uDBFF]/.test(text[i-1])&&/[\uDC00-\uDFFF]/.test(text[i]);
  if(split(start)||split(end))throw fail('SELECTION_SPLITS_SURROGATE','Select complete characters');
  return {type:'selection',startUtf16:start,endUtf16:end,selectedText:text.slice(start,end),baseTextHash:textHash(text)};
}
function prepareBase(item,scope={type:'wholeItem'},working=null){
  const display=working?.displayPrompt??item.displayPrompt,execution=working?.executionPrompt??item.prompt;
  let selection=null;
  if(scope.type==='selection'){
    selection=capture(display,scope.startUtf16,scope.endUtf16);
    if(scope.selectedText!==selection.selectedText||scope.baseTextHash!==selection.baseTextHash)throw fail('EDIT_CONFLICT','Selection no longer matches the visible working draft');
  }else if(scope.type!=='wholeItem')throw fail('EDIT_SCOPE_INVALID',scope.type);
  return {itemId:item.id,baseItemRevision:item.itemRevision??0,baseContentHash:itemHash(item),
    baseDisplayHash:textHash(item.displayPrompt),baseExecutionHash:textHash(item.prompt),
    workingDisplay:display,workingExecution:execution,selection,scopeType:scope.type};
}
function buildProposal(base,reply){
  if(reply.verdict==='needs_decision'){
    if(reply.replacementDisplay!==null||reply.proposedExecutionPrompt!==null)throw fail('DECISION_HAS_PATCH','Decision cannot contain applicable code/text');return null;
  }
  if(reply.verdict!=='proposal'||typeof reply.replacementDisplay!=='string'||!reply.replacementDisplay.trim()||typeof reply.proposedExecutionPrompt!=='string'||!reply.proposedExecutionPrompt.trim())throw fail('INVALID_PROPOSAL','Complete proposal fields required');
  const s=base.selection;
  const display=s?base.workingDisplay.slice(0,s.startUtf16)+reply.replacementDisplay+base.workingDisplay.slice(s.endUtf16):reply.replacementDisplay;
  return {displayPrompt:display,executionPrompt:reply.proposedExecutionPrompt};
}
function assertApplicable(item,turn){
  if(turn.status!=='proposal_ready')throw fail('PROPOSAL_NOT_APPLICABLE',turn.status);
  const b=turn.base;
  if(item.id!==b.itemId||(item.itemRevision??0)!==b.baseItemRevision||itemHash(item)!==b.baseContentHash||
      textHash(item.displayPrompt)!==b.baseDisplayHash||textHash(item.prompt)!==b.baseExecutionHash)throw fail('EDIT_CONFLICT','Preserve proposal and explicitly rebase');
  if(turn.validation?.valid!==true||turn.validation.proposalHash!==hash(turn.proposal)||turn.validation.baseContentHash!==b.baseContentHash)throw fail('PROPOSAL_NOT_VALIDATED','Schema success is not semantic acceptance');
}
function assertLockedFacts(before,after,{dialogueRows,allowedReferenceIds,referenceExtractor}){
  if(hash(before.dialogueRows)!==hash(after.dialogueRows)||hash(dialogueRows)!==hash(after.dialogueRows))throw fail('LOCKED_DIALOGUE_CHANGED','Dialogue/roles/order cannot change here');
  const old=before.referenceIds,now=referenceExtractor(after.executionPrompt);
  if(hash(old)!==hash(now)||now.some(id=>!allowedReferenceIds.includes(id)))throw fail('LOCKED_REFERENCE_CHANGED','Use a dedicated reference command');
}
module.exports={capture,prepareBase,buildProposal,assertApplicable,assertLockedFacts};
