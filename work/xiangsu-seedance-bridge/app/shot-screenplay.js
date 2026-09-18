'use strict';
// One Agent-authored, ordered source. Rendering and database projection never
// infer a scene boundary, rewrite speech, choose a holder, or add a camera.
const crypto=require('node:crypto');
const VERSION='shot-screenplay-v17-generation-methods';
const compact=require('./compact-screenplay');
// Database persistence sorts object keys; that is not a content edit.
// Array order remains significant for dialogue, beats and shots.
const hash=require('./foundry/canonical').fingerprint;
const text={type:'string'},requiredText={type:'string',minLength:1};
const obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const arr=(items,minItems=0)=>({type:'array',items,minItems});
const ids=arr(requiredText);
const entity={id:requiredText,name:requiredText,description:text,descriptionEn:text,assetRequired:{type:'boolean'}};
const dialogue=obj({id:requiredText,speakerId:requiredText,listenerIds:ids,addressMode:{enum:['person','group','viewer','self','offscreen']},onScreen:{type:'boolean'},text:requiredText,delivery:{...requiredText,description:'Line emotion and clear performance. Plan ordinary speech at 5–6 effective Chinese characters/sec and angry/hostile-questioning/accusatory speech at least 8. No slurred diction, stretched sounds, extra interjections or repeated speech.'},action:requiredText,start:{type:'number',minimum:0},end:{type:'number',minimum:0}});
const beat=obj({id:requiredText,start:{type:'number',minimum:0},end:{type:'number',minimum:0},camera:requiredText,action:requiredText,dialogueIds:ids});
const LEGACY_SHOT=obj({id:requiredText,sceneId:requiredText,duration:{type:'integer',minimum:10,maximum:15},characterIds:ids,visibleCharacterIds:ids,propIds:ids,wardrobeBindings:arr(obj({characterId:requiredText,wardrobeId:requiredText})),productVisible:{type:'boolean'},productAction:text,opening:requiredText,dialogue:arr(dialogue),beats:arr(beat,1),ending:requiredText,transition:requiredText,sound:{...requiredText,description:'Only actual non-vocal ambience and source-motivated physical sound. All speech occurs exactly once in dialogue; no crowd murmurs, sigh syllables, throat clearing, false starts or repeated quotations.'}});
const LEGACY_SCHEMA=obj({
 story:obj({title:requiredText,synopsis:requiredText,ending:requiredText}),
 characters:arr(obj({...entity,age:text,gender:text,role:text,voiceDescription:{...text,description:'Only fixed natural vocal identity: age, timbre, register and accent. Do not include speaking pace, slowing down, mumbling, slurring or line emotion; those belong to dialogue.delivery under the mandatory timing policy.'},roleType:text,voiceAssetRequired:{type:'boolean'}})),
 scenes:arr(obj({...entity,interiorExterior:text,time:text,layout:text,lighting:text,axis:text}),1),
 props:arr(obj({...entity,holder:text,purpose:text,units:ids})),
 wardrobes:arr(obj({...entity,characterId:requiredText,units:ids})),
 shots:arr(LEGACY_SHOT,1)
});
const SHOT=compact.SHOT,SCHEMA=structuredClone(compact.SCHEMA);
SCHEMA.properties.adaptation=obj({title:requiredText,kernel:requiredText,ending:requiredText,replacements:arr(obj({kind:requiredText,from:requiredText,to:requiredText,linkedChanges:text})),productName:text,productLocks:arr(obj({kind:requiredText,quote:requiredText})),warnings:arr(text),beats:arr(obj({id:requiredText,cause:requiredText,event:requiredText,result:requiredText,sourceIds:ids,productBridge:text}))});
LEGACY_SCHEMA.properties.adaptation=SCHEMA.properties.adaptation;
const RULES=compact.RULES;
const REVIEW_RULES=compact.REVIEW_RULES;
const REVIEW_SCHEMA=obj({ok:{type:'boolean'},checks:arr(obj({shotId:requiredText,evidence:requiredText}),1),issues:arr(obj({shotIds:ids,field:requiredText,evidence:requiredText,repair:requiredText})),sourcePreserved:{type:'boolean'},storyComplete:{type:'boolean'}});
function reviewSchemaFor(document){
 const schema=structuredClone(REVIEW_SCHEMA);
  schema.properties.advisories=require('./screenplay-review-evidence-scope').ADVISORIES;
 // Each source identity has one explicit slot. An array can have the right
 // length while silently repeating a shot and omitting another.
 schema.properties.checks=obj(Object.fromEntries(document.shots.map(s=>[s.id,obj({evidence:requiredText})])));
 if(compact.isCompact(document)){
  schema.properties.criteria=obj(Object.fromEntries(['story','commerce','dialogue'].map(key=>[key,obj({passed:{type:'boolean'},evidence:requiredText})])));
  schema.required.push('criteria');
 }
 return schema;
}
const AUTHORING_DISCIPLINE='保持全片事实、人物身份、全部对白及动作因果。逐镜只交付简洁剧情；详细时间轴、机位和视频表演由下游逐镜Agent完成。';
function schemaFor(mode,runtimePolicy){
 const schema=structuredClone(SCHEMA);
 if(mode==='adapt')schema.required.push('adaptation');
 // Runtime is writing guidance for the Agent, never a transport rejection for a complete story.
 // A slightly shorter or longer story must not cause the entire payload to be resubmitted.
 return schema;
}

