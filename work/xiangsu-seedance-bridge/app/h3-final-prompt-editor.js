"use strict";
const crypto = require('node:crypto');
const { speechWindowBounds } = require('./drama-timing');
const VERSION = 'h3-final-editor-unified-v8-generation-methods';
const clean = value => String(value || '').trim();
const hash = value => crypto.createHash('sha256').update(require('./foundry/canonical').canonicalJson(value)).digest('hex');

function sourceFor(shot) {
  const turns=require("./drama-staging-contract").canonicalizeStagingShot({},shot,shot.dialogueTurns).turns;
  const speakers=[...new Set(turns.map(t=>t.speakerId))];
  return {
    version: VERSION, shotId: shot.id, duration: Number(shot.duration),
    cameraGuidance:'The Agent chooses motivated continuous coverage or cuts from source action and speech; no fixed camera count. Preserve complete sentences and causal contact.',
    ...((shot.dialogueTurns||[]).some(t=>require('./drama-staging-contract').isOffscreen(t,{})) ? {offscreenPromptContract:'source-bound-offscreen-identity-v2'} : {}),
    visibleCharacterIds: shot.visibleCharacterIds || shot.characterIds || [],
    commercePolicy:shot.productMention?require('./commerce-authoring-policy').VISUAL_POLICY:null,action: shot.action, stateBefore: shot.stateBefore, stateAfter: shot.stateAfter,
    sourcePerformanceBudget: shot.sourcePerformanceBudget,
    actionEn: shot.actionEn, stateBeforeEn: shot.stateBeforeEn, stateAfterEn: shot.stateAfterEn,
    directions: shot.providerTimedDirections || [],
    dialogue: turns.map(t => ({
      speakerPrefix:`${t.speakerId} (S${speakers.indexOf(t.speakerId)+1})`,
      sourceDialogueId:t.sourceDialogueId || t.id, speakerId:t.speakerId,
      text:t.text || t.spokenText, listenerIds:t.listenerIds, primaryListenerId:t.primaryListenerId,
      onScreen:t.onScreen!==false, speechMode:t.speechMode||'', addressMode:t.addressMode||'', directToViewer:t.directToViewer===true,
      start:Number(t.startSecond ?? t.start), end:Number(t.endSecond ?? t.end),
      bounds:speechWindowBounds(t.text || t.spokenText,t),
      deliveryEn:t.deliveryEn, vocalArcEn:t.vocalArcEn,
      expressionEn:t.expressionEn, expressionArcEn:t.expressionArcEn,
      bodyEn:t.bodyEn, blockingEn:t.blockingEn, speakerFacingEn:t.speakerFacingEn,
      listenerReactionEn:t.listenerReactionEn
    }))
  };
}
function fingerprint(shot) {
  if(shot.agentProductionDecision?.status==='authored')return hash({renderer:'speech-mouth-actions-v2',authority:shot.agentProductionDecision.version,source:require('./agent-production-decisions').source({},shot),decision:shot.agentProductionDecision.item});
  return hash(sourceFor(shot));
}
function current(shot) { return shot.finalPromptEditing?.fingerprint === fingerprint(shot) && shot.finalPromptEditing?.status === 'authored' && (!shot.finalPromptEditing?.turns || shot.finalPromptEditing?.compilerVersion === 'state-scoped-v3'); }
function normalizeCameraHeaders(text) {
  return String(text||"").split(/(<d>[\s\S]*?<\/d>)/gi).map(part=>/^<d>/i.test(part)?part:part.replace(/[ \t]+(?=\[Shot \d+\])/g,"\n").replace(/(\[Shot [2-4]\] At \d{2}:\d{2}\.\d{3})[.。]/g,"$1,")).join("");
}
function normalizeDialogueMarkers(text,shot) {
  const source=(shot.dialogueTurns||[]).map(t=>String(t.text||t.spokenText||"").trim());
  const tags=[...String(text||"").matchAll(/<d>([\s\S]*?)<\/d>/gi)];
  if(tags.length!==source.length||tags.some((tag,i)=>tag[1].replace(/^\s*\[Chinese\]\s*/i,"").trim()!==source[i]))return text;
  return String(text).replace(/<d>([\s\S]*?)<\/d>/gi,(all,body)=>/^\s*\[Chinese\]/i.test(body)?all:`<d>[Chinese] ${body}</d>`);
}
function validate(shot, item, project) {
  // This is a delivery envelope check only. The downstream stage Agent reviews
  // the fully reference-bound English prompt and its source facts. Running
  // another prose/timing/camera reviewer here created competing authorities.
  const failures=[];
  if (!item || item.shotId !== shot.id) failures.push('wrong shot ID');
  for (const key of ['detailedDescriptionEn','detailedDescriptionZh','summaryEn','soundscapeEn'])
    if (!clean(item?.[key])) failures.push('missing '+key);
  if (failures.length) throw Object.assign(Error('Final H3 editor delivery is incomplete'), {code:'H3_FINAL_EDIT_NEEDS_REPAIR',failures});
  return true;
}

