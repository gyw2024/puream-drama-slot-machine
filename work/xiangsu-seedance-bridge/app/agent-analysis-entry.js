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
