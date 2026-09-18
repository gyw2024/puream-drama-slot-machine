'use strict';
const { fail, hash, unique, exactCoverage } = require('./contracts');
const { promptItem, logicalRefs, allAssets, orderedShots } = require('./domain');
// Ledger is independently extracted/approved from immutable source, NOT reconstructed from shots.
function verify({project,ledger,requiredItemIds,sourceHash,verifyAudit,executionOrder=null}) {
  if(!ledger||ledger.sourceHash!==sourceHash||ledger.status!=='verified'||!Array.isArray(ledger.dialogues)||!Array.isArray(ledger.requiredEntityIds))throw fail('SOURCE_LEDGER_REQUIRED','Independent verified source ledger required');
  if(!Array.isArray(requiredItemIds)||!requiredItemIds.length||!orderedShots(project).length)throw fail('TEXT_EMPTY','Required targets cannot be empty');
  unique(ledger.dialogues);unique(ledger.requiredEntityIds.map(id=>({id})));unique(requiredItemIds.map(id=>({id})));
  const errors=[],delivered=[];const byId=new Map(ledger.dialogues.map(d=>[d.id,d]));
  for(const shot of orderedShots(project)){
    if(!Array.isArray(shot.dialogueTurns)) {errors.push({code:'DIALOGUE_MAPPING_MISSING',shotId:shot.id});continue;}
    for(const turn of shot.dialogueTurns){
      const source=byId.get(turn.sourceDialogueId);delivered.push(turn.sourceDialogueId);
      if(!source||turn.text!==source.text||turn.speakerId!==source.speakerId||turn.listenerId!==source.listenerId)errors.push({code:'DIALOGUE_CHANGED',shotId:shot.id,id:turn.sourceDialogueId??null});
    }
    for(const ref of logicalRefs(shot))if(!allAssets(project).some(a=>a.id===ref.entityId&&!a.archived))errors.push({code:'ASSET_REFERENCE_MISSING',shotId:shot.id,entityId:ref.entityId});
  }
  const sourceIds=ledger.dialogues.map(d=>d.id);
  if(executionOrder&&(!executionOrder.actorId||!executionOrder.commandId||executionOrder.sourceHash!==sourceHash||executionOrder.orderedShotIdsHash!==hash(orderedShots(project).map(s=>s.id))||!exactCoverage(sourceIds,executionOrder.dialogueIds||[]).ok))throw fail('EXECUTION_ORDER_INVALID','Only a trusted explicit reorder may change playback order');
  const expected=executionOrder?executionOrder.dialogueIds:sourceIds,coverage=exactCoverage(sourceIds,delivered);
  if(!coverage.ok)errors.push({code:'DIALOGUE_COVERAGE',coverage});
  if(expected.length===delivered.length&&expected.some((id,i)=>id!==delivered[i]))errors.push({code:'DIALOGUE_ORDER_CHANGED'});
  for(const id of ledger.requiredEntityIds)if(!allAssets(project).some(a=>a.id===id&&!a.archived))errors.push({code:'SOURCE_ENTITY_MISSING',entityId:id});
  const spokenPromptIds=[];
  for(const id of requiredItemIds){
    try {
      const item=promptItem(project,id);
      if(!item.displayPrompt?.trim()||!item.prompt?.trim())throw fail('EMPTY_PROMPT',id);
      if(item.stage==='shot_video'){
        // dialogueBindings contains positional ranges for the EXECUTION text, recorded by the compiler.
        const bindings=item.dialogueBindings||[];let previousEnd=0;
        const shot=orderedShots(project).find(s=>s.id===item.entityId);
        const wantedHere=(shot?.dialogueTurns||[]).map(t=>t.sourceDialogueId);
        if(!shot||!exactCoverage(wantedHere,bindings.map(b=>b.sourceDialogueId)).ok)errors.push({code:'PROMPT_SHOT_BINDING_MISMATCH',itemId:id});
        for(const b of bindings){
          if(b.startUtf16<previousEnd||b.endUtf16>item.prompt.length)errors.push({code:'PROMPT_SPANS_OVERLAP',itemId:id});
          previousEnd=b.endUtf16;spokenPromptIds.push(b.sourceDialogueId);const d=byId.get(b.sourceDialogueId);
          if(!d||!Number.isSafeInteger(b.startUtf16)||!Number.isSafeInteger(b.endUtf16)||b.startUtf16<0||b.endUtf16<=b.startUtf16||item.prompt.slice(b.startUtf16,b.endUtf16)!==d.text)errors.push({code:'PROMPT_DIALOGUE_SPAN_INVALID',itemId:id,sourceDialogueId:b.sourceDialogueId??null});
        }
      }
      if(typeof verifyAudit!=='function'||verifyAudit(item,ledger)!==true)errors.push({code:'AUDIT_NOT_CURRENT',itemId:id});
    }catch(e){errors.push({code:e.code||'PROMPT_INVALID',itemId:id});}
  }
  const promptCoverage=exactCoverage(expected,spokenPromptIds);
  if(!promptCoverage.ok)errors.push({code:'PROMPT_DIALOGUE_COVERAGE',coverage:promptCoverage});
  if(expected.length===spokenPromptIds.length&&expected.some((id,i)=>id!==spokenPromptIds[i]))errors.push({code:'PROMPT_DIALOGUE_ORDER_CHANGED'});
  if(!ledger.endingFactId||project.productionV2?.continuityAudit?.sourceHash!==sourceHash||project.productionV2.continuityAudit.endingFactId!==ledger.endingFactId||project.productionV2.continuityAudit.verdict!=='pass')errors.push({code:'ENDING_OR_CONTINUITY_UNVERIFIED'});
  return {complete:!errors.length,errors,coverage,promptCoverage,sourceHash,requiredItemsHash:hash(requiredItemIds)};
}
function createBatches(items,batchSize=5){if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>100)throw fail('BATCH_SIZE_INVALID','1..100');const result=[];for(let i=0;i<items.length;i+=batchSize)result.push(items.slice(i,i+batchSize));return result;}
module.exports={verify,createBatches};
