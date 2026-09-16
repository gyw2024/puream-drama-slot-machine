'use strict';
// Pure acceptance contract: no machine-specific historical task directory.
function summarizeSource(project){
 const shots=project?.shots;
 if(!Array.isArray(shots)||!shots.length)throw Error('SOURCE_SHOTS_REQUIRED');
 const shotIds=shots.map(s=>String(s.id||''));
 if(shotIds.some(id=>!id.trim())||new Set(shotIds).size!==shotIds.length)throw Error('SOURCE_SHOT_IDS_INVALID');
 if(shots.some(s=>!Number.isFinite(Number(s.duration))||Number(s.duration)<=0))throw Error('SOURCE_DURATION_INVALID');
 return Object.freeze({shotIds:Object.freeze(shotIds),seconds:shots.reduce((n,s)=>n+Number(s.duration),0),dialogue:Object.freeze(shots.flatMap(s=>(s.dialogueTurns||[]).map(t=>String(t.text||t.spokenText||''))))});
}
module.exports={summarizeSource};