function issues(document){
 if(!require('./typed-output-receipt').conforms(document,compact.isCompact(document)?SCHEMA:LEGACY_SCHEMA))return ['Return the complete structured screenplay using the supplied schema; keep the captured draft.'];
 const errors=[];
 const sets={};
 for(const key of ['characters','scenes','props','wardrobes','shots']){
  sets[key]=new Set((document[key]||[]).map(x=>x.id));
  if(sets[key].size!==(document[key]||[]).length)errors.push(`${key}: duplicate IDs`);
 }
 const allDialogue=new Set();
 for(const s of document.shots){
  const bad=message=>errors.push(`${s.id}: ${message}`);
  if(!sets.scenes.has(s.sceneId))bad('unknown sceneId');
  for(const [key,kind] of [['characterIds','characters'],['visibleCharacterIds','characters'],['propIds','props']])if(new Set(s[key]).size!==s[key].length||s[key].some(id=>!sets[kind].has(id)))bad(`unknown or duplicate ${key}`);
  if(s.visibleCharacterIds.some(id=>!s.characterIds.includes(id)))bad('visible actors must also be present in characterIds');
  for(const w of s.wardrobeBindings||[])if(!sets.characters.has(w.characterId)||!sets.wardrobes.has(w.wardrobeId))bad('unknown wardrobe binding');
  for(const d of s.dialogue){
   if(allDialogue.has(d.id))bad(`duplicate dialogue ID ${d.id}`);allDialogue.add(d.id);
   if(!s.characterIds.includes(d.speakerId)||d.listenerIds.some(id=>!sets.characters.has(id)))bad(`unknown dialogue participant ${d.id}`);
   if(!compact.isCompact(document)&&(d.end<=d.start||d.end>s.duration))bad(`dialogue ${d.id} interval outside its clip`);
  }
  if(!compact.isCompact(document)){
  const assigned=s.beats.flatMap(b=>b.dialogueIds);
  if(JSON.stringify(assigned)!==JSON.stringify(s.dialogue.map(d=>d.id)))bad('beat dialogue references must cover every original line exactly once in its original order');
  if(new Set(s.beats.map(b=>b.id)).size!==s.beats.length)bad('duplicate beat IDs');
  for(const b of s.beats)if(b.end<=b.start||b.end>s.duration)bad(`beat ${b.id} interval outside its clip`);
  }
 }
 return errors;
}
function render(doc){
 if(compact.isCompact(doc))return compact.render(doc);
 const name=(key,id)=>doc[key].find(x=>x.id===id)?.name||id;
 const rows=[`分镜脚本：《${doc.story.title}》`,doc.story.synopsis,`共${doc.shots.length}个片段，总时长${doc.shots.reduce((n,s)=>n+s.duration,0)}秒。`,'人物表：',...doc.characters.map(c=>`@${c.name}（${c.role}；${c.description}；固定声线：${c.voiceDescription}）`),'场景表：',...doc.scenes.map(s=>`@${s.name}：${s.layout}；${s.time}；${s.lighting}`),'[全局执行规则]：无字幕、无文字叠加、无水印、无背景音乐；保留对白和真实音效，商品使用原图。'];
 if(doc.props.length)rows.push('道具表：',...doc.props.map(p=>`@${p.name}：${p.description}；用途：${p.purpose}`));
 if(doc.wardrobes.length)rows.push('换装表：',...doc.wardrobes.map(w=>`@${w.name}：@${name('characters',w.characterId)}；${w.description}`));
 for(const s of doc.shots){
  rows.push('',`片段${s.id}｜${s.duration}秒`,'[出镜角色-物品-场景]：',`人物：${s.visibleCharacterIds.map(id=>'@'+name('characters',id)).join('，')||'无'}`,`场景：@${name('scenes',s.sceneId)}`,`物品：${s.propIds.map(id=>'@'+name('props',id)).concat(s.productVisible?['@商品原图']:[]).join('，')||'无'}`,`角色-声线绑定：${s.characterIds.map(id=>{const c=doc.characters.find(c=>c.id===id);return `@${c.name}｜${c.voiceDescription}`;}).join('；')}`,`[起始状态]：${s.opening}`);
  if(s.wardrobeBindings.length)rows.push(`[服装绑定]：${s.wardrobeBindings.map(w=>`@${name('characters',w.characterId)}穿@${name('wardrobes',w.wardrobeId)}`).join('；')}`);
  for(const b of s.beats){
   rows.push(`[${b.start}–${b.end}秒]【${b.id}·${b.camera}】${b.action}`);
   for(const id of b.dialogueIds){const d=s.dialogue.find(d=>d.id===id),listener=d.addressMode==='viewer'?'观众':d.addressMode==='self'?'自己':d.listenerIds.map(id=>'@'+name('characters',id)).join('、')||'画外对象';rows.push(`@${name('characters',d.speakerId)}（${d.start}–${d.end}秒；对${listener}；${d.onScreen?'现场出镜':'画外发声'}；${d.delivery}；${d.action}）：${d.text}`);}
  }
  if(s.productVisible)rows.push(`[商品与剧情]：${s.productAction}`);
  rows.push(`[音效]：${s.sound}`,`[结束状态]：${s.ending}`,`[衔接]：${s.transition}`);
 }
 return rows.join('\n');
}
function current(record,source){return record?.version===VERSION&&record.requirementsVersion===require('./production-content-requirements').VERSION&&record.status==='ready'&&record.sourceHash===hash(source)&&record.documentHash===hash(record.document)&&!issues(record.document).length;}
function hasSavedDraft(script){
 const record=script?.shotScreenplay,source=String(script?.raw||'');
 return !!source.trim()&&record?.sourceHash===hash(source)&&!!record.document&&!issues(record.document).length;
}
function makeRecord(document,source,review,mode='original'){
 return {version:VERSION,requirementsVersion:require('./production-content-requirements').VERSION,hashAlgorithm:'canonical-json-sha256-v1',status:'ready',sourceHash:hash(source),documentHash:hash(document),document:structuredClone(document),review:structuredClone(review),mode,createdAt:new Date().toISOString()};
}
function projectData(record){
 // Runtime asset design and media state must never mutate the accepted source.
 const d=structuredClone(record.document);
 const document={version:require('./agent-production-document').VERSION,shots:d.shots.map(s=>({shotId:s.id,scene:d.scenes.find(x=>x.id===s.sceneId).name,action:compact.isCompact(d)?s.action:s.beats.map(b=>`[${b.start}–${b.end}秒] ${b.camera}：${b.action}`).join('\n'),stateBefore:s.opening,continuity:s.ending,dialogueTurns:s.dialogue.map(t=>({...t,sourceDialogueId:t.id,sourceShotId:s.id,speaker:d.characters.find(c=>c.id===t.speakerId).name,speakerName:d.characters.find(c=>c.id===t.speakerId).name,spokenText:t.text,sourceTone:t.delivery,tone:t.delivery,startSecond:t.start,endSecond:t.end})),shotExecution:structuredClone(s)}))};
 const delivery={...d,wardrobes:d.wardrobes||[],bindings:d.shots.map(s=>({shotId:s.id,sceneId:s.sceneId,characterIds:s.characterIds,visibleCharacterIds:s.visibleCharacterIds,propIds:s.propIds,productVisible:s.productVisible,productReason:s.productAction,wardrobeBindings:s.wardrobeBindings||[],speakers:s.dialogue.map(t=>({dialogueId:t.id,characterId:t.speakerId,onScreen:t.onScreen}))}))};
 const budgets=d.shots.map(s=>({shotId:s.id,requiredSeconds:s.duration,source:'shot-screenplay'}));
 const data=require('./agent-production-document').projectData(document,delivery,budgets);
 for(const shot of data.shots){const s=d.shots.find(s=>s.id===shot.id);shot.stateBefore=s.opening;shot.stateAfter=s.ending;shot.sound=s.sound;shot.transitionToNext=s.transition;shot.shotExecution=structuredClone(s);shot.shotExecutionVersion=VERSION;shot.shotExecutionFingerprint=hash(s);}
 return data;
}
function runtimeCurrent(project){
 if(!current(project.script?.shotScreenplay,project.script?.raw||'')||project.shots?.length!==project.script.shotScreenplay.document.shots.length)return false;
 return project.shots.every((s,i)=>{
  const e=project.script.shotScreenplay.document.shots[i];
  return s.id===e.id&&s.sceneId===e.sceneId&&s.shotExecutionFingerprint===hash(e)&&hash(s.shotExecution)===hash(e)
   &&JSON.stringify((s.dialogueTurns||[]).map(t=>({id:t.sourceDialogueId||t.id,speakerId:t.speakerId,text:t.text||t.spokenText})))===JSON.stringify(e.dialogue.map(t=>({id:t.id,speakerId:t.speakerId,text:t.text})));
 });
}
async function author({source='',topic=null,product={},mode='original',instructions='',runtimePolicy=null,reviewExecution=null,deferReview=null,generate,checkpoint,draftDocument=null,preparedText='',reviewFeedback=null,save=()=>{},status=()=>{},signal}){
 if(runtimePolicy?.kind==='adaptation'){const resolved=await require('./adaptation-runtime-evidence').resolve({source,contract:runtimePolicy,execution:reviewExecution,checkpoint,generate,signal,save:runtimeEstimate=>{checkpoint={...checkpoint,runtimeEstimate};save(checkpoint);}});Object.assign(runtimePolicy,resolved);}
 const writingScale=mode==='original'&&runtimePolicy?{scope:'planning guidance, not a fixed shot-count gate',suggestedShots:Math.ceil(runtimePolicy.targetSeconds/15),targetSeconds:runtimePolicy.targetSeconds,dialogueTimingGuidance:'按真实对白时窗安排：普通对白5–6有效中文字/秒，愤怒质问等至少8字/秒；各镜及跨镜无人说话间隔不超过3秒，不能用全片平均字数代替逐句安排。',instruction:'一次写完包括结尾在内的全部片段，不是只写第一场的若干镜头。每镜优先用人物对话推进；第一镜前8秒必须出现具体、可见的强烈冲突或反转爆点，并建立人物关系，不用数镜无对白气氛铺垫。'}:null;
 const input={version:VERSION,requirementsVersion:require('./production-content-requirements').VERSION,reviewExecution,mode,source,topic,product,...(instructions?{instructions}:{}),...(reviewFeedback?{reviewFeedback}:{}),runtimePolicy:require('./film-runtime-policy').agentPolicy(runtimePolicy),writingScale,authoringDiscipline:AUTHORING_DISCIPLINE,productClaimAuthority:require('./product-claim-authority').packet(product)};const signature=hash(input);
 let state=checkpoint?.signature===signature?structuredClone(checkpoint):{signature,attempts:[],reviews:[],document:null,status:'writing'};
 // Prompt/version drift must not erase a complete checkpoint. Re-review it
 // against current input; only a deliberate new creative request starts over.
 const sourceIdentity=hash({mode,source,topic,product,...(instructions?{instructions}:{})});
 if(!state.writerText&&(preparedText||(checkpoint?.sourceIdentity===sourceIdentity&&checkpoint.writerText))){state.writerText=preparedText||checkpoint.writerText;state.status='structuring';}
 if(!state.document&&checkpoint?.sourceIdentity===sourceIdentity&&checkpoint.document?.shots?.length){
  state.document=structuredClone(checkpoint.document);state.status='reviewing';
  state.deliveryIssues=issues(state.document);
  state.attempts=[...(checkpoint.attempts||[]),{stage:'recover_checkpoint_for_review',at:new Date().toISOString()}];
  state.reviews=structuredClone(checkpoint.reviews||[]);
  state.history=structuredClone(checkpoint.history||[]);
  state.lastChangedShotIds=[...(checkpoint.lastChangedShotIds||[])];
  // Individual review receipts carry exact assembled-input hashes. Retain
  // them through migration; the coordinator reuses only matching requests.
  if(checkpoint.reviewPartitions)state.reviewPartitions=structuredClone(checkpoint.reviewPartitions);
  // Finish accepting an already authored repair before re-reviewing current policy.
  if(checkpoint.activeAudit&&(checkpoint.pendingRepairPatch||checkpoint.repairDeliveryIssues?.length)){state.activeAudit=structuredClone(checkpoint.activeAudit);state.repairDeliveryIssues=structuredClone(checkpoint.repairDeliveryIssues||[]);if(checkpoint.pendingRepairPatch)state.pendingRepairPatch=structuredClone(checkpoint.pendingRepairPatch);}

 }
 state.sourceIdentity=sourceIdentity;state.runtimeEstimate=checkpoint?.runtimeEstimate||state.runtimeEstimate;state.runtimePolicy=runtimePolicy;
 // Old persistence fingerprints may be invalid while a complete draft is
 // intact. The Agent rechecks that draft against the source before acceptance;
 // a format migration alone must not start another whole-film writer.
 if(!state.document&&draftDocument?.shots?.length){state.document=structuredClone(draftDocument);state.deliveryIssues=issues(state.document);state.status='reviewing';state.attempts.push({stage:'recover_draft_for_review',at:new Date().toISOString()});}
 save(state);
 const call=async(stage,messages,responseSchema,deliveryPreview)=>{
  require('./agent-stage-tasks').throwIfCancelled(signal);
   const progressiveDelivery=stage==='write'||stage==='repair';
   const requestHash=hash({stage,messages,responseSchema,progressiveDelivery,...(deliveryPreview?{deliveryPreview}:{})});
  if(state.pendingRequest?.requestHash!==requestHash){state.requestNumber=(state.requestNumber||0)+1;state.pendingRequest={requestHash,sessionId:`shot-script-${signature.slice(0,20)}-${state.requestNumber}-${stage}`};save(state);}
   const reviewing=stage==='review'||stage==='review_findings'||stage==='localize_findings';
   const result=await require('./audit-progress').request({journal:state.receiptJournal||={},stage,messages,schema:responseSchema,save:()=>save(state),generate:(requestMessages)=>generate(requestMessages,{json:true,requiredKeys:responseSchema.required,responseSchema,progressiveDelivery,...(deliveryPreview?{deliveryPreview}:{}),maxAttempts:1,maxTokens:reviewing?22000:60000,agentStage:reviewing?'review':'writing',stage:`shot_screenplay_${stage}`,sessionId:state.pendingRequest.sessionId,signal})});
  delete state.pendingRequest;save(state);return result;
 };
 if(state.status==='ready'&&state.document&&!issues(state.document).length)return {...state,text:render(state.document)};
 for(;;){
  // A persistence/receipt transition must never starve cancellation, IPC or
  // other projects, even when a completed request is immediately reusable.
  await new Promise(setImmediate);
  require('./agent-stage-tasks').throwIfCancelled(signal);
  if(!state.document||!Array.isArray(state.document.shots)||!state.document.shots.length||(state.writerText&&state.status==='structuring')){
   status(state.document?'Agent 正在修复逐镜数据交付，原稿与完成镜头保留':'正在一次写出完整逐镜剧本，提前确定对白、动作、资产和衔接');
   let draft=null;
   try{
    draft=await require('./screenplay-stage-separation').prepare({state,input,schema:schemaFor(mode,runtimePolicy),generate,save,status,signal,issues});
   }catch(error){
    // T07/§7.5: the paid structure-repair budget is capped (2 per prepare).
    // Exhaustion must not discard the saved draft: inside the authoring flow
    // the saved document plus its intake issues continue into the LOCAL
    // protocol-repair path below (no writer restart, no new paid intake).
    if(error?.code==='REPAIR_BUDGET_EXHAUSTED'&&state.document?.shots?.length){
     state.deliveryIssues=Array.isArray(state.intakeIssues)&&state.intakeIssues.length?state.intakeIssues.slice():issues(state.document);
     state.status='reviewing';save(state);
     await new Promise(setImmediate);continue;
    }
    throw error;
   }
   state.document=draft;state.status='reviewing';state.deliveryIssues=issues(draft);state.attempts.push({stage:'write',issues:state.deliveryIssues,at:new Date().toISOString()});save(state);
   if(state.deliveryIssues.length){await new Promise(setImmediate);continue;}
  }
  // Semantic audits belong to the complete prompt-confirmation document.
  // Preserve a previous unfinished review/patch as evidence; never restart a
  // writer solely because an old content receipt was negative.
  const shouldDefer = deferReview !== false && !reviewFeedback && !state.activeAudit;
  if(shouldDefer && !state.deliveryIssues?.length){
   state.contentReview=require('./text-review-policy').deferred(state.activeAudit||state.reviews?.at(-1));
   state.status='ready';state.documentComplete=true;state.completedAt=new Date().toISOString();state.text=render(state.document);
   save(state);status('完整逐镜稿已保存，内容审核将在全部提示词完成后的确认页内执行');return state;
  }
  const deliveryRepair=Boolean(state.deliveryIssues?.length);
  // A protocol repair request has no creative verdict. Route it to the Agent
  // repair below, then require the normal independent content review.
  if(deliveryRepair)state.activeAudit={kind:'delivery_repair',ok:false,issues:state.deliveryIssues.map(e=>({shotIds:state.document.shots.map(s=>s.id),field:'deliveryReferences',evidence:e,repair:'Correct only the referenced data fields. Preserve all unaffected source words and shots.'}))};
  status('审核 Agent 复用完整简稿核对对白、动作、商品事实；有冲突才修订相关片段');
  let audit=state.activeAudit;
  if(!audit){
  const reviewMessages=[{role:'system',content:REVIEW_RULES+'\nchecks是以实际shotId为键的对象，每个键下填写evidence。按工具给出的完整键表逐项交付，不能用重复镜号凑数量。storyComplete只判断全片是否确实写到结局并覆盖要求，不能因局部动作错就判故事缺页。若只交付开头或遗漏后半剧情，storyComplete=false，列出缺失事件，后续将补齐而不是在原镜头里硬塞。人物description已有默认服装时，不要求再建wardrobes。已无明火但有余炭不自动构成矛盾，按具体动作是否可能判断。'},{role:'user',content:JSON.stringify({mode,originalSource:source,...(instructions?{instructions}:{}),topic,product,runtimePolicy:require('./film-runtime-policy').agentPolicy(runtimePolicy),screenplay:state.document,previousReview:state.history?.at(-1)?.review?{authority:'Historical defect hints only. Current screenplay is the evidence under review; never quote obsolete checks or old shot wording as current.',issues:state.history.at(-1).review.issues||[]}:null,changedShotIds:state.lastChangedShotIds||[],reviewDeliveryIssues:state.reviewDeliveryIssues||[],...(reviewFeedback?{downstreamReviewFeedback:reviewFeedback}:{}),productClaimAuthority:require('./product-claim-authority').packet(product)})}];
  reviewMessages[1].content=JSON.stringify(require('./screenplay-review-partitions').currentInput(JSON.parse(reviewMessages[1].content)));
  if(!(compact.isCompact(state.document)&&state.document.shots.length>5)){
   const speech=require('./agent-speech-authority');
   reviewMessages[0].content+='\n'+speech.SOURCE_INSTRUCTION;
   reviewMessages[1].content=JSON.stringify({...JSON.parse(reviewMessages[1].content),speechMeasurements:speech.screenplayMeasurements(state.document)});
  }
  audit=compact.isCompact(state.document)&&state.document.shots.length>5
   ?await require('./screenplay-review-partitions').review({input:JSON.parse(reviewMessages[1].content),reviewRules:REVIEW_RULES,generate,state,save,status,signal,signature,execution:reviewExecution})
   :await call('review',reviewMessages,reviewSchemaFor(state.document));
  if(audit.checks&&!Array.isArray(audit.checks))audit={...audit,checks:Object.entries(audit.checks).map(([shotId,value])=>({shotId,evidence:value.evidence}))};
  const covered=new Set((audit.checks||[]).map(c=>c.shotId));
  if(state.document.shots.some(s=>!covered.has(s.id))){state.reviews.push(audit);state.reviewDeliveryIssues=[`缺少审核证据的镜号：${state.document.shots.filter(s=>!covered.has(s.id)).map(s=>s.id).join(', ')}。保留已有结论，补齐对应证据。`];save(state);await new Promise(setImmediate);continue;}
  state.reviews.push(audit);state.activeAudit=audit;delete state.reviewDeliveryIssues;save(state);
  }
  const missingCriteria=!deliveryRepair&&compact.isCompact(state.document)&&['story','commerce','dialogue'].filter(key=>typeof audit.criteria?.[key]?.passed!=='boolean'||!String(audit.criteria?.[key]?.evidence||'').trim());
  if(missingCriteria?.length){delete state.activeAudit;state.reviewDeliveryIssues=[`分别补齐剧情story、带货commerce、对白完整dialogue的明确结论与正文证据，当前缺少：${missingCriteria.join(', ')}。不带货也需说明适用依据，不得空白。`];save(state);continue;}
  if(!deliveryRepair&&compact.isCompact(state.document)&&Object.values(audit.criteria).some(c=>!c.passed)&&!audit.issues.length){delete state.activeAudit;state.reviewDeliveryIssues=['有分项未通过，请列出对应原文证据、shotIds和修订目的，不能同时返回空issues。'];save(state);continue;}
  if(!reviewFeedback?.decision&&!state.pendingRepairPatch&&!state.repairDeliveryIssues?.length&&audit.issues?.length&&!state.deliveryIssues?.length){
   const primaryAudit=audit;
   audit=await require('./source-finding-verification').verify({input:{mode,originalSource:source,topic,product,instructions,runtimePolicy:require('./film-runtime-policy').agentPolicy(runtimePolicy),screenplay:state.document,productClaimAuthority:require('./product-claim-authority').packet(product),...(reviewFeedback?{downstreamReviewFeedback:reviewFeedback}:{})},audit,call,status,signal});
   if(audit!==primaryAudit)state.reviews.push(audit);
   state.activeAudit=audit;save(state);
  }
  if(audit.unresolvedFindings?.length){state.status='needs_evidence';state.pendingEvidence=audit.unresolvedFindings;save(state);throw Object.assign(Error('审核Agent仍需补充源头事实证据，已保存原稿与审核结果'),{code:'AGENT_EVIDENCE_PENDING',recoverable:true});}
   if(!deliveryRepair&&audit.ok&&!audit.issues.length&&audit.storyComplete!==false&&(!compact.isCompact(state.document)||Object.values(audit.criteria).every(c=>c.passed))&&(!['upload','adapt'].includes(mode)||audit.sourcePreserved)){
   state.status='ready';state.completedAt=new Date().toISOString();state.text=render(state.document);save(state);return state;
  }
  const known=new Set(state.document.shots.map(s=>s.id));
  let requested=[...new Set(audit.issues.flatMap(i=>i.shotIds||[]))].filter(id=>known.has(id));
  if(!requested.length){
    const localized=await call('localize_findings',[{role:'system',content:require('./unified-audit-policy').INSTRUCTION+' Locate the actual existing production shot IDs affected by these findings, using exact content rather than matching old numeric labels. Return only evidence-grounded affected IDs; do not rewrite the screenplay.'},{role:'user',content:JSON.stringify({screenplay:state.document,findings:audit.issues})}],obj({locations:arr(obj({shotId:requiredText,evidence:requiredText}))}));
    requested=[...new Set((localized.locations||[]).map(r=>r.shotId))].filter(id=>known.has(id));
    if(!requested.length){state.status='needs_evidence';state.pendingEvidence={kind:'finding_localization',findings:audit.issues,result:localized};save(state);throw Object.assign(Error('审核Agent正在补充问题定位证据，完整剧本已保存'),{code:'AGENT_EVIDENCE_PENDING',recoverable:true});}
   }
  status(`编剧 Agent 正在按证据修订 ${requested.length} 个片段，其余已完成片段保持原样`);
  const completing=audit.storyComplete===false;
  const activeSchema=compact.isCompact(state.document)?SCHEMA:LEGACY_SCHEMA,activeShot=compact.isCompact(state.document)?SHOT:LEGACY_SHOT;
  const entityKeys=['characters','scenes','props','wardrobes'].filter(k=>activeSchema.properties[k]);
  const repairSchema=obj({shots:arr(activeShot),additions:arr(obj({afterShotId:text,shot:activeShot})),...Object.fromEntries(entityKeys.map(k=>[k,{...activeSchema.properties[k],minItems:0}]))});
  repairSchema.properties.removeShotIds=ids;
  repairSchema.properties.removeEntities=obj(Object.fromEntries(['characters','scenes','props','wardrobes'].map(k=>[k,ids])));
  repairSchema.properties.story=SCHEMA.properties.story;
  if(mode==='adapt')repairSchema.properties.adaptation=SCHEMA.properties.adaptation;
  repairSchema.properties.scopeExtensions=arr(obj({shotId:requiredText,dependsOnShotId:requiredText,evidence:requiredText}));
  const repairMessages=[{role:'system',content:RULES+'\n'+AUTHORING_DISCIPLINE+'\nshots只返回实际需要修改的完整镜头，不改变无关片段。合并连续镜头时，shots返回承接全部原句和动作的新完整保留镜头，removeShotIds列出被合并的旧ID（仅本次修订范围）；同时更新受影响的资产身份引用，并在story.synopsis说明旧ID到保留ID的映射，不得借合并删除对白或事件。allowedShotIds是审核首先定位的范围，不是因果修复的硬边界：如修正必须涉及此前漏列的上游动作、下游状态或共享资产引用，由你在scopeExtensions逐项声明shotId、依赖的dependsOnShotId及具体原文证据，并把实际修订镜头一并交付；无需重写全片或等待用户处理。不能只在下游opening中声称未曾写出的上游动作已经发生；应修改真正承载该动作的镜头，或明确可信的时间省略。先验证审核建议能解决原问题，不能把不足的过程稍微提前一镜就声称已经足够。只改有证据的事实和直接依赖它的描述，完整保留其余原文，尤其不能顺手更换物品名称、对白或加新动作。先在内部检查修正后opening→action→ending及相邻镜状态，再提交。additions有两种用途：completing=true时可补缺失剧情；故事已完整但指定片段对白或动作确实容纳不下时，可将该片段沿完整句和因果动作拆成连续片段。拆分时shots保留原ID承载前段，additions用原ID加-a/-b等唯一后缀承载后段，afterShotId从本次允许修订的原镜开始逐项相接；每段10–15秒，不漏句、不重复、不添加剧情，在story.synopsis注明映射并检查相邻起止状态。完整故事不能在无关镜头或最前面插入新剧情。补全缺页时afterShotId可指已有镜头（或本次前一个新镜头），空串表示最前面。审核建议不是命令：若建议18秒或虚构包装，按生成能力和实物证据选择可执行修正。characters/scenes/props/wardrobes只返回修正或新加的实体，不重复完整资产库；无变化为空数组。确需删除重复且已无引用的实体时，用可选removeEntities按类别列出ID；先在本次修订中迁移引用，不得留下悬空引用。'},{role:'user',content:JSON.stringify({mode,originalSource:source,...(instructions?{instructions}:{}),product,runtimePolicy:require('./film-runtime-policy').agentPolicy(runtimePolicy),writingScale,screenplay:state.document,allowedShotIds:requested,completing,findings:audit.issues,...(audit.findingVerification?{findingVerification:audit.findingVerification}:{}),...(reviewFeedback?{downstreamReviewFeedback:reviewFeedback}:{}),...(state.repairDeliveryIssues?{deliveryIssues:state.repairDeliveryIssues}:{} ),productClaimAuthority:require('./product-claim-authority').packet(product)})}];
  const speech=require('./agent-speech-authority');
  repairMessages[0].content+='\n'+speech.SOURCE_INSTRUCTION;
  repairMessages[1].content=JSON.stringify({...JSON.parse(repairMessages[1].content),speechMeasurements:speech.screenplayMeasurements(state.document)});
  const delivery=require('./screenplay-repair-delivery');
  const context={kind:'screenplay-repair',document:state.document,requested,completing,mode,entityKeys,recoverSaved:true,recoveryKey:delivery.recoveryKey(JSON.parse(repairMessages[1].content))};
  let patch=state.pendingRepairPatch;
  if(!patch){patch=await call('repair',repairMessages,repairSchema,context);state.pendingRepairPatch=structuredClone(patch);save(state);}
  let assembled=delivery.assemble(context,patch);
  while(!assembled.ok){
   state.repairDeliveryIssues=assembled.findings;state.attempts.push({stage:'repair_delivery_correction',issues:assembled.findings,at:new Date().toISOString()});save(state);
   status('Agent 正在原已保存结果上修正具体关联字段，已完成剧本保持原样');
   const correction=await call('repair_fields',[{role:'system',content:RULES+'\n'+delivery.CORRECTION_INSTRUCTION},{role:'user',content:JSON.stringify({...JSON.parse(repairMessages[1].content),draftPatch:patch,deliveryFindings:assembled.findings})}],delivery.correctionSchema,{...context,kind:'screenplay-repair-fields',basePatch:patch,recoverSaved:false});
   patch=delivery.correct(patch,correction);state.pendingRepairPatch=structuredClone(patch);save(state);assembled=delivery.assemble(context,patch);
  }
  const additions=patch.additions||[],candidate=assembled.candidate,errors=[];
  state.attempts.push({stage:'repair',shotIds:patch.shots.map(s=>s.id),issues:errors,at:new Date().toISOString()});
  if(errors.length)state.repairDeliveryIssues=errors;
  else{state.history=[...(state.history||[]),{document:state.document,review:audit,scopeExtensions:patch.scopeExtensions||[]}];state.lastChangedShotIds=[...patch.shots.map(s=>s.id),...(patch.removeShotIds||[]),...additions.map(a=>a.shot.id)];state.document=candidate;delete state.pendingRepairPatch;delete state.deliveryIssues;delete state.repairDeliveryIssues;delete state.activeAudit;}
  save(state);await new Promise(setImmediate);
 }
}
module.exports={VERSION,SCHEMA,SHOT,RULES,REVIEW_RULES,REVIEW_SCHEMA,reviewSchemaFor,schemaFor,hash,issues,render,current,hasSavedDraft,makeRecord,projectData,runtimeCurrent,author};
