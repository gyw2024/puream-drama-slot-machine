'use strict';
// Read-only source and authored-clock context. The Agent chooses performance;
// no numeric observation in this module approves or rejects a creative result.
const VERSION='parallel-dialogue-boundaries-v1';
const INSTRUCTION='PARALLEL DIALOGUE HANDOFF: The three-second no-dialogue limit applies to the SUM of the preceding clip tail and following clip lead, not three seconds for each clip. dialogueBoundaries supplies read-only source lines and any existing authored clocks; never perform a neighbor line in this clip. For unchanged neighbors marked clockFixedForThisRun, use their actual end/start and jointly fit your boundary into the remaining allowance. For two shots in this batch, plan both sides together. For a boundary whose other shot is also being generated in a parallel batch, do not assume its lead/tail is zero: start with a symmetric allowance of at most 1.5 seconds on each side. This is a conservative planning convention, not a new acceptance rule; an evidenced alternative is valid when the combined gap is within three seconds. Do not lengthen speech, add interjections or invent actions to reach a boundary. Use genuine source speech and compatible simultaneous action. If complete source lines cannot fit the provider duration without a long gap, identify the source segmentation conflict for upstream repair instead of claiming a short phrase fills the whole clip. Existing clocks are proposals, never evidence that their speech rate or internal gaps are compliant.';
function packet(project,targetIds,pendingIds,fixedIds=[]){
 const targets=new Set(targetIds),pending=new Set(pendingIds),fixed=new Set(fixedIds),shots=project.shots||[];
 const row=s=>{const d=s.shotExecution,clock=s.agentProductionDecision?.item,lines=d?.dialogue||s.dialogueTurns||[];
  return {shotId:s.id,sourceDurationEstimate:d?.duration,sourceDialogue:lines.map(l=>({id:l.id||l.sourceDialogueId,speakerId:l.speakerId,text:l.text||l.spokenText,delivery:l.delivery||l.sourceTone})),revisionPlanned:pending.has(s.id),clockFixedForThisRun:fixed.has(s.id),authoredClock:clock?{duration:clock.duration,dialogue:(clock.dialogue||[]).map(l=>({id:l.id,start:l.start,end:l.end}))}:null};
 };
 const boundaries=[];for(let i=1;i<shots.length;i++)if(targets.has(shots[i-1].id)||targets.has(shots[i].id))boundaries.push({left:row(shots[i-1]),right:row(shots[i])});
 return {version:VERSION,instruction:INSTRUCTION,boundaries};
}
module.exports={VERSION,INSTRUCTION,packet};
