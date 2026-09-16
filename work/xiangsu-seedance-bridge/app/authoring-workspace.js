'use strict';
// Construction data is returned to the author while its draft is still open.
// No content verdict, rewrite, timing choice or additional Agent request here.
const VERSION='authoring-workspace-v1';
const INSTRUCTION=`GENERATION ORDER: Build the complete causal story and exact dialogue sequence, including the ending, before finalizing production boundaries. Choose each segment from its complete sentences, actual performance class and indispensable actions; choose the duration estimate last. A source paragraph number or an earlier saved part is not an immutable shot boundary. In this same authoring task, use draft.txt for a working plan when useful and revise your saved parts before final submission. Opening and ending describe the states produced by the action sequence; do not independently invent a second transfer, pose, speaker or product state in those fields. Dialogue.action only links speech to an action already present, never duplicates the action. Retain stable actor identities even without an image binding. The stage_result_part and preview_stage_result tools provide constructionFacts for source drafts and performanceFacts for director drafts: these are your current words/states and neutral measurements, not approval. Use them while constructing the result, rather than leaving an impossible short ending or missing handoff for a later reviewer. Keep every genuine line once; regroup whole lines and causal actions in the source when needed, with no filler. Source writing, upload normalization and adaptation remain one complete authoring task. Detailed per-shot timing and camera work stay with the director; do not add those fields to the compact script.`;
const DATA_INSTRUCTION='Read-only construction measurements, not a quality verdict. Ordinary and high-emotion values are alternatives: the Agent chooses the actual performance class and spoken realization of prices/numbers. State excerpts are authored proposals, not independent evidence proving themselves correct. Resolve causal transitions and complete speech before committing this same draft. Saved parts remain editable; do not start another screenplay task.';
function sourceFacts(document,targetIds,partial=false){
 const shots=document?.shots||[],targets=new Set(targetIds||shots.map(s=>s.id));
 const measurements=require('./agent-speech-authority').screenplayMeasurements({shots});
 const state=s=>s?{shotId:s.id,sceneId:s.sceneId,opening:s.opening,action:s.action,ending:s.ending}:null;
 return {version:VERSION,partialDraft:partial,instruction:DATA_INSTRUCTION,shots:shots.flatMap((s,i)=>targets.has(s.id)?[{...measurements[i],durationEstimate:s.duration,dialogueIdentities:(s.dialogue||[]).map(d=>({dialogueId:d.id,speakerId:d.speakerId,listenerIds:d.listenerIds,addressMode:d.addressMode,onScreen:d.onScreen,delivery:d.delivery})),current:state(s),previous:state(shots[i-1]),next:state(shots[i+1])}]:[])};
}
function performanceFacts(project,targetIds){
 const shots=project.shots||[],targets=new Set(targetIds),round=n=>Math.round(n*1000)/1000;
 const row=s=>{const item=s.agentProductionDecision?.item;if(!item)return {shotId:s.id,clockAvailable:false};
  const source=s.shotExecution?.dialogue||s.dialogueTurns?.map(d=>({id:d.sourceDialogueId||d.id,text:d.text||d.spokenText}))||[],counts=new Map(require('./agent-speech-authority').measurements(source).map(d=>[d.dialogueId,d]));
  const dialogue=(item.dialogue||[]).map(d=>({...counts.get(d.id),dialogueId:d.id,start:d.start,end:d.end,spokenSeconds:round(d.end-d.start),effectiveCharactersPerSecond:d.end>d.start&&counts.has(d.id)?round(counts.get(d.id).effectiveCharacters/(d.end-d.start)):null}));
  return {shotId:s.id,clockAvailable:true,duration:item.duration,dialogue,leadingNoDialogueSeconds:dialogue.length?Math.min(...dialogue.map(d=>d.start)):item.duration,trailingNoDialogueSeconds:dialogue.length?round(item.duration-Math.max(...dialogue.map(d=>d.end))):item.duration};
 };
 const rows=shots.map(row),boundaries=[];
 for(let i=1;i<shots.length;i++)if(targets.has(shots[i-1].id)||targets.has(shots[i].id)){const left=rows[i-1],right=rows[i];boundaries.push({leftShotId:left.shotId,rightShotId:right.shotId,leftTailSeconds:left.trailingNoDialogueSeconds,rightLeadSeconds:right.leadingNoDialogueSeconds,combinedNoDialogueSeconds:left.clockAvailable&&right.clockAvailable?round(left.trailingNoDialogueSeconds+right.leadingNoDialogueSeconds):null});}
 return {version:VERSION,instruction:DATA_INSTRUCTION,shots:rows.filter(r=>targets.has(r.shotId)),boundaries};
}
function staged(request,state,field,data){
 const kind=request.deliveryPreview?.kind;
 if(field!=='shots'||!Array.isArray(data)||!['screenplay-writing','screenplay-repair','screenplay-repair-fields'].includes(kind))return undefined;
 const parts=state.fields.shots||{},shots=Object.keys(parts).map(Number).sort((a,b)=>a-b).flatMap(i=>parts[i]);
 const facts=sourceFacts({shots},data.map(s=>s.id),true);
 // Repair parts are sparse patches, not a contiguous source sequence.
 // Only the assembled preview can supply their real source neighbors.
 if(kind!=='screenplay-writing'){
  for(const row of facts.shots){row.previous=null;row.next=null;}
  facts.neighborContext='Sparse repair parts do not establish adjacency. Use the supplied source and the assembled preview for actual neighboring shots.';
 }
 return facts;
}
module.exports={VERSION,INSTRUCTION,DATA_INSTRUCTION,sourceFacts,performanceFacts,staged};
