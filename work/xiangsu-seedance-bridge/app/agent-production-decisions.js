'use strict';
const crypto=require('node:crypto');
const VERSION='agent-owned-production-v15-generation-methods';
const compact=require('./compact-screenplay');
const RENDER_VERSION=5;
const hash=x=>crypto.createHash('sha256').update(require('./foundry/canonical').canonicalJson(x)).digest('hex');
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const text={type:'string',minLength:1};
function recordedDialogueIds(shot,event){
 const recording=event.recordedSpeech;if(!recording)return [];
 if(Array.isArray(recording.sourceDialogueIds)&&recording.sourceDialogueIds.length){const ids=recording.sourceDialogueIds,rows=(shot.dialogueTurns||[]).filter(t=>ids.includes(t.sourceDialogueId||t.id));if(new Set(ids).size===ids.length&&rows.length===ids.length&&rows.every(t=>t.speakerId===recording.speakerId))return rows.map(t=>t.sourceDialogueId||t.id);return [];}
 if(!recording.textZh)return [];
 const turns=(shot.dialogueTurns||[]),id=t=>t.sourceDialogueId||t.id;
 const requested=event.throughoutDialogueIds||[];
 const sameVoice=rows=>rows.length&&rows.every(t=>t.speakerId===recording.speakerId)&&rows.map(t=>t.text||t.spokenText||'').join('')===recording.textZh;
 const selected=turns.filter(t=>requested.includes(id(t)));
 if(selected.length===requested.length&&sameVoice(selected))return selected.map(id);
 for(let start=0;start<turns.length;start++)for(let end=start+1;end<=turns.length;end++){const rows=turns.slice(start,end);if(sameVoice(rows))return rows.map(id);}
 return [];
}
const list=(items,minItems=0)=>({type:'array',items,minItems});
const enumIds=ids=>ids.length?{type:'string',enum:[...new Set(ids)]}:{type:'string',const:'__no_available_entity__'};
function dialogueSchema(turns,chars){if(!turns.length)return object({});return {anyOf:turns.map(t=>object({id:{type:'string',const:t.sourceDialogueId||t.id},start:{type:'number',minimum:0,maximum:15},end:{type:'number',minimum:0,maximum:15},deliveryEn:text,deliveryZh:text,listenerIds:list(chars),addressMode:{enum:['person','group','viewer','self','offscreen']}}))};}
function source(project,shot){return {id:shot.id,sceneId:shot.sceneId,action:shot.action,stateBefore:shot.stateBefore,stateAfter:shot.stateAfter,wardrobeLabel:shot.wardrobeLabel,wardrobeBindings:shot.wardrobeBindings,sourcePropBindings:shot.sourcePropBindings||(shot.propBindings||[]).filter(b=>b.source!=='agent-production-decision'),continuityCastState:shot.continuityCastState,authoredContinuity:shot.authoredContinuity,dialogue:(shot.dialogueTurns||[]).map(t=>({id:t.sourceDialogueId||t.id,speakerId:t.speakerId,text:t.text||t.spokenText,onScreen:t.onScreen!==false,speechMode:t.speechMode||'',listenerIds:t.listenerIds||[],directToViewer:t.directToViewer===true,addressMode:t.addressMode||'',bounds:require('./drama-timing').speechWindowBounds(t.text||t.spokenText,t)}))};}
function sceneContracts(project){return (project.scenes||[]).map(s=>({id:s.id,name:s.name,description:s.visualDesign?.descriptionZh||s.description,descriptionEn:s.visualDesign?.descriptionEn||s.descriptionEn,time:s.time,lighting:s.lighting,lightDirection:s.lightDirection,layout:s.layout}));}
function neighborContract(s){const e=s.shotExecution;return {shotId:s.id,sceneId:s.sceneId,stateBefore:e?e.opening:s.stateBefore,stateAfter:e?e.ending:s.stateAfter,sourceAction:s.action,visibleCharacterIds:e?e.visibleCharacterIds:s.visibleCharacterIds,propBindings:e?e.propIds.map(propId=>({propId})):(s.sourcePropBindings||s.propBindings)};}
function legacySourceFingerprint(project,shot){return hash({version:VERSION,execution:shot.shotExecution,continuity:project.filmContinuityPlan?.fingerprint||'',source:source(project,shot),script:project.script?.raw,product:project.product,scenes:sceneContracts(project),characters:(project.characters||[]).map(c=>({id:c.id,name:c.name})),props:(project.assetLibraries?.props||[]).map(p=>({id:p.id,name:p.name}))});}
function scopedSourceFingerprint(project,shot,includeStory=true){
 if(!shot.shotExecution)return legacySourceFingerprint(project,shot);
 const execution=shot.shotExecution,chars=new Set(execution.characterIds),props=new Set(execution.propIds),i=project.shots.findIndex(s=>s.id===shot.id);
 const neighbors=[i-1,i+1].filter(n=>n>=0&&n<project.shots.length).map(n=>neighborContract(project.shots[n]));
 return hash({version:VERSION,scope:'accepted-shot-v1',execution,source:source(project,shot),neighbors,...(includeStory?{storyContext:project.script?.shotScreenplay?.document?.story?.synopsis||''}:{}),
  product:execution.productVisible?project.product:null,scenes:sceneContracts(project).filter(s=>s.id===shot.sceneId),
  characters:(project.characters||[]).filter(c=>chars.has(c.id)).map(c=>({id:c.id,name:c.name,gender:c.gender,age:c.age,role:c.role,description:c.description,voiceDescription:c.voiceDescription,voiceDescriptionEn:c.voiceDescriptionEn})),
  props:(project.assetLibraries?.props||[]).filter(p=>props.has(p.id)).map(p=>({id:p.id,name:p.name,description:p.description}))});
}
function sourceFingerprint(project,shot){return scopedSourceFingerprint(project,shot);}
function actingInputsUnchanged(before,oldShot,after,newShot){return scopedSourceFingerprint(before,oldShot,false)===scopedSourceFingerprint(after,newShot,false);}
function current(project,shot){
 const record=shot.agentProductionDecision;if(record?.status!=='authored')return false;
 if(record.sourceFingerprint===sourceFingerprint(project,shot))return true;
 if(record.sourceFingerprint===legacySourceFingerprint(project,shot))return true;
 if(shot.shotExecution&&!record.storyContextVersion&&record.sourceFingerprint===scopedSourceFingerprint(project,shot,false))return true;
 // A newly recorded packaging observation does not alter a source-authored
 // shot which explicitly excludes the product. Compare every other input.
 if(shot.shotExecution?.productVisible===false&&record.item?.productVisible===false&&project.product?.visualEvidence){
  const product={...project.product};delete product.visualEvidence;
  return record.sourceFingerprint===sourceFingerprint({...project,product},shot)||record.sourceFingerprint===legacySourceFingerprint({...project,product},shot);
 }
 return false;
}
function schema(project,shots){
 const chars=enumIds((project.characters||[]).map(c=>c.id)),props=enumIds((project.assetLibraries?.props||[]).map(p=>p.id));
 const narrative=require('./production-identity-contract').narrativeSchema(project.assetLibraries?.props||[]);
 const state=object({characterId:chars,openingEn:narrative,openingZh:text,endingEn:narrative,endingZh:text});
 const stateFields=prop=>Object.fromEntries(['openingEn','openingZh','endingEn','endingZh'].map(key=>[key,{...(key.endsWith('En')?narrative:text),description:'State of '+prop.id+' ('+prop.name+') only. This ID belongs to this exact object, not another salient scene object or the original product.'}]));
 const statePropIds=shots.every(s=>s.shotExecution)?new Set(shots.flatMap(s=>s.shotExecution.propIds)):null;
 const stateProps=(project.assetLibraries?.props||[]).filter(p=>!statePropIds||statePropIds.has(p.id));
 const objectState=stateProps.length?{anyOf:stateProps.map(prop=>object({propId:{type:'string',const:prop.id},...stateFields(prop)}))}:object({propId:props,openingEn:narrative,openingZh:text,endingEn:narrative,endingZh:text});
 const recordedSpeech=object({speakerId:chars,textZh:text,sourceQuoteZh:text,deliveryEn:text,deliveryZh:text});
 const boundRecording={...object({speakerId:chars,sourceDialogueIds:list(text,1),deliveryEn:text,deliveryZh:text}),description:'Only an actual source-authored recording playback. Ordinary live dialogue, whether visible or offscreen, never belongs here. Use null for recordedSpeech and the normal dialogue row for live speech.'};
 const event=object({id:text,continuityActionIds:list(text),actorIds:{...list(chars,1),description:'ALL actual performers of this event, both visible and offscreen. Do not omit an offscreen performer from this list.'},offscreenActorIds:{...list(chars),description:'The subset of actorIds performing outside this frame. Every ID here must also occur in actorIds; it need not be visibleCharacterIds. Preserve source-authored offscreen actions.'},propIds:list(props),usesProduct:{type:'boolean'},start:{type:'number',minimum:0,maximum:15},end:{type:'number',minimum:0,maximum:15},after:list(text),descriptionEn:narrative,descriptionZh:text,recordedSpeech:{anyOf:[boundRecording,recordedSpeech,{type:'null'}]}});
 const camera=object({at:{type:'number',minimum:0,maximum:15},size:{enum:['wide','medium wide','medium','medium close','close']},angle:{enum:['front','left-front','right-front','left-side','right-side','rear','over-shoulder']},movement:{enum:['locked','slow push-in','slow pull-back','gentle pan left','gentle pan right','gentle tracking left','gentle tracking right']},subjectIds:list(chars,1)});
 const eventFor=s=>{const ids=project.filmContinuityPlan?.result?.shots.find(r=>r.shotId===s.id)?.actions?.map(a=>a.id)||[],speechIds=s.dialogueTurns.map(t=>t.sourceDialogueId||t.id);return {...event,required:[...event.required,'throughoutDialogueIds'],properties:{...event.properties,throughoutDialogueIds:{type:'array',items:enumIds(speechIds),...(speechIds.length?{}:{maxItems:0})},continuityActionIds:{type:'array',items:enumIds(ids),...(ids.length?{}:{maxItems:0})}}};};
 const result=object({items:{type:'array',minItems:shots.length,maxItems:shots.length,items:{anyOf:shots.map(s=>object({shotId:{const:s.id},identityContractVersion:{const:1},duration:{type:'integer',minimum:10,maximum:15},visibleCharacterIds:list(chars,1),visiblePropIds:list(props),productVisible:{type:'boolean'},states:list(state,1),environmentEn:narrative,environmentZh:text,objectStates:list(objectState),events:list(eventFor(s),1),cameras:list(camera,1),dialogue:{type:'array',minItems:s.dialogueTurns.length,maxItems:s.dialogueTurns.length,items:dialogueSchema(s.dialogueTurns,chars)},summaryEn:narrative,soundscapeEn:text}))}}});
 for(let i=0;i<shots.length;i++){
  const execution=shots[i].shotExecution;if(!execution)continue;
  const p=result.properties.items.items.anyOf[i].properties;
  p.cameras.items.properties.subjectIds={...p.cameras.items.properties.subjectIds,description:'The source-authored focal people for this framing, not an exclusive list of everyone present in the scene. A non-focal listener can remain at the established position outside a close-up or in its background.'};
  if(!execution.visibleCharacterIds.length){p.states.minItems=0;p.cameras.items.properties.subjectIds.minItems=0;}
  p.events.items.properties.actorIds.minItems=0;
  // The screenplay Agent owns speech origin. Conversion cannot route its
  // explicitly on-screen lines into the recording-playback channel.
  const playbackIds=execution.dialogue.filter(d=>d.onScreen!==true).map(d=>d.id);
  p.events.items.properties.recordedSpeech=playbackIds.length?{anyOf:[object({speakerId:chars,sourceDialogueIds:list(enumIds(playbackIds),1),deliveryEn:text,deliveryZh:text}),{type:'null'}],description:'Only source-authored playback of the listed offscreen dialogue IDs; ordinary live offscreen speech still uses null.'}:{type:'null',description:'All supplied dialogue is source-authored on-screen live speech (or this shot is silent). Use normal dialogue rows and throughoutDialogueIds; there is no recording-playback channel in this shot.'};
  if(!compact.isCompactShot(execution))p.duration={const:execution.duration};
  p.visibleCharacterIds={const:execution.visibleCharacterIds};p.visiblePropIds={const:execution.propIds};p.productVisible={const:execution.productVisible};
  for(const option of p.dialogue.items.anyOf||[]){const d=execution.dialogue.find(d=>d.id===option.properties.id.const);if(d){if(!compact.isCompactShot(execution)){option.properties.start={const:d.start};option.properties.end={const:d.end};}option.properties.listenerIds={const:d.listenerIds};option.properties.addressMode={const:d.addressMode};}}
 }
 return result;
}
const INSTRUCTION=require('./compact-screenplay').DIRECTOR_INSTRUCTION+'\nLEGACY INPUT: use the supplied original screenplay and immutable per-shot dialogue ledger when shotExecution is absent. A derived continuity plan is not source truth. Resolve current-shot facts before creating one shared execution timeline.';
const SCREENPLAY_CONVERSION_INSTRUCTION=require('./compact-screenplay').DIRECTOR_INSTRUCTION+'\nTIMED SOURCE INPUT: if the schema fixes explicit source duration or speech numbers, preserve those literals during conversion. Only the authorized source author changes a source clock. Do not mistake a previous director estimate for an explicit source clock. Consolidate source beats.action and dialogue.action once without omitting their prerequisites or executing neighboring beats.';
function validate(project,shot,item){
 const errors=[],suggestions=[],src=source(project,shot),knownChars=new Set((project.characters||[]).map(c=>c.id)),knownProps=new Set((project.assetLibraries?.props||[]).map(p=>p.id));
 const advise=(...messages)=>{if(!shot.shotExecution)suggestions.push(...messages);};
 const actions=project.filmContinuityPlan?.result?.shots.find(s=>s.shotId===shot.id)?.actions||[];
 for(const e of item.events||[])for(const id of e.throughoutDialogueIds||[]){const d=item.dialogue.find(d=>d.id===id);if(!d||e.start>d.start+.001||e.end<d.end-.001)advise(e.id+': review sustained action versus complete dialogue '+id);}
 for(const action of actions){const events=item.events.filter(e=>e.continuityActionIds?.includes(action.id));if(!events.length)advise('Review inferred continuity action '+action.id+' against original source before treating it as required');for(const e of events)for(const c of action.speechConstraints){const d=item.dialogue.find(d=>d.id===c.dialogueId);if(!d||(c.relation==='before'&&e.end>d.start+.001)||(c.relation==='after'&&e.start<d.end-.001)||(c.relation==='overlap'&&(e.start>=d.end||e.end<=d.start)))advise(e.id+': review source action '+action.id+' relation '+c.relation+' '+c.dialogueId);}}
 for(const e of item.events)if((e.continuityActionIds||[]).some(id=>!actions.some(a=>a.id===id)))errors.push(e.id+': unknown continuity action');
 const unique=(rows,label)=>{if(new Set(rows).size!==rows.length)errors.push(label+' has duplicate IDs');};
 if(item.shotId!==shot.id)errors.push('wrong shot ID');
 if(shot.shotExecution){
  const s=shot.shotExecution;
  for(const [key,value] of Object.entries({...(!compact.isCompactShot(s)?{duration:s.duration}:{}),visibleCharacterIds:s.visibleCharacterIds,visiblePropIds:s.propIds,productVisible:s.productVisible}))if(JSON.stringify(item[key])!==JSON.stringify(value))errors.push(`preserve authored screenplay ${key}; convert this shot, do not direct a different shot`);
  for(const d of s.dialogue){const delivered=item.dialogue.find(x=>x.id===d.id);if(delivered)for(const key of compact.isCompactShot(s)?['listenerIds','addressMode']:['start','end','listenerIds','addressMode'])if(JSON.stringify(delivered[key])!==JSON.stringify(d[key]))errors.push(`${d.id}.${key}: expected ${JSON.stringify(d[key])}; received ${JSON.stringify(delivered[key])}. Copy this authored screenplay field; preserve all other fields.`);}
  for(const [index,event] of item.events.entries())if(event.recordedSpeech){const ids=recordedDialogueIds(shot,event),live=ids.filter(id=>s.dialogue.some(d=>d.id===id&&d.onScreen===true));if(live.length||!ids.length)errors.push(`events[${index}].recordedSpeech: source dialogue ${live.join(', ')||'(no canonical playback IDs)'} is not authorized recording playback. Set this field to null; preserve the normal dialogue rows, exact words, times and live actions. throughoutDialogueIds links a sustained action to live speech. Do not rewrite the shot.`);}
 }
 if(!Number.isInteger(item.duration)||item.duration<10||item.duration>15)errors.push('duration must be an integer from 10 through 15 for the provider');
 unique(item.visibleCharacterIds,'cast');unique(item.visiblePropIds,'props');
 if(item.visibleCharacterIds.some(id=>!knownChars.has(id))||item.visiblePropIds.some(id=>!knownProps.has(id)))errors.push('unknown asset ID');
 if(JSON.stringify(item.states.map(s=>s.characterId).sort())!==JSON.stringify([...item.visibleCharacterIds].sort()))errors.push('state rows must match physical cast exactly');
 if(item.productVisible&&!project.product?.imagePath)advise('Upload the original product image before media generation; the written staging and product reference remain reviewable.');
 const events=new Map(item.events.map(e=>[e.id,e]));unique(item.events.map(e=>e.id),'events');
 for(const e of item.events){
  const offscreen=e.offscreenActorIds||[];unique(offscreen,e.id+' offscreen actors');
  for(const id of offscreen)if(!knownChars.has(id)||!e.actorIds.includes(id))errors.push(`${e.id}.offscreenActorIds: ${id} must be a known character also listed in actorIds, which includes ALL performers. Correct the two identity lists together; preserve this source action.`);
  for(const id of e.actorIds)if(!knownChars.has(id)||(!item.visibleCharacterIds.includes(id)&&!offscreen.includes(id)))errors.push(`${e.id}.actorIds: ${id} is not a selected visible performer. For a source-authored offscreen action, retain the known performer in actorIds AND offscreenActorIds. Otherwise use the correct known source performer; do not delete the source event to resolve an identity-list error.`);
  for(const id of e.propIds)if(!item.visiblePropIds.includes(id))errors.push(`${e.id}.propIds: ${id} is not in visiblePropIds. Use the declared source object identity; preserve the original physical action.`);
  const activeCameras=item.cameras.filter((c,i)=>c.at<e.end&&(item.cameras[i+1]?.at??item.duration)>e.start);
  if(activeCameras.some(c=>c.subjectIds.some(id=>offscreen.includes(id))))advise(e.id+': offscreen actor is selected by an active camera');
  if(e.usesProduct&&!item.productVisible)errors.push(e.id+': product event missing original-image selection');
  if(e.start<0||e.end<=e.start||e.end>item.duration)errors.push(e.id+': invalid event interval');
  for(const id of e.after){const prior=events.get(id);if(!prior||id===e.id)errors.push(e.id+': invalid prerequisite reference '+id);else if(prior.end>e.start+.001)advise(e.id+': review prerequisite '+id+' timing against the source');}
 }
 if(JSON.stringify(item.dialogue.map(t=>t.id))!==JSON.stringify(src.dialogue.map(t=>t.id)))errors.push('source dialogue IDs reordered or missing');
 for(const d of item.dialogue)if(!Number.isFinite(d.start)||!Number.isFinite(d.end)||d.start<0||d.end<=d.start||d.end>item.duration)errors.push(d.id+': dialogue interval must lie inside the submitted clip; preserve all words and let the Agent choose a feasible clip duration or timing');
 const turns=shot.dialogueTurns.map((t,i)=>({...t,start:item.dialogue[i]?.start,end:item.dialogue[i]?.end,startSecond:item.dialogue[i]?.start,endSecond:item.dialogue[i]?.end}));
 const recordedTurns=[];
 for(const e of item.events){const r=e.recordedSpeech;if(!r)continue;
  if(recordedDialogueIds(shot,e).length)continue;
  if(!src.dialogue.some(t=>t.speakerId===r.speakerId)||!r.textZh||!r.sourceQuoteZh?.includes(r.textZh)||!String(project.script?.raw||'').includes(r.sourceQuoteZh))errors.push(e.id+': recorded speech must quote original source and use an established voice');
  recordedTurns.push({sourceDialogueId:`REC:${e.id}`,speakerId:r.speakerId,text:r.textZh,start:e.start,end:e.end,startSecond:e.start,endSecond:e.end,onScreen:false,speechMode:'voiceover'});
 }
 const audible=[...turns,...recordedTurns].sort((a,b)=>a.start-b.start);
 if(JSON.stringify([...new Set(audible.map(t=>t.speakerId))])!==JSON.stringify([...new Set(src.dialogue.map(t=>t.speakerId))]))errors.push('recorded speech changes established first-vocal identity order');
 // Playback can contain source-authored expressive pauses. The live-reading
 // CPS estimate is advisory for a recording, not a provider wire constraint.
 // Still enforce its exact words, interval, clean edges and non-overlap.
 const timingFailures=shot.shotExecution?[]:require('./drama-performance-timeline').performanceTimelineFailures({duration:item.duration,dialogueTurns:audible},'');
 advise(...timingFailures.filter(f=>!recordedTurns.some(t=>f.startsWith(`${t.sourceDialogueId}: speech rate outside `))));
 if(!item.cameras.length||item.cameras[0].at!==0)errors.push('first camera must start at zero');
 item.cameras.forEach((c,i)=>{if(c.at>=item.duration||(i&&c.at<=item.cameras[i-1].at)||c.subjectIds.some(id=>!item.visibleCharacterIds.includes(id)))errors.push('camera references invalid time or physical cast');if(audible.some(t=>c.at>t.start+.02&&c.at<t.end-.02))advise('Review camera cut during speech; source-authorized continuous offscreen speech may legitimately cross a cut');});
 const prose=[item.environmentEn,...item.states.flatMap(s=>[s.openingEn,s.endingEn]),...item.events.map(e=>e.descriptionEn),...item.dialogue.map(d=>d.deliveryEn),item.summaryEn,item.soundscapeEn].join('\n');
 if(/[\u3400-\u9fff]/u.test(prose)||/<d>|<Subject|<Picture|\[Shot\s/i.test(prose))advise('Agent review: English narrative fields contain Chinese text or formatting tokens');
 if(item.identityContractVersion===1){const pattern=require('./production-identity-contract').narrativeSchema(project.assetLibraries?.props||[]).pattern;if(pattern&&!new RegExp(pattern).test(prose))advise('Agent review: check narrative object names against the structured identity references');}
 if(suggestions.length)item.programReviewSuggestions=suggestions;else delete item.programReviewSuggestions;
 if(errors.length)throw Object.assign(Error('Agent 返回的数据尚不能绑定执行，已保留结果'),{code:'AGENT_DECISION_CONFLICT',issues:errors,shotId:shot.id});
 return true;
}
function stamp(n){const ms=Math.round(n*1000);return `${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;}
function dialogueAddress(turn,decision){
 const mode=decision.addressMode||turn.addressMode,listeners=decision.listenerIds||turn.listenerIds||[],names=listeners.join(' and ');
 if(mode==='group')return 'addresses the source-authored group'+(names?`, including ${names}`:'');
 if(mode==='self')return 'speaks to oneself';
 if(mode==='offscreen')return 'addresses the off-screen recipient'+(names?` ${names}`:'');
 return names?'addresses '+names:'speaks';
}
function render(shot,item,lang='En'){
 const en=lang==='En',src=source({},shot),speakers=[...new Set(src.dialogue.map(t=>t.speakerId))];
 const opening=item['environment'+lang]+' '+item.states.map(s=>`${s.characterId}: ${s['opening'+lang]}`).join(' ');
 const ending=item.states.map(s=>`${s.characterId}: ${s['ending'+lang]}`).concat((item.objectStates||[]).map(s=>s['ending'+lang])).join(' ');
 const parts=[{at:0,order:0,line:`[Shot 1] ${en?'Opening state at 0 seconds:':'0秒初始状态：'} ${opening} ${en?'Only the tagged speaker performs speech lip-sync during that line; all others remain silent. Preserve every authored non-speech mouth action. Camera focus does not remove other source-present people from the scene.':'说话口型仅出现在各说话人的标记台词时段；保留制作方案中已写明的非说话嘴部动作。镜头重点人物不是排他人数表，其他在场人物保持原稿位置。'}`}];
 if(!item.dialogue.length)parts.push({at:0,order:0,line:en?`From 0 to ${item.duration} seconds, no one speaks; perform only the authored physical events without speech lip-sync.`:`从0秒至${item.duration}秒，没有对白，仅执行原稿动作，不做说话口型。`});
 item.cameras.forEach((c,i)=>parts.push({at:c.at,order:1,line:`${i?`[Shot ${i+1}] At ${stamp(c.at)}, `:''}${en?'Camera':'机位'}: ${c.size}, ${c.angle}, ${c.movement}; ${en?'camera focus':'镜头重点人物'}: ${c.subjectIds.join(', ')}.`}));
 for(const e of item.events){const offscreen=e.offscreenActorIds||[];parts.push({at:e.start,order:2,line:`${en?'Physical event':'动作'} ${e.id}, ${e.start}-${e.end} seconds: ${offscreen.length?(en?`Off-screen participants ${offscreen.join(', ')} remain outside the image; do not depict their bodies or add a revealing cut. `:`画外参与者${offscreen.join('、')}保持在画面外，不显示其身体，也不额外切镜揭示。`):''}${e['description'+lang]}`});}
 for(const e of item.events){const r=e.recordedSpeech;if(r&&!recordedDialogueIds(shot,e).length)parts.push({at:e.start,order:3,line:en?`From ${e.start} to ${e.end} seconds, ${r.speakerId} (S${speakers.indexOf(r.speakerId)+1}) speaks in voice-over from the in-scene recording exactly once: <d>[Chinese] ${r.textZh}</d> ${r.deliveryEn} No visible person performs speech lip-sync to the recorded voice; preserve authored non-speech mouth actions.`:`从${e.start}秒至${e.end}秒，场内录音以${r.speakerId}的声音仅播放一次：<d>[Chinese] ${r.textZh}</d> ${r.deliveryZh} 画面内真人不对录音做说话口型；保留方案已写明的非说话嘴部动作。`});}
 const playback=new Set(item.events.flatMap(e=>recordedDialogueIds(shot,e)));
 for(const state of item.objectStates||[])parts.push({at:0,order:0,line:state['opening'+lang]});
 item.dialogue.forEach((d,i)=>{const t=src.dialogue[i],off=!t.onScreen||/offscreen|voice.?over/.test(t.speechMode)||playback.has(t.id),viewer=t.directToViewer||t.addressMode==='viewer'||d.addressMode==='viewer',address=dialogueAddress(t,d);parts.push({at:d.start,order:3,line:`From ${d.start} to ${d.end} seconds, ${t.speakerId} (S${speakers.indexOf(t.speakerId)+1}) ${playback.has(t.id)?'speaks from the in-scene recording in voice-over exactly once':off?'remains off-screen and speaks in voice-over exactly once':viewer?'faces the viewer through the lens and says exactly once':address+' and says exactly once'}: <d>[Chinese] ${t.text}</d> ${d['delivery'+lang]}`});});
 parts.sort((a,b)=>a.at-b.at||a.order-b.order);parts.push({line:en?`After ${(item.dialogue.at(-1)?.end??0)} seconds, no additional live speech or speech lip-sync; continue the authored physical events to their ending states. ${ending}`:`${(item.dialogue.at(-1)?.end??0)}秒后不再有现场对白或说话口型；继续执行方案中已写明的动作直至结束状态。${ending}`});
 return parts.map(p=>p.line).join('\n');
}
function apply(project,shot,item,feedback=''){
 item=structuredClone(item);
 // Earlier continuity plans are hypotheses, not execution instructions. Only
 // the final Agent's explicit sustained-dialogue decision owns this relation.
 for(const event of item.events||[]){const constraints=(event.throughoutDialogueIds||[]).map(dialogueId=>({dialogueId,relation:'covers'}));if(constraints.length)event.speechConstraints=constraints;else delete event.speechConstraints;}
 let clockReceipt;
 // The provider takes whole seconds. Preserve every authored onset/ending;
 // quantize only the enclosing clip so rounding cannot shave the clean tail.
 validate(project,shot,item);
 const sourceHash=sourceFingerprint(project,shot);
 if(shot.finalPromptEditing)shot.finalPromptEditingHistory=[...(shot.finalPromptEditingHistory||[]),shot.finalPromptEditing];
 shot.duration=item.duration;shot.visibleCharacterIds=[...item.visibleCharacterIds];shot.characterIds=[...(shot.shotExecution?.characterIds||item.visibleCharacterIds)];
 shot.sourcePropBindings=shot.sourcePropBindings||(shot.propBindings||[]).filter(b=>b.source!=='agent-production-decision');
 shot.propBindings=item.visiblePropIds.map(propId=>({propId,source:'agent-production-decision'}));
 shot.productMention=item.productVisible||shot.productMention;
 shot.dialogueTurns=shot.dialogueTurns.map((t,i)=>({...t,start:item.dialogue[i].start,end:item.dialogue[i].end,startSecond:item.dialogue[i].start,endSecond:item.dialogue[i].end,deliveryEn:item.dialogue[i].deliveryEn,metadata:{...(t.metadata||{}),startSecond:item.dialogue[i].start,endSecond:item.dialogue[i].end,deliveryEn:item.dialogue[i].deliveryEn}}));
 // Old generated prose is superseded, retained in the decision history rather
 // than passed back to the reviewer as a second conflicting acting authority.
 shot.supersededActingHistory=[...(shot.supersededActingHistory||[]),{providerTimedDirections:shot.providerTimedDirections,actionEn:shot.actionEn,stateBeforeEn:shot.stateBeforeEn,stateAfterEn:shot.stateAfterEn}];
 shot.actionEn=item.events.map(e=>e.descriptionEn).join(' ');shot.stateBeforeEn=item.states.map(s=>`${s.characterId}: ${s.openingEn}`).join(' ');shot.stateAfterEn=item.states.map(s=>`${s.characterId}: ${s.endingEn}`).join(' ');
 shot.providerTimedDirections=item.events.map(e=>({start:e.start,end:e.end,actionEn:e.descriptionEn,actionZh:e.descriptionZh,actorIds:e.actorIds,propIds:e.propIds,usesProduct:e.usesProduct,after:e.after}));
 for(const turn of shot.dialogueTurns)for(const key of ['bodyEn','bodyZh','blockingEn','blockingZh','expressionEn','expressionZh','expressionArcEn','expressionArcZh','vocalArcEn','vocalArcZh','speakerFacingEn','speakerFacingZh','listenerReactionEn','listenerReactionZh']){delete turn[key];if(turn.metadata)delete turn.metadata[key];}
 shot.sourcePerformanceBudget={source:'master-agent-decision',requiredSeconds:item.duration,beforeSeconds:(item.dialogue[0]?.start??0),afterSeconds:item.duration-(item.dialogue.at(-1)?.end??0),duringSeconds:(item.dialogue.at(-1)?.end??0)-(item.dialogue[0]?.start??0)};
 shot.agentProductionDecision={version:VERSION,status:'authored',sourceFingerprint:sourceHash,...(shot.shotExecution?{storyContextVersion:1}:{}),feedbackFingerprint:feedback,item,...(clockReceipt?{clockReceipt}:{}),authoredAt:new Date().toISOString()};
 shot.finalPromptEditing={status:'authored',version:VERSION,renderVersion:RENDER_VERSION,source:'master-agent-decision',detailedDescriptionEn:render(shot,item),detailedDescriptionZh:render(shot,item,'Zh'),summaryEn:item.summaryEn,soundscapeEn:item.soundscapeEn,fingerprint:require('./h3-final-prompt-editor').fingerprint(shot),updatedAt:new Date().toISOString()};
 // Fingerprint only immutable source; timing, selected images and compiled
 // English are outputs, not a trigger for asking another writer to redo them.
 shot.agentProductionDecision.sourceFingerprint=sourceFingerprint(project,shot);
 shot.providerSemanticCompileSource='ai-batch';shot.promptCompilationPending=false;
 return shot;
}
async function authorRun({getProject,saveProject,generate,optionsFor,settings,projectId,shotIds,findingsByShot={},status=()=>{},runtimeRepairAttempted=false,shotRuntimeLimits={},concurrency=4,signal}){
 let p=getProject();const selected=new Set(shotIds||p.shots.map(s=>s.id));
 const vision=require('./product-visual-evidence'),visionProvider=require('./agent-stage-routing').resolveStageProvider(settings.textProvider,{agentStage:'planning'});
 if(p.product?.imagePath&&vision.supported(visionProvider)){
  const visualEvidence=await vision.observeProduct(p.product,(m,o)=>generate(settings.textProvider,m,optionsFor(projectId,'product_visual_evidence',{...o,signal})));
  require('./agent-stage-tasks').throwIfCancelled(signal);
  if(visualEvidence){const latest=getProject();if(latest.product?.imagePath===visualEvidence.sourcePath){latest.product={...latest.product,visualEvidence};saveProject(latest);}p=getProject();}
 }
 const sourceAuthored=require('./shot-screenplay').runtimeCurrent(p);
 const continuity=sourceAuthored?null:await require('./film-continuity-director').plan({getProject,saveProject,status,generate:(m,o)=>generate(settings.textProvider,m,optionsFor(projectId,'film_continuity_director',o))});p=getProject();
 let runtimePlan=null;
 if(p.script?.runtimePolicy&&!sourceAuthored){
  try{runtimePlan=await require('./film-runtime-director').plan({project:p,getProject,generate:(m,o)=>generate(settings.textProvider,m,optionsFor(projectId,'film_runtime_director_plan',o)),save:saveProject,status});}catch(error){if(error.code!=='FILM_RUNTIME_DIRECTOR_INFEASIBLE')throw error;status('时长规划意见已保留，继续由分镜 Agent 按原稿编排，供用户确认');}
  p=getProject();if(runtimePlan)shotRuntimeLimits={...Object.fromEntries(runtimePlan.shotBudgets.map(r=>[r.shotId,r.maxSeconds])),...(runtimePlan.settledSecondsByShot||{}),...shotRuntimeLimits};
 }
 findingsByShot=structuredClone(findingsByShot);
 const incompatibleReceipts=new Set();
 // Existing receipts may predate end-to-end validation. Revalidate locally;
 // only genuinely incompatible candidates return to their owning author.
 for(const shot of p.shots.filter(s=>selected.has(s.id)&&current(p,s))){
  try{validate(p,shot,structuredClone(shot.agentProductionDecision.item));}catch(error){incompatibleReceipts.add(shot.id);findingsByShot[shot.id]=[...(findingsByShot[shot.id]||[]),{code:'AGENT_DELIVERY_FIELD',issues:error.issues,previousDecision:shot.agentProductionDecision.item}];}
  const evidence=require('./production-delivery-contract').inspect(p,shot);
  if(!evidence.ok)findingsByShot[shot.id]=[...(findingsByShot[shot.id]||[]),{code:'PRODUCTION_DELIVERY_CONFLICT',...evidence}];
 }
 for(const shot of p.shots.filter(s=>selected.has(s.id)&&current(p,s))){
  const limit=shotRuntimeLimits[shot.id];if(!limit||shot.duration<=limit)continue;
  findingsByShot[shot.id]=[...(findingsByShot[shot.id]||[]),{code:'FILM_DIRECTOR_PERFORMANCE_PLAN',maxSeconds:limit,instruction:runtimePlan?.shotBudgets.find(r=>r.shotId===shot.id)?.performanceDirection,previousDecision:shot.agentProductionDecision.item}];
 }
 if(runtimePlan)saveProject(p);
 let materialized=false;
 for(const shot of p.shots)if(selected.has(shot.id)&&current(p,shot)&&!incompatibleReceipts.has(shot.id)&&(shot.finalPromptEditing?.renderVersion!==RENDER_VERSION||!require('./h3-final-prompt-editor').current(shot)||(shot.dialogueTurns||[]).some((t,i)=>{const d=shot.agentProductionDecision.item.dialogue[i];return t.startSecond!==d.start||t.endSecond!==d.end||t.metadata?.startSecond!==d.start||t.metadata?.endSecond!==d.end;}))){
  apply(p,shot,shot.agentProductionDecision.item,shot.agentProductionDecision.feedbackFingerprint);materialized=true;
 }
 if(materialized)saveProject(p);
 const feedback=s=>findingsByShot[s.id]?.length?hash(findingsByShot[s.id]):'';
 const pending=p.shots.filter(s=>selected.has(s.id)&&(!current(p,s)||(feedback(s)&&s.agentProductionDecision.feedbackFingerprint!==feedback(s))));
 const frozen=structuredClone(getProject()),batches=[],budgetConflicts=[],wholeSourceFingerprint=hash(frozen.shots.map(s=>source(frozen,s)));
 const batchSize=5;
 for(let i=0;i<pending.length;i+=batchSize)batches.push(pending.slice(i,i+batchSize).map(s=>s.id));
 let completedBatches=0;
 const parallelism=settings.textProvider?.localAgent?.id==='antigravity'?1:Math.min(4,Math.max(1,concurrency));
 await require('./preproduction-performance').mapBatches(batches,parallelism,async(batchIds,batchIndex)=>{
  const project=frozen,shots=batchIds.map(id=>project.shots.find(x=>x.id===id)),fingerprints=shots.map(s=>sourceFingerprint(project,s));
  const input={filmRuntimeBudget:project.script?.runtimePolicy?{...project.script.runtimePolicy,reservedSecondsByShot:shotRuntimeLimits,remainingShots:pending.length,instruction:"Each supplied per-shot maximum is an exclusive reservation shared by all parallel directors. Do not borrow another batch budget. Preserve source words; overlap independent actions only when source chronology allows. Frozen whole-film and neighbor source states are authoritative, never assume another worker will add a missing action."}:null,completeOriginalSource:project.script?.raw,product:{name:project.product?.name,sellingPoints:project.product?.sellingPoints,price:project.product?.price,offer:project.product?.offer,purchaseInstructions:project.product?.purchaseInstructions,visualEvidence:project.product?.visualEvidence,hasOriginalImage:Boolean(project.product?.imagePath)},characters:(project.characters||[]).map(c=>({id:c.id,name:c.name,gender:c.gender,age:c.age,role:c.role,description:c.description})),props:(project.assetLibraries?.props||[]).map(p=>({id:p.id,name:p.name,description:p.description})),wholeFilmSource:project.shots.map(s=>({id:s.id,sceneId:s.sceneId,action:s.action,stateBefore:s.stateBefore,stateAfter:s.stateAfter})),acceptedDecisions:project.shots.filter(s=>current(project,s)).map(s=>({shotId:s.id,visibleCharacterIds:s.agentProductionDecision.item.visibleCharacterIds,ending:s.agentProductionDecision.item.states.map(x=>({characterId:x.characterId,endingEn:x.endingEn}))})),neighborContracts:[...new Set(shots.flatMap(s=>{const i=project.shots.findIndex(x=>x.id===s.id);return [i-1,i+1].filter(j=>j>=0&&j<project.shots.length);}))].map(i=>{const s=project.shots[i];return {shotId:s.id,sceneId:s.sceneId,stateBefore:s.stateBefore,stateAfter:s.stateAfter,sourceAction:s.action,visibleCharacterIds:s.visibleCharacterIds,propBindings:s.propBindings};}),shots:shots.map(s=>({...source(project,s),maxExecutionSeconds:shotRuntimeLimits[s.id]||15,referenceSpeechGrid:!sourceAuthored&&(s.dialogueTurns||[]).length?require("./drama-performance-timeline").planPerformanceTimeline(s.dialogueTurns,shotRuntimeLimits[s.id]||10):null})),reviewFindings:shots.filter(s=>feedback(s)).map(s=>({shotId:s.id,issues:findingsByShot[s.id]}))};
  input.wholeFilmRuntimePlan=runtimePlan?.shotBudgets||[];
  input.characters=input.characters.map(c=>({...c,voiceDescription:project.characters.find(x=>x.id===c.id)?.voiceDescription,voiceDescriptionEn:project.characters.find(x=>x.id===c.id)?.voiceDescriptionEn}));
  // Shared generation requirements are supplied once in the stage system message.
  input.vocalIdentityContract='Translate each speaking character fixed vocal identity into clear English in its deliveryEn, separately from this line emotion. Preserve that identity across shots. Do not copy source suggestions for slurred, unintelligible, slow or murmured speech when they violate user requirements; request source repair. Never add a live voice to a silent character. Include fixed timbre/register/accent once per speaker in this clip, not a repeated utterance.';
  input.sceneContracts=sceneContracts(project);
  input.product.description=project.product?.description||'';
  input.product.visualEvidence=project.product?.visualEvidence||null;
  input.sharedPhysicalContinuity=continuity;
  input.continuityAuthority='This is a shared Agent-authored planning hypothesis, subordinate to the original screenplay. Reconcile persistent identities and physical states, but reject an inferred transition that changes this shot ending or performs a future scene early. Source synopsis is context, not permission to perform all film events in this shot. Use continuityActionIds only for source-valid actions actually performed here. Choose actual visibility from the source and camera; neither a suggested prop list nor a timing heuristic overrules your source-grounded judgment. Original dialogue and plot remain immutable.';
  input.deliveryContracts=shots.map(shot=>({shotId:shot.id,...require('./production-delivery-contract').guidance(project,shot)}));
  input.outputSeparation='summaryEn, soundscapeEn and all staging descriptions must contain only executable story-world content, never workflow diagnostics or claims about requested limits. If a reservation is infeasible, preserve every source action and return the shortest genuinely executable candidate; the coordinator will inspect its actual clocks and centrally replan rather than demand impossible movement.';
  if(sourceAuthored){
   input.storyContext={synopsis:project.script?.shotScreenplay?.document?.story?.synopsis||'',authority:'Read-only chronology background. The title is not a clock. Resolve this shot within the actual story sequence; never execute another scene here or introduce its props/dialogue.'};
   delete input.completeOriginalSource;delete input.wholeFilmSource;delete input.acceptedDecisions;delete input.filmRuntimeBudget;delete input.wholeFilmRuntimePlan;
   input.neighborContracts=[...new Set(shots.flatMap(s=>{const i=project.shots.findIndex(x=>x.id===s.id);return [i-1,i+1].filter(n=>n>=0&&n<project.shots.length);}))].map(n=>neighborContract(project.shots[n]));
   if(!shots.some(s=>s.shotExecution.productVisible))delete input.product;
   const ids=new Set(shots.flatMap(s=>s.shotExecution.characterIds));const propIds=new Set(shots.flatMap(s=>s.shotExecution.propIds));
   input.characters=input.characters.filter(c=>ids.has(c.id));input.props=input.props.filter(p=>propIds.has(p.id));input.sceneContracts=input.sceneContracts.filter(c=>shots.some(s=>s.sceneId===c.id));
   input.shots=input.shots.map(s=>{const execution=shots.find(x=>x.id===s.id).shotExecution;return {...s,shotExecution:execution,maxExecutionSeconds:compact.isCompactShot(execution)?15:execution.duration,referenceSpeechGrid:null};});
   input.outputSeparation='Only executable story-world content. This source already has its final performance schedule; no runtime reservation or central replanning is requested.';
   input.continuityAuthority='shotExecution is the accepted screenplay. Neighbor contracts are read-only continuity context.';
   input.screenplayAuthority='The writer has already directed this exact shot. Translate shotExecution into video prompt fields: preserve its duration, speech intervals, addressees, visible assets, product reference, beginning/end, chronological beats and camera intent. Do not split, merge, retime, invent connective actions or rewrite dialogue. Neighbor states are read-only context, never events to execute early. Each beat is a camera/physical instruction, not a second copy of dialogue.';
   input.screenplayAuthority+=' Scene identity fixes geography, not time of day: a reused scene can recur at night and the next morning. Preserve the current chronological phase and light from shotExecution, neighbors and storyContext. A generic reusable scene description must not turn continuous night action into dawn/daylight. If time is implicit, retain the established phase rather than guessing from the story title. Soundscape voice identities follow distinct source speaker IDs, never the number of dialogue utterances. Three lines by two people remain two voices. Preserve each concrete source sound emitter and trigger rather than replacing it with an ambiguous generic contact.';
  }
  const compactSource=sourceAuthored&&shots.every(s=>compact.isCompactShot(s.shotExecution));
  if(compactSource){
   input.outputSeparation='Compact source: author final timing and detailed staging; source duration is approximate. Preserve the exact words and plot. No workflow diagnostics in production text.';
   input.screenplayAuthority='shotExecution fixes story facts, participants and exact lines. It intentionally has no final dialogue clock, beats or camera plan. Direct only this shot, using neighbor contracts solely for continuity; do not borrow neighbor dialogue or events.';
   input.dialogueBoundaries=require('./dialogue-boundary-context').packet(project,batchIds,pending.map(s=>s.id),project.shots.filter(s=>current(project,s)&&!pending.some(t=>t.id===s.id)).map(s=>s.id));
  }
  if(sourceAuthored){
   input.shots=input.shots.map(require('./agent-speech-authority').directorShot);
   input.speechAuthority=require('./agent-speech-authority').INSTRUCTION;
   input.deliveryAuthority=require('./agent-speech-authority').DELIVERY_INSTRUCTION;
  }
  status(`逐镜转换视频提示词：${batchIndex+1}/${batches.length}，${shots.map(s=>s.id).join('、')}；最多 ${parallelism} 个任务同时运行`);
  let targets=shots,errors=[];
  for(let attempt=0;targets.length;attempt++){
    await new Promise(setImmediate);
   const task={...input,identityManifest:require('./production-identity-contract').manifest(project,sourceAuthored?input.props.map(p=>p.id):undefined),shots:input.shots.filter(s=>targets.some(t=>t.id===s.id)),...(attempt?{repairOnly:true,findings:errors,previousRejected:errors.map(e=>({shotId:e.shotId,item:e.item})),instruction:'Repair ONLY these rejected shot decisions. Preserve source words, actors, actions and causal relationships. Use the reference speech grid and realistic concise action durations. Keep accepted shots untouched. Numeric solving failed because the proposed physical durations/relations cannot fit simultaneously; do not merely repeat them.'}:{})};
   const responseItems=[];
   for(const scope of attempt<2?[targets]:targets.map(t=>[t])){
    require('./agent-stage-tasks').throwIfCancelled(signal);
    const ids=new Set(scope.map(s=>s.id));
    const scoped={...task,shots:task.shots.filter(s=>ids.has(s.id)),findings:(task.findings||[]).filter(f=>ids.has(f.shotId)),previousRejected:(task.previousRejected||[]).filter(f=>ids.has(f.shotId)),recoveryStrategy:attempt<2?'targeted_patch':'isolated_source_reconciliation'};
    if(sourceAuthored&&!compactSource&&attempt)scoped.instruction='Repair only the reported delivery fields of this one shot. Its canonical words, duration, speech intervals, identities and causal beats are fixed; do not infer a timing defect from an unrelated error.';
    if(compactSource&&attempt)scoped.instruction='Repair only actual reported fields and their necessary dependencies. Preserve exact source words, speakers, causality and visible assets. You own the detailed performance timing; never infer a missing source timing field is an error.';
    if(attempt>=2&&!sourceAuthored)scoped.instruction='Reconcile this ONE unresolved shot from the original source and its fixed neighbors. Diagnose the actual reported field/identity/delivery conflict first. Do not assume every exception is a timing defect. Preserve exact words and causal actions; reconstruct only this decision, retaining accepted shots. Use an empty dialogue list for source-confirmed silent action, with complete timed physical events.';
    if(attempt>0)scoped.agentRepairPlan=await require('./agent-repair-director').plan({source:sourceAuthored?JSON.stringify({shots:scope.map(s=>s.shotExecution),neighbors:input.neighborContracts,storyContext:input.storyContext}):project.script?.raw||'',findings:scoped.findings,groups:scope.map(s=>({shotId:s.id})),draft:scoped.previousRejected||[],generate:(m,o)=>generate(settings.textProvider,m,optionsFor(projectId,o.stage,o))});
    const patcher=require('./agent-decision-patch'),baseItems=scope.map(s=>errors.find(e=>e.shotId===s.id)?.item||s.agentProductionDecision?.item);
    const patchable=sourceAuthored&&baseItems.every(Boolean)&&scope.every(s=>errors.some(e=>e.shotId===s.id)||(feedback(s)&&current(project,s)));
    let r;
    if(patchable){
     const bases=baseItems.map(patcher.wire),decisionSchema=schema(project,scope),request={screenplay:scope.map(s=>s.shotExecution),speechMeasurements:scope.map(s=>({shotId:s.id,lines:require('./agent-speech-authority').measurements(s.shotExecution.dialogue)})),neighbors:input.neighborContracts,storyContext:input.storyContext,baseItems:bases,findings:scoped.findings.length?scoped.findings:input.reviewFindings};
     if(compactSource)request.dialogueBoundaries=input.dialogueBoundaries;
     const delta=await generate(settings.textProvider,[{role:'system',content:patcher.INSTRUCTION+'\n'+require('./agent-speech-authority').INSTRUCTION+(compactSource?'\n'+require('./dialogue-boundary-context').INSTRUCTION:'')},{role:'user',content:JSON.stringify(request)}],optionsFor(projectId,'master_production_decision_patch',{agentStage:'planning',json:true,requiredKeys:['items'],responseSchema:patcher.schema,deliveryPreview:{kind:'master-production-patch',project:{...project,shots:scope},baseItems:bases,decisionSchema},maxAttempts:1,maxTokens:12000,sessionId:'decision-patch-'+hash({projectId,request}).slice(0,32)}));
     r=patcher.apply(bases,delta,decisionSchema);
    }else r=await generate(settings.textProvider,[{role:'system',content:(compactSource?compact.DIRECTOR_INSTRUCTION:sourceAuthored?SCREENPLAY_CONVERSION_INSTRUCTION+"\n"+require("./screenplay-execution-authority").CONTACT_CONTINUITY:INSTRUCTION)+'\n'+require('./production-identity-contract').INSTRUCTION},{role:'user',content:JSON.stringify(scoped)}],optionsFor(projectId,'master_production_decisions',{agentStage:'planning',json:true,requiredKeys:['items'],responseSchema:schema(project,scope),deliveryPreview:{kind:"master-production-decision",project:{...project,shots:scope}},allowPartialItems:true,maxAttempts:1,maxTokens:32000}));
    responseItems.push(...(r.items||[]).filter(row=>ids.has(row.shotId)));
   }
   const result={items:responseItems};
   const latest=getProject();latest.agentProductionDecisionAttempts=[...(latest.agentProductionDecisionAttempts||[]),{at:new Date().toISOString(),repair:attempt>0,shotIds:targets.map(s=>s.id),sourceFingerprints:targets.map(s=>fingerprints[shots.findIndex(x=>x.id===s.id)]),result}];
   if((!sourceAuthored&&(hash(latest.shots.map(s=>source(latest,s)))!==wholeSourceFingerprint||hash(latest.script?.runtimePolicy||null)!==hash(frozen.script?.runtimePolicy||null)))||targets.some(target=>{const shot=latest.shots.find(s=>s.id===target.id);return !shot||sourceFingerprint(latest,shot)!==fingerprints[shots.findIndex(s=>s.id===target.id)];})){saveProject(latest);throw Object.assign(Error('生成期间当前镜头或其衔接资料已变化，旧结果已保留为历史，不覆盖新版本。'),{code:'AGENT_SOURCE_CHANGED'});}
   errors=[];
   for(const target of targets){const shot=latest.shots.find(s=>s.id===target.id),rows=result.items?.filter(r=>r.shotId===shot.id)||[];
    try{
     if(sourceFingerprint(latest,shot)!==fingerprints[shots.findIndex(s=>s.id===shot.id)])throw Error('source changed during authoring');
     if(rows.length!==1)throw Error('one decision per shot required');
     const requiredProps=continuity?.shots.find(s=>s.shotId===shot.id)?.visiblePropIds||[];
     // Visibility is decided by the director; a planning hypothesis is not a veto.
     const candidate=structuredClone(shot),limit=shotRuntimeLimits[shot.id];apply(latest,candidate,rows[0],feedback(shot));
     if(limit&&candidate.duration>limit){
      budgetConflicts.push({shotId:shot.id,requestedSeconds:limit,validCandidateSeconds:candidate.duration,sourceAction:shot.action,reason:'Agent performance exceeds its planning estimate; preserve the authored timing for Agent review.'});
     }
     const deliveryProject={...latest,shots:latest.shots.map(s=>s.id===candidate.id?candidate:s)};
     candidate.productionDeliveryReceipt=require('./production-delivery-contract').assert(deliveryProject,candidate);
     Object.assign(shot,candidate);
    }catch(error){errors.push({shotId:shot.id,message:error.message,issues:error.issues,deliveryEvidence:error.deliveryEvidence,item:rows[0]});}
   }
   saveProject(latest);targets=targets.filter(s=>errors.some(e=>e.shotId===s.id));
  }
  if(errors.length)throw Object.assign(Error('主Agent制作方案仍有真实执行冲突；完成项及单次定点修复记录已保留'),{code:'AGENT_DECISION_CONFLICT',findings:errors.map(({item,...e})=>e)});
  completedBatches++;status(`并行分镜提示词已保存 ${completedBatches}/${batches.length} 批；本批 ${batchIds.join('、')}，其他子任务继续执行`);
 },{signal});
 const finished=getProject();
 if(finished.script?.runtimePolicy&&finished.shots.every(s=>current(finished,s))) {
  if(finished.script.directorRuntimePlan){finished.script.directorRuntimePlan.settledSecondsByShot=Object.fromEntries(finished.shots.map(s=>[s.id,s.duration]));finished.script.directorRuntimePlan.settledTotalSeconds=finished.shots.reduce((n,s)=>n+s.duration,0);}
  finished.script.directorRuntimeConflicts=budgetConflicts;saveProject(finished);
 }
 return getProject();
}
const projectQueues=new Map();
async function author(options){
 const key=options.projectId||options.getProject,prior=projectQueues.get(key)||Promise.resolve();
 const running=prior.catch(()=>{}).then(()=>authorRun(options));projectQueues.set(key,running);
 try{return await running;}finally{if(projectQueues.get(key)===running)projectQueues.delete(key);}
}
module.exports={VERSION,INSTRUCTION,source,sourceFingerprint,actingInputsUnchanged,current,schema,validate,render,apply,author,recordedDialogueIds};