const INSTRUCTION = require('./generation-prompts').build("video_editor","This task returns only its advertised editor JSON fields. The following official guide governs the eventual provider prompt; do not turn its six sections into extra response fields or invent reference indices. Apply its relevant grammar within the requested fields only.\n"+require('./h3-official-agent-standard').PROTOCOL+'\n'+"Return JSON items with shotId,detailedDescriptionEn,detailedDescriptionZh,summaryEn,soundscapeEn under the advertised schema. Complete source dialogue remains once in <d>[Chinese] ...</d>, exact speaker and vocal-order S identity, real listeners, approved numeric timing and complete action prerequisites. DetailedDescriptionZh mirrors the same clocks, action and words. Summary describes the transition without replay; soundscape has no repeated speech. No invented asset indices: this interface uses stable source IDs until the mode reference adapter binds them before independent review and confirmation. The ONLY supported alternative item is {shotId,status:\"source_planning_repair_required\",reason} for an evidenced impossible source plan; do not use this alternative for stylistic preferences or missing non-required source fields. Preserve source facts for its targeted upstream repair.") + "\nSummary describes the transition from the actual opening to the eventual outcome, not an already-completed result at time zero. A person who arrives later must not be described as already present at the opening. Preserve the same initial and final states in detailedDescriptionEn/Zh and summaryEn.";
const DELIVERED_ITEM={type:'object',required:['shotId','detailedDescriptionEn','detailedDescriptionZh','summaryEn','soundscapeEn'],properties:Object.fromEntries(['shotId','detailedDescriptionEn','detailedDescriptionZh','summaryEn','soundscapeEn'].map(k=>[k,{type:'string',minLength:1}]))};
const SOURCE_FINDING={type:'object',required:['shotId','status','reason'],properties:{shotId:{type:'string',minLength:1},status:{const:'source_planning_repair_required'},reason:{type:'string',minLength:1}}};
const DELIVERY_SCHEMA={type:'object',required:['items'],properties:{items:{type:'array',items:{anyOf:[DELIVERED_ITEM,SOURCE_FINDING]}}}};

