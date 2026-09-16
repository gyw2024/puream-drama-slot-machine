'use strict';
const crypto=require('node:crypto'),{stageSource}=require('./agent-stage-routing');
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
function inputFingerprint(project,shot,settings,select){
 const reviewer=stageSource(settings.localAgents,'review');
 const people=new Set([...(shot.visibleCharacterIds||shot.characterIds||[]),...(shot.offscreenSpeakerIds||[]),...(shot.dialogueTurns||[]).flatMap(t=>[t.speakerId,t.primaryListenerId,...(t.listenerIds||[])])].filter(Boolean));
 const cast=(project.characters||[]).filter(c=>people.has(c.id));
 const references=cast.map(c=>{const ref=select(project,'character',c.id,'character_intro')||select(project,'character',c.id,'character_sheet')||select(project,'character',c.id,'character_three_view');return {characterId:c.id,...pick(ref,['id','filePath','sha256'])};});
 const wardrobes=require('./drama-staging-contract').activeWardrobeBindings(project,shot).map(b=>({...b,reference:pick(select(project,'library',b.wardrobeId,'wardrobe_asset'),['id','filePath','sha256'])}));
 return crypto.createHash('sha256').update(JSON.stringify({version:2,requirementsVersion:require('./production-content-requirements').VERSION,shotOrder:(project.shots||[]).map(s=>s.id),
  shot:pick(shot,['id','duration','sceneId','action','stateBefore','stateAfter','dialogue','dialogueTurns','visibleCharacterIds','characterIds','offscreenSpeakerIds','propBindings','continuityCastState','manualVideoPrompt','systemVideoPrompt','videoPromptDialogueOverride']),
  cast:cast.map(c=>pick(c,['id','name','gender','age','ageBand','description','descriptionEn','identitySignature','voiceDescription'])),references,wardrobes,
  product:project.product,reviewer,execution:reviewer==='api'?pick(settings.textProvider,['kind','baseUrl','model','reasoningEffort','serviceTier']):settings.localAgents?.providers?.[reviewer]
 })).digest('hex');
}
function summarize(project,settings,select,{version,dimensions,lastRunReports=[]}={}){
 const reports=(project.shots||[]).map(shot=>{
  const selected=select(project,'shot',shot.id,'shot_video'),r=shot.actualMediaAudit;
  if(lastRunReports.some(row=>row.shotId===shot.id&&row.status==='missing_video'))return {shotId:shot.id,status:'not_currently_reviewed',reason:'missing_video',sourceCandidateId:selected?.id||null};
  const stale=!r||r.version!==version||!selected?.id||r.sourceCandidateId!==selected.id||!/^[a-f0-9]{64}$/i.test(r.sourceSha256||'')
   ||(selected.sha256&&selected.sha256.toLowerCase()!==r.sourceSha256.toLowerCase())
   ||r.inputFingerprint!==inputFingerprint(project,shot,settings,select)
   ||(r.neighborEvidence||[]).some(n=>select(project,'shot',n.shotId,'shot_video')?.id!==n.candidateId);
  if(stale)return {shotId:shot.id,status:'not_currently_reviewed',sourceCandidateId:selected?.id||null};
  const complete=Array.isArray(r.dimensions)&&r.dimensions.length===dimensions.length&&new Set(r.dimensions.map(d=>d.dimension)).size===dimensions.length&&dimensions.every(name=>r.dimensions.some(d=>d.dimension===name));
  return {shotId:shot.id,...r,status:r.status==='passed'&&(!complete||r.dimensions.some(d=>d.status!=='pass'))?'needs_attention':r.status};
 });
 return {version,checkedAt:new Date().toISOString(),reports,lastRunReports,totalShots:reports.length,currentReviewedShots:reports.filter(r=>r.status!=='not_currently_reviewed').length,passed:reports.length>0&&reports.every(r=>r.status==='passed')};
}
module.exports={inputFingerprint,summarize};
