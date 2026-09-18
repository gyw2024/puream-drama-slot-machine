'use strict';
const crypto=require('node:crypto');
// All input formats share one Agent-owned intake. Completed projects are read
// as stored data; legacy text is never reparsed to repair an accepted project.
async function analyze(workflow,projectId,options={},beginRevision=()=>{}) {
 const project=workflow.store.getProject(projectId),settings=workflow.store.getSettings();
 const source=String(project.script.raw||''),fingerprint=crypto.createHash('sha256').update(source).digest('hex');
 const visionProvider=require('./agent-stage-routing').resolveStageProvider(settings.textProvider,{agentStage:'planning'});
 if(project.product?.imagePath&&require('./product-visual-evidence').supported(visionProvider)){
  const visualEvidence=await require('./product-visual-evidence').observeProduct(project.product,(messages,opts)=>workflow.generateText(settings.textProvider,messages,workflow.productionTextOptions(projectId,'product_visual_evidence',opts)));
  if(visualEvidence){project.product={...project.product,visualEvidence};const latest=workflow.store.getProject(projectId);latest.product={...latest.product,visualEvidence};workflow.store.saveProject(latest);}
 }
 if(options.forceReanalysis!==true&&!project.script.analysisCheckpoint&&project.script.sourceFingerprint===fingerprint&&project.script.analyzedAt&&project.shots?.length&&project.scenes?.length&&(!project.script.shotScreenplay||require('./shot-screenplay').runtimeCurrent(project))){
  if(project.currentStage==='script'){project.currentStage='assets';workflow.store.saveProject(project);}
  return project;
 }
 const signal=workflow.operationControls.get(projectId)?.controller?.signal;
 const generate=(messages,opts)=>workflow.generateText(settings.textProvider,messages,workflow.productionTextOptions(projectId,opts.stage,{...opts,signal}));
 const saveScript=patch=>{const latest=workflow.store.getProject(projectId);latest.script={...latest.script,...patch};workflow.store.saveProject(latest);};
 const status=message=>workflow.setAutomation(projectId,{message});
 // A legacy accepted project can miss the immutable dialogue ledger (route
 // reanalyze_dialogue). Its raw source and stored shots are already accepted
 // data, so the ledger is rebuilt locally from the exact raw script and
 // rebound to the stored shots — never reparsed through another paid intake.
 if(options.forceReanalysis!==true&&require('./workbench-workflow').scriptPipelineEntryRoute(project)==='reanalyze_dialogue'){
  const wf=require('./workbench-workflow');
  const expectedLedger=wf.productionDialogueLedgerFromScript(source);
  const latest=workflow.store.getProject(projectId);
  if(String(latest.script.raw||'')!==source)return analyze(workflow,projectId,options,beginRevision);
  const expectedRows=expectedLedger.map(row=>({...row,__claimed:false}));
  const nameById=new Map((latest.characters||[]).map(character=>[character.id,String(character.name||'').trim()]));
  let allBound=true;
  for(const shot of latest.shots||[]){
   for(const turn of shot.dialogueTurns||[]){
    const text=String(turn.text||turn.spokenText||'').trim();
    const speakerName=nameById.get(turn.speakerId)||String(turn.speakerId||'').trim();
    const row=expectedRows.find(candidate=>!candidate.__claimed
      &&String(candidate.text||'').trim()===text
      &&String(candidate.speaker||'').trim()===String(speakerName).trim());
    if(!row){allBound=false;continue;}
    row.__claimed=true;turn.sourceDialogueId=row.id;
   }
  }
  if(allBound&&expectedRows.length){
   for(const shot of latest.shots||[]){
    const ids=(shot.dialogueTurns||[]).map(turn=>turn.sourceDialogueId).filter(Boolean);
    shot.sourceDialogueIds=ids;
    shot.sourceDialogueBindings=(shot.dialogueTurns||[]).filter(turn=>turn.sourceDialogueId).map(turn=>({sourceDialogueId:turn.sourceDialogueId,listenerIds:[...(turn.listenerIds||[])],subshotNumber:turn.subshotNumber||1}));
   }
   const expectedPublic=expectedRows.map(({__claimed,...row})=>row);
   latest.script={...latest.script,sourceDialogueLedger:expectedPublic,analysisMethod:'uploaded-script-adaptive-dialogue-ledger-v3-source-dialogue-local-repair-v1',analyzedAt:new Date().toISOString(),analysisCheckpoint:null};
   for(const candidate of latest.candidates||[]){candidate.selected=false;candidate.stale=true;candidate.staleAt=new Date().toISOString();candidate.staleReason='对白账本本地修复，已生成媒体需重新确认';}
   if(latest.finalVideoPath){latest.finalVideoStale=true;latest.finalVideoStaleReason='对白账本本地修复';}
   if(latest.currentStage==='script')latest.currentStage='assets';
   workflow.store.saveProject(latest);
   status('已从原稿本地恢复逐字对白账本并重新绑定镜头，未调用写作模型');
   return workflow.store.getProject(projectId);
  }
 }
 const screenplay=require('./shot-screenplay');
 let execution=project.script.shotScreenplay;
 if(!screenplay.current(execution,source)){
  const savedDraft=execution?.sourceHash===screenplay.hash(source)&&execution.document;
  const mode=savedDraft?(execution.mode||'upload'):'upload';
  const originalSource=savedDraft?(project.script.adaptation?.sourceText||project.script.originalRaw||source):source;
  const priorWriter=[project.script.shotAuthoring,project.script.shotPreparation,project.script.dialogueShotPreparation].find(c=>c?.writerText===source);
  const prepared=await screenplay.author({source:originalSource,mode,reviewExecution:require('./unified-audit-policy').executionProfile(settings),product:project.product,runtimePolicy:project.script.runtimePolicy,checkpoint:project.script.shotPreparation,
   draftDocument:savedDraft||priorWriter?.document||null,preparedText:priorWriter?source:'',generate,signal,status,
   save:shotPreparation=>saveScript({shotPreparation})});
  execution=screenplay.makeRecord(prepared.document,source,prepared.contentReview||prepared.reviews.at(-1),mode);
  saveScript({shotScreenplay:execution,executionText:prepared.text});
 }
 if(screenplay.current(execution,source)){
  require('./agent-stage-tasks').throwIfCancelled(signal);
  const latest=workflow.store.getProject(projectId);
  if(String(latest.script.raw||'')!==source)return analyze(workflow,projectId,options,beginRevision);
  const data=screenplay.projectData(execution);
  const executionText=screenplay.render(execution.document);
  const canonicalSource=executionText;
  const canonicalExecution=canonicalSource===source?execution:screenplay.makeRecord(execution.document,canonicalSource,execution.review,execution.mode);
  const oldDocument=project.script.shotScreenplay?.document;
  const preserve=(kind,rows,oldRows)=>oldDocument?require('./screenplay-source-recovery').mergeEntities(oldRows||[],rows,oldDocument[kind]||[],execution.document[kind]||[]):rows;
  if(oldDocument&&screenplay.hash(oldDocument)!==screenplay.hash(execution.document))latest.script.analysisRevisionHistory=[...(latest.script.analysisRevisionHistory||[]),{at:new Date().toISOString(),record:project.script.shotScreenplay,shots:latest.shots,characters:latest.characters,scenes:latest.scenes,assetLibraries:latest.assetLibraries}];
  beginRevision(latest);
  latest.characters=preserve('characters',data.characters,latest.characters);latest.scenes=preserve('scenes',data.scenes,latest.scenes);
  latest.shots=data.shots.map(shot=>{const old=latest.shots?.find(s=>s.id===shot.id);return old?.shotExecution&&screenplay.hash(old.shotExecution)===screenplay.hash(shot.shotExecution)?{...old,shotExecutionVersion:screenplay.VERSION}:shot;});
  latest.assetLibraries={...latest.assetLibraries,props:preserve('props',data.props,latest.assetLibraries?.props),wardrobes:preserve('wardrobes',data.wardrobes,latest.assetLibraries?.wardrobes)};
  latest.script={...latest.script,...(canonicalSource!==source?{originalRaw:latest.script.originalRaw||source}:{}),raw:canonicalSource,shotScreenplay:canonicalExecution,analysis:data.story,sourceDialogueLedger:data.sourceDialogueLedger,sourceSceneLedger:{explicit:true,catalogue:data.scenes,occurrences:data.shots.map((s,i)=>({id:`O${i+1}`,order:i+1,shotId:s.id,sceneId:s.sceneId,sceneName:data.scenes.find(c=>c.id===s.sceneId)?.name}))},sourceFingerprint:crypto.createHash('sha256').update(canonicalSource).digest('hex'),analysisMethod:'shot-screenplay-direct-delivery-v1',analyzedAt:new Date().toISOString(),analysisCheckpoint:null,executionText};
  latest.generation={...latest.generation,targetDurationSeconds:data.durationSeconds,durationSource:'agent-authored-shot-screenplay',durationLocked:false};
  latest.currentStage='assets';latest.status='analyzed';workflow.store.saveProject(latest);
  status(`已接收编剧的 ${data.shots.length} 个镜头及资产绑定，未重新拆镜或改写对白`);
  return workflow.store.getProject(projectId);
 }
}
module.exports={analyze};
