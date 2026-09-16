'use strict';
const text={type:'string',minLength:1,pattern:'^[^\\r\\n]+$'};
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
function schema(groups,{adaptive=false}={}){
 const budget=object({beforeSeconds:{type:'number',minimum:.3,maximum:14.35},beforeAction:text,duringSeconds:{type:'number',minimum:0,maximum:15},duringReason:text,afterSeconds:{type:'number',minimum:.35,maximum:14.35},afterAction:text});
 const cast={type:'array',minItems:1,items:object({name:text,presence:{enum:['visible','enters','offscreen']},openingState:text})};
 const detail=object({scene:text,cast,props:text,action:text,sound:text,continuity:text,budget});
 return object({shotDetails:object(Object.fromEntries(groups.map(g=>{const own=structuredClone(detail);if(adaptive){own.properties.sentenceCount={type:'integer',minimum:1,maximum:g.dialogueIds.length};own.required.push('sentenceCount');return [g.shotId,object({segments:{type:'array',minItems:1,maxItems:g.dialogueIds.length,items:own}})];}return [g.shotId,own];}))),sourceAudit:object(Object.fromEntries(['preservedAllDialogue','preservedAllScenes','preservedAllActions','preservedEventOrder','noInventedDialogue'].map(k=>[k,{type:'boolean'}])))});
}
function compileGroups(raw,groups,atoms){
 const shots=[],performanceBudgets=[],finalGroups=[];
 const invalid=message=>{throw Object.assign(Error(message),{code:'UPLOAD_PREPARATION_INCOMPLETE'});};
 if(!raw?.shotDetails||typeof raw.shotDetails!=='object'||Array.isArray(raw.shotDetails))invalid('shotDetails must contain the requested source groups');
 if(Object.keys(raw.shotDetails).some(id=>!groups.some(g=>g.shotId===id)))invalid('shotDetails contains an unknown source group');
 for(const group of groups){
  const value=raw.shotDetails?.[group.shotId];
  if(!value)throw Object.assign(Error(`Missing source group ${group.shotId}`),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
  let cursor=0;
  if(Array.isArray(value.segments)&&value.segments.every(s=>s&&Number.isInteger(s.sentenceCount))){
   const total=value.segments.reduce((n,s)=>n+s.sentenceCount,0);
   if(total!==group.dialogueIds.length)invalid(`Source group ${group.shotId}: expected ${group.dialogueIds.length} complete sentences, received sentenceCount total ${total}; difference ${group.dialogueIds.length-total}. Return only this source group with corrected sentence boundaries and corresponding source actions; preserve every sentence.`);
  }
  const segments=(Array.isArray(value.segments)?value.segments:[{...value,dialogueIds:group.dialogueIds}]).map(segment=>{
   if(!segment||segment.sentenceCount===undefined)return segment;
   if(!Number.isInteger(segment.sentenceCount)||segment.sentenceCount<1||cursor+segment.sentenceCount>group.dialogueIds.length)invalid(`Source group ${group.shotId}: sentenceCount must partition its original sentences exactly`);
   const dialogueIds=group.dialogueIds.slice(cursor,cursor+segment.sentenceCount);cursor+=segment.sentenceCount;
   if(segment.dialogueIds&&JSON.stringify(segment.dialogueIds)!==JSON.stringify(dialogueIds))invalid(`Source group ${group.shotId}: conflicting sentence count and dialogue assignment`);
   return {...segment,dialogueIds};
  });
  if(!segments.length||segments.some(s=>!s||typeof s!=='object'||!Array.isArray(s.dialogueIds)||!s.dialogueIds.length)||JSON.stringify(segments.flatMap(s=>s.dialogueIds||[]))!==JSON.stringify(group.dialogueIds))throw Object.assign(Error(`Source group ${group.shotId} must retain every complete sentence once in order`),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
  for(const segment of segments){
   const shotId=`S${String(shots.length+1).padStart(2,'0')}`;
   shots.push({...compileDetail(segment),scene:segment.scene||atoms.find(a=>a.id===segment.dialogueIds[0])?.sourceSceneName,shotId,dialogueIds:segment.dialogueIds});
   performanceBudgets.push({...segment.budget,shotId});
   const rows=segment.dialogueIds.map(id=>atoms.find(a=>a.id===id));
   const speechSeconds=require('./source-dialogue-groups').bounds(rows);
   const turnCount=rows.reduce((n,r,i)=>n+(!i||r.turnId!==rows[i-1].turnId||r.speaker!==rows[i-1].speaker?1:0),0);
   finalGroups.push({...group,shotId,dialogueIds:segment.dialogueIds,sourceGroupId:group.shotId,speechSeconds,performanceLimits:{...group.performanceLimits,turnCount,maxInteriorSeconds:Number((speechSeconds.max+3*Math.max(0,turnCount-1)).toFixed(2))}});
  }
 }
 return {...raw,sourceGroupDetails:raw.shotDetails,shotDetails:Object.fromEntries(shots.map(s=>[s.shotId,s])),shots,performanceBudgets,finalGroups};
}
function compileDetail(detail){
 if(!Array.isArray(detail.cast))return detail; // Saved pre-migration plans retain their original data.
 if(!detail.cast.length||detail.cast.some(c=>!c||typeof c.name!=='string'||!c.name.trim()||!['visible','enters','offscreen'].includes(c.presence)||typeof c.openingState!=='string'||!c.openingState.trim())||new Set(detail.cast.map(c=>c.name.trim())).size!==detail.cast.length)throw Object.assign(Error('人物出场表为空、重复或缺少明确的出场状态'),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
 const characters=detail.cast.filter(c=>c.presence!=='offscreen').map(c=>c.name).join('、')||'无可见人物';
 const stateBefore=detail.cast.map(c=>`${c.name}${c.presence==='offscreen'?'（画外，不入画）':c.presence==='enters'?'（本镜稍后入画，开场尚未入画）':''}：${c.openingState}`).join('；');
 return {...detail,characters,stateBefore};
}
function inspectGroups(raw,groups,atoms){
 const issues=[];
 for(const group of groups){
  try{compileGroups({...raw,shotDetails:{[group.shotId]:raw?.shotDetails?.[group.shotId]}},[group],atoms);}
  catch(error){if(error.code!=='UPLOAD_PREPARATION_INCOMPLETE')throw error;issues.push(error.message);}
 }
 return issues;
}
module.exports={schema,compileDetail,compileGroups,inspectGroups};
