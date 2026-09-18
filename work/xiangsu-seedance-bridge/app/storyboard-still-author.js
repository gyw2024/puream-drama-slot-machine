'use strict';
const crypto=require('node:crypto');
const VERSION='source-bound-still-instants-v7-generation-methods';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function productVisible(shot){return typeof shot.shotExecution?.productVisible==='boolean'?shot.shotExecution.productVisible:Boolean(shot.productMention);}
function source(project,shot,kind='frames'){const index=project.shots.findIndex(s=>s.id===shot.id),prior=project.shots[index-1];return {
 ...(kind==='sheet'?{samplingPolicy:'contact-aware-instants-closed-ending-v1'}:{}),
 version:VERSION,shotId:shot.id,duration:Number(shot.duration),aspectRatio:project.generation?.aspectRatio||'9:16',
 sceneId:shot.sceneId,opening:!prior,previous:prior?{id:prior.id,sceneId:prior.sceneId,stateAfter:prior.stateAfter,timeline:prior.finalPromptEditing?.detailedDescriptionEn}:null,
 visibleCharacterIds:shot.visibleCharacterIds||shot.characterIds||[],offscreenSpeakerIds:shot.offscreenSpeakerIds||[],
 commercePolicy:productVisible(shot)?require('./commerce-authoring-policy').VISUAL_POLICY:null,sourceAction:shot.action,stateBefore:shot.stateBefore,stateAfter:shot.stateAfter,
 timeline:shot.finalPromptEditing?.detailedDescriptionEn,
 masterAgentDecision:require('./agent-production-decisions').current(project,shot)?shot.agentProductionDecision.item:null,
 dialogue:(shot.dialogueTurns||[]).map(t=>({speakerId:t.speakerId,onScreen:t.onScreen!==false,start:t.startSecond,end:t.endSecond})),
 scene:(project.scenes||[]).filter(s=>s.id===shot.sceneId).map(s=>({id:s.id,descriptionEn:s.descriptionEn})),
 characters:(project.characters||[]).filter(c=>(shot.visibleCharacterIds||shot.characterIds||[]).includes(c.id)).map(c=>({id:c.id,descriptionEn:c.descriptionEn})),
 props:(project.assetLibraries?.props||[]).filter(p=>(shot.propBindings||[]).some(b=>b.propId===p.id)||(shot.agentProductionDecision?.item?.visiblePropIds||[]).includes(p.id)).map(p=>({id:p.id,name:p.name,identityKind:p.assetRequired===false||p.sourceInventory?.classification==='in_scene'?'scene_object':'independent_prop',descriptionEn:p.descriptionEn||'',sourceDescription:p.sourceDescription||p.description||''})),
 wardrobes:(project.assetLibraries?.wardrobes||[]).filter(w=>(shot.wardrobeBindings||[]).some(b=>b.wardrobeId===w.id)).map(w=>({id:w.id,characterId:w.characterId,descriptionEn:w.descriptionEn||w.description})),
 wardrobeBindings:shot.wardrobeBindings||[],
 product:productVisible(shot)?{...(project.product?.visualEvidence||{}),id:'product',name:project.product?.name||''}:null,
};}
function current(project,shot,kind='frames'){const row=shot.storyboardStillAuthoring?.[kind];return row?.status==='authored'&&row.fingerprint===hash(source(project,shot,kind));}
function validate(input,item,kind){const errors=[];
 if(item.shotId!==input.shotId)errors.push('wrong shot ID');
 const frames=kind==='sheet'?item.panels:[item.start,item.end];
 if(!Array.isArray(frames)||frames.length!==(kind==='sheet'?Math.ceil(input.duration):2))errors.push('missing complete start/end or exact second-panel count');
 for(const [i,frame] of (Array.isArray(frames)?frames:[]).entries()){
  if(typeof frame?.descriptionEn!=='string'||!frame.descriptionEn.trim())errors.push(`frame ${i}: complete English still description required`);
  if(!Array.isArray(frame?.visibleCharacterIds)||new Set(frame.visibleCharacterIds).size!==frame.visibleCharacterIds.length||frame.visibleCharacterIds.some(id=>!input.visibleCharacterIds.includes(id)))errors.push(`frame ${i}: visible identity not in source`);
  if(kind==='sheet'&&frame.second!==i)errors.push(`panel ${i}: exact chronological second required`);
  if(kind==='sheet'){
   const t=Number(frame.timeSecond),last=i===Math.ceil(input.duration)-1;
   if(!Number.isFinite(t)||(i===0&&t!==0)||(last&&t!==input.duration)||(!last&&(t<i||t>=i+1)))errors.push(`panel ${i}: sample within its second interval; first at zero, final at exact duration`);
  }
  if(kind==='frames'&&!['closed','speaking'].includes(frame?.mouthState))errors.push(`frame ${i}: explicit actual mouth state required`);
  const at=kind==='sheet'?Number(frame?.timeSecond):(i===0?0:input.duration);
  const cameraCast=require('./native-visual-output-contract').visibleAt(input,at);
  if(cameraCast&&JSON.stringify([...cameraCast].sort())!==JSON.stringify([...(frame?.visibleCharacterIds||[])].sort()))errors.push(`frame ${i}: visible identities must match the active camera at ${at} seconds`);
  if(/<d>|\[Chinese\]|<Picture|<Subject|<Audio|<Video/.test(frame?.descriptionEn||''))errors.push(`frame ${i}: no speech or invented reference numbers`);
 }
 if(errors.length)throw Object.assign(Error('静帧描述尚需定点修正；原稿与已完成项已保留'),{code:'STORYBOARD_STILL_NEEDS_REPAIR',expectedControl:true,reviewRequired:true,failures:errors});return item;
}
const INSTRUCTION=require('./generation-prompts').build("stills","Return ONLY requested kind: frames has start/end {descriptionEn,visibleCharacterIds,mouthState}; sheet has panels [{second,timeSecond,descriptionEn,visibleCharacterIds}]. Each description is one complete English photograph description, not a video or speech. No dialogue tags or invented Picture/Subject numbers. Preserve source IDs. For frames use exact zero and exact final duration; choose actual mouth state under this request's schema, closed lips do not imply closed eyes. For sheet exactly ceil(duration) panels, second indexes 0..ceil(duration)-1, first timeSecond=0, last=duration, intermediate cell i samples within [i,i+1). Reconstruct each actor and object's state at that sampled instant, not at a future action. Preserve last active camera for the end. Use explicitly declared camera.visibleCharacterIds when supplied, otherwise actual framing and performed positions. Never romanize, translate, re-typeset or invent intrinsic product printing; preserve it through the original image reference. In a multi-actor description explicitly repeat each actor's ID; resolve gaze targets per actor, excluding self. subjectIds identify focal people, not the complete visible cast; camera owner is a focus, not permission to delete a listener. Camera changes never force a new gesture or reset a completed action. Props use given typed IDs and names; source furniture needs no invented independent portrait. Fixed reference appearance outranks contradictory restyling in a derived timeline; original story outranks a faulty master plan. Do not creatively replace core story to hide that conflict. No new field or failure schema may be invented.") + require('./first-delivery-contract').forStage('still');
async function author({getProject,saveProject,generate,kind,shotIds,findingsByShot={},concurrency=4,signal}){
 const selected=shotIds&&new Set(shotIds),initial=getProject();
 const feedback=s=>findingsByShot[s.id]?.length?hash(findingsByShot[s.id]):'';
 const done=(p,s)=>current(p,s,kind)&&(!feedback(s)||s.storyboardStillAuthoring[kind].feedbackFingerprint===feedback(s));
 const pending=initial.shots.filter(s=>(!selected||selected.has(s.id))&&s.finalPromptEditing?.status==='authored'&&!done(initial,s));
 await require("./preproduction-performance").mapBatches(pending,Math.min(4,Math.max(1,concurrency)),async shot=>{let remaining=[shot],issues=remaining.map(s=>({shotId:s.id,issues:findingsByShot[s.id]||[]}));
  for(let attempt=0;remaining.length;attempt++){
    require("./agent-stage-tasks").throwIfCancelled(signal);
    await new Promise(setImmediate);
   const inputs=remaining.map(s=>source(getProject(),s,kind)),result={items:[]};
   for(const scope of attempt<2?[inputs]:inputs.map(input=>[input])){
    const ids=new Set(scope.map(s=>s.shotId));
    const part=await generate([{role:'system',content:INSTRUCTION},{role:'user',content:JSON.stringify({kind,shots:scope.map(input=>({...input,...(kind==='sheet'?{requiredSamples:require('./native-visual-output-contract').samples(input)}:{})})),issues:issues.filter(i=>ids.has(i.shotId)),recoveryStrategy:attempt<2?'targeted_patch':'isolated_source_reconciliation',instruction:attempt<2?'Preserve accepted shots.':'Re-read this single shot and its exact authored instants. Resolve the reported conflict from original source and timeline, not a repeated blind patch. Keep all accepted neighboring shots unchanged.'})}],{agentStage:'planning',costOperation:'storyboard_still_'+kind,json:true,maxAttempts:1,requiredKeys:['items'],responseSchema:require('./native-visual-output-contract').still(scope,kind),maxTokens:kind==='sheet'?14000:7500,signal});
    result.items.push(...(part.items||[]).filter(r=>ids.has(r.shotId)));
   }
   require("./agent-stage-tasks").throwIfCancelled(signal);
   const rows=Array.isArray(result?.items)?result.items.filter(row=>row&&typeof row==='object'):[];
   const counts=new Map();for(const row of rows)counts.set(row.shotId,(counts.get(row.shotId)||0)+1);issues=[];
   for(const shot of remaining){const input=inputs.find(x=>x.shotId===shot.id),item=rows.find(x=>x.shotId===shot.id);
    try{if(!item||counts.get(shot.id)!==1)throw Object.assign(Error('missing or duplicate shot'),{failures:['one result for every shot required']});validate(input,item,kind);
     const latest=getProject(),live=latest.shots.find(s=>s.id===shot.id);if(hash(source(latest,live,kind))!==hash(input))throw Object.assign(Error('source changed during still authoring'),{code:'STORYBOARD_SOURCE_CHANGED'});
     live.storyboardStillAuthoring={...live.storyboardStillAuthoring,[kind]:{...item,status:'authored',version:VERSION,fingerprint:hash(input),feedbackFingerprint:feedback(shot),at:new Date().toISOString()}};saveProject(latest);
    }catch(e){if(e.code==='STORYBOARD_SOURCE_CHANGED')throw e;issues.push({shotId:shot.id,issues:e.failures,previous:item});}
   }
   const latest=getProject();remaining=remaining.filter(s=>!done(latest,latest.shots.find(x=>x.id===s.id)));
  }
  if(remaining.length)throw Object.assign(Error('分镜静帧提示词需继续定点修正；未提交图片'),{code:'STORYBOARD_STILL_NEEDS_REPAIR',expectedControl:true,reviewRequired:true,shotIds:remaining.map(s=>s.id),findings:issues});
 },{signal});
 return getProject();
}
function compile(project,shot,stage,grid){const kind=stage==='storyboard_sheet'?'sheet':'frames';if(!['storyboard_start','storyboard_end','storyboard_sheet'].includes(stage)||!current(project,shot,kind))return '';
 const value=shot.storyboardStillAuthoring[kind],aspect=project.generation?.aspectRatio||'9:16';
 const identities=source(project,shot).characters.map(c=>`${c.id}: use only this recurring identity from its supplied character reference; not another cast member.`).join('\n');
 const body=kind==='frames'?`One photorealistic ${aspect} camera-original story photograph. One instant, one camera position, no panels. All visible mouths are closed.\n${value[stage==='storyboard_start'?'start':'end'].descriptionEn}`:`One ${grid.canvasAspectRatio} chronological contact sheet, ${grid.columns} columns by ${grid.rows} rows, exactly ${value.panels.length} equally sized ${aspect} panels, read left-to-right then top-to-bottom. Remaining cells are blank gutters, never extra frames. Uniform scale, no distorted bodies or figures crossing panels. Internal ordering below is not printed on the image.\n${value.panels.map(p=>`Panel ${p.second+1}, instant ${Number(p.timeSecond).toFixed(3)} seconds: ${p.descriptionEn}`).join('\n')}`;
 const productRetention=productVisible(shot)?' The source-staged original product retains exact packaging, printing and continuous physical support. Every product frame keeps a named in-story character visible with body and expression, never product-only or anonymous-hands-only framing.':'';
 return `${body}\n${identities}\nEvery visible identity has exactly one physical body in each frame. Use supplied scene geometry and current wardrobe, with the authored camera position and acting state. Depict only source-staged objects, preserving their exact appearance and continuous physical support.${productRetention} No added captions, subtitles, numbers, time labels, watermarks, interface or graphic overlays. Intrinsic source-authorized printing or imagery remains unchanged.`;
}
module.exports={VERSION,INSTRUCTION,source,current,validate,author,compile};
