'use strict';
// Source groups are immutable containers. Final S IDs may change after any
// partition; feedback must resolve through dialogue identity before another call.
function targets(issues, groups, finalGroups = []) {
 const selected = new Set();
 for (const issue of issues) {
  const value = typeof issue === 'string' ? issue : JSON.stringify(issue);
  const sourceMatch=value.match(/^(?:Source group|Missing source group|Recovery omitted source group) (S\d+)/);
  if(sourceMatch){if(!groups.some(g=>g.shotId===sourceMatch[1]))return groups;selected.add(sourceMatch[1]);continue;}
  const match = value.match(/^(S\d+):/);
  if (!match) return groups;
  const final = finalGroups.find(g => g.shotId === match[1]);
  const original = final ? groups.find(g => final.dialogueIds.every(id => g.dialogueIds.includes(id))) : groups.find(g => g.shotId === match[1]);
  if (!original) return groups;
  selected.add(original.shotId);
 }
 return selected.size ? groups.filter(g => selected.has(g.shotId)) : groups;
}
function draftFromCandidate(candidate, groups, fallback) {
 if (!candidate?.shots?.length) return fallback;
 const shotDetails = {};
 for (const group of groups) {
  const shots = candidate.shots.filter(s => s.dialogueIds?.every(id => group.dialogueIds.includes(id)));
  if (JSON.stringify(shots.flatMap(s => s.dialogueIds)) !== JSON.stringify(group.dialogueIds)) return fallback;
  shotDetails[group.shotId] = {segments: shots.map(s => ({...(candidate.shotDetails?.[s.shotId] || s), dialogueIds:s.dialogueIds}))};
 }
 return {shotDetails,sourceAudit:candidate.sourceAudit};
}
function merge(draft, patch, requested) {
 if (!patch || typeof patch!=='object' || Array.isArray(patch)) throw Object.assign(Error('Planning response must contain a structured complete plan'),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
 if (!patch?.shotDetails) return patch;
 const allowed = new Set(requested.map(g => g.shotId));
 const extra = Object.keys(patch.shotDetails).filter(id => !allowed.has(id));
 if (extra.length) throw Object.assign(Error('Recovery returned unrequested source groups: '+extra.join(', ')), {code:'UPLOAD_PREPARATION_INCOMPLETE'});
 for (const id of allowed) if (!patch.shotDetails[id]) throw Object.assign(Error('Recovery omitted source group '+id),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
 return {...draft,...patch,shotDetails:{...draft?.shotDetails,...patch.shotDetails}};
}
function evidence(issues, finalGroups, candidate) {
 return {findings:issues,shotNumberNamespace:'previous_final_production',previousFinalAssignments:finalGroups.map(g=>({shotId:g.shotId,dialogueIds:g.dialogueIds})),previousBudgets:candidate?.performanceBudgets||[],instruction:'Resolve findings by dialogueIds, not matching an S number to a source group. Keep correct source groups unchanged. Partition complete sentences as necessary, preserve all source actions and carry opening/ending state. Do not merely lower numerical budgets: the described performance must fit. If a previous grouping overfills a clip, choose a feasible new partition in the same response.'};
}
module.exports={targets,draftFromCandidate,merge,evidence};