async function author({getProject,saveProject,generate,optionsFor,settings,projectId,shotIds,findingsByShot={},parallelism=1,signal}) {
  const selected = new Set(shotIds || getProject().shots.map(s=>s.id));
  const initial=getProject();
  // Recompile only unchanged, previously authored structured drafts. Preserve history and validate again.
  for(const shot of initial.shots){const prior=shot.finalPromptEditing;if(!selected.has(shot.id)||prior?.status!=='authored'||prior.fingerprint!==fingerprint(shot)||!prior.turns||prior.compilerVersion==='state-scoped-v3')continue;try{const item=require('./final-prompt-blocks').assemble(sourceFor(shot),prior);validate(shot,item,initial);shot.finalPromptEditingHistory=[...(shot.finalPromptEditingHistory||[]),prior];shot.finalPromptEditing={...item,compilerVersion:'state-scoped-v3',updatedAt:new Date().toISOString()};saveProject(initial);}catch(error){if(error.code!=='H3_FINAL_EDIT_NEEDS_REPAIR')throw error;}}

  // A compiler-only correction may make an unchanged saved draft valid. Check
  // it locally before paying for another edit; never accept changed source.
  for(const shot of initial.shots){const draft=shot.finalPromptDraft;if(!selected.has(shot.id)||current(shot)||!draft?.item?.turns||draft.fingerprint!==fingerprint(shot)||findingsByShot[shot.id]?.length)continue;try{const item=require('./final-prompt-blocks').assemble(sourceFor(shot),draft.item);validate(shot,item,initial);shot.finalPromptEditing={...item,compilerVersion:'state-scoped-v3',version:VERSION,fingerprint:fingerprint(shot),status:'authored',recoveredFromValidatedDraft:true,updatedAt:new Date().toISOString()};saveProject(initial);}catch(error){if(error.code!=='H3_FINAL_EDIT_NEEDS_REPAIR')throw error;}}

  const feedbackKey=s=>Array.isArray(findingsByShot[s.id])&&findingsByShot[s.id].length?hash(findingsByShot[s.id]):'';
  const done=s=>current(s)&&(!feedbackKey(s)||s.finalPromptEditing?.feedbackFingerprint===feedbackKey(s));
  const pending=initial.shots.filter(s=>selected.has(s.id)&&s.providerSemanticCompileSource==='ai-batch'&&!done(s));
  const sourceFindings=new Map();
  const size=5;
  const batches=[];for(let i=0;i<pending.length;i+=size)batches.push(pending.slice(i,i+size));
  await require('./preproduction-performance').mapBatches(batches,parallelism,async batch=>{
    const sources=batch.map(shot=>{const source=sourceFor(shot);return {...source,deliveryFixedWords:require('./final-prose-budget').deliveryFixedWords(source,getProject(),shot)};}),byId=new Map(batch.map(s=>[s.id,s]));
    let remaining=batch,prior=batch.filter(s=>feedbackKey(s)||s.finalPromptDraft?.fingerprint===fingerprint(s)).map(s=>({shotId:s.id,issues:findingsByShot[s.id]||s.finalPromptDraft?.issues,previous:s.finalPromptDraft?.item||s.finalPromptEditing,repairScope:'Correct only the listed findings. Preserve exact dialogue, identities, supplied numeric times, all unaffected events and the complete bilingual mirror. Return the complete corrected item.'}));
    for(let attempt=0;remaining.length;attempt++){
      await new Promise(setImmediate);
      require('./agent-stage-tasks').throwIfCancelled(signal);
      const requestShots=sources.filter(s=>remaining.some(r=>r.id===s.shotId));
      const key=hash(sources),latest=getProject(),journal=latest.finalEditorProgress?.[key]||{};
      const messages=[{role:'system',content:INSTRUCTION},{role:'user',content:JSON.stringify({shots:requestShots,previousFindings:prior})}];
      const result=await require('./audit-progress').request({stage:'h3_final_editor',messages,schema:DELIVERY_SCHEMA,journal,save:()=>{const current=getProject();current.finalEditorProgress={...current.finalEditorProgress,[key]:journal};saveProject(current);},generate:(ms,schema)=>generate(settings.textProvider,ms,optionsFor(projectId,'h3_final_editor',{agentStage:'planning',json:true,allowPartialItems:true,maxAttempts:1,requiredKeys:['items'],responseSchema:schema,maxTokens:14000,signal}))});
      if(!Array.isArray(result?.items)){prior=remaining.map(s=>({shotId:s.id,issues:['Return the required items array with one complete item for this shot']}));continue;}
      const seen=new Set();prior=[];
      for(const rawItem of result.items){
        if(!rawItem||typeof rawItem!=='object')continue;
        const authoredShot=byId.get(rawItem.shotId);
        if(authoredShot&&remaining.some(s=>s.id===authoredShot.id)&&rawItem.status==='source_planning_repair_required'&&clean(rawItem.reason)){
          seen.add(authoredShot.id);sourceFindings.set(authoredShot.id,{shotId:authoredShot.id,reason:clean(rawItem.reason)});
          const latest=getProject(),live=latest.shots.find(s=>s.id===authoredShot.id);
          if(live&&fingerprint(live)===fingerprint(authoredShot)){live.finalPromptSourceFinding={...rawItem,sourceFingerprint:fingerprint(authoredShot)};saveProject(latest);}
          continue;
        }
        let item={...rawItem,detailedDescriptionEn:normalizeDialogueMarkers(normalizeCameraHeaders(rawItem.detailedDescriptionEn),authoredShot||{}),detailedDescriptionZh:normalizeDialogueMarkers(rawItem.detailedDescriptionZh,authoredShot||{})};
        const shot=byId.get(item.shotId);if(!shot||!remaining.some(s=>s.id===shot.id)||seen.has(shot.id))continue;seen.add(shot.id);
        try{
          item=require('./final-prompt-blocks').assemble(sourceFor(shot),item);
          validate(shot,item,getProject());
          const latest=getProject(),live=latest.shots.find(s=>s.id===shot.id);
          if(fingerprint(live)!==fingerprint(shot))throw Object.assign(Error('Shot changed during final authoring; returned draft is preserved in Agent history but not applied'),{code:'H3_FINAL_EDIT_SOURCE_CHANGED'});
          if(live.finalPromptEditing)live.finalPromptEditingHistory=[...(live.finalPromptEditingHistory||[]),live.finalPromptEditing];
          live.finalPromptEditing={...item,compilerVersion:'state-scoped-v3',version:VERSION,fingerprint:fingerprint(shot),feedbackFingerprint:feedbackKey(shot),status:'authored',updatedAt:new Date().toISOString()};
          saveProject(latest);
        }catch(error){if(error.code!=='H3_FINAL_EDIT_NEEDS_REPAIR')throw error;prior.push({shotId:shot.id,issues:error.failures,previous:item});const latest=getProject(),live=latest.shots.find(s=>s.id===shot.id);if(live&&fingerprint(live)===fingerprint(shot)){live.finalPromptDraft={item,issues:error.failures,fingerprint:fingerprint(shot)};saveProject(latest);}}
      }
      for(const shot of remaining)if(!seen.has(shot.id))prior.push({shotId:shot.id,issues:['required shot omitted']});
      remaining=remaining.filter(s=>!sourceFindings.has(s.id)&&!done(getProject().shots.find(p=>p.id===s.id)));
    }
    if(remaining.length)throw Object.assign(Error('Final H3 editing needs targeted repair; completed shots are retained'),{code:'H3_FINAL_EDIT_NEEDS_REPAIR',shotIds:remaining.map(s=>s.id),findings:prior});
  });
  if(sourceFindings.size)throw Object.assign(Error('Agent 请求复核源稿的可执行性；已保留完成镜头'),{code:'H3_SOURCE_PLANNING_REPAIR_REQUIRED',sourceTimingIssues:[...sourceFindings.values()]});
  return getProject();
}
module.exports={VERSION,DELIVERY_SCHEMA,INSTRUCTION,sourceFor,fingerprint,current,validate,author,normalizeCameraHeaders,normalizeDialogueMarkers};
