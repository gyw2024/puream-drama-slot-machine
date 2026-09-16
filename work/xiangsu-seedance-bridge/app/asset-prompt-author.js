'use strict';
const crypto=require('node:crypto');
const VERSION='agent-owned-complete-asset-prompts-v2-generation-methods';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const supported=stage=>['character_intro','character_sheet','character_three_view','scene_asset','prop_asset','wardrobe_asset'].includes(stage);
function entityFor(project,item){
 const list=item.entityType==='character'?project.characters:item.entityType==='scene'?project.scenes:item.stage==='wardrobe_asset'?project.assetLibraries?.wardrobes:project.assetLibraries?.props||project.props;
 return (list||[]).find(e=>e.id===item.entityId);
}
function entityFingerprint(stage,entity){return hash({version:VERSION,stage,id:entity.id,name:entity.name,description:entity.description,descriptionEn:entity.descriptionEn,gender:entity.gender,age:entity.age,design:entity.visualDesign?.sha256});}
function current(stage,entity){const row=entity?.agentAssetPrompts?.[stage];return row?.status==='authored'&&row.version===VERSION&&row.entityFingerprint===entityFingerprint(stage,entity)&&Boolean(row.promptEn?.trim())&&Boolean(row.promptZh?.trim());}
function output(stage,entity,language='en'){return current(stage,entity)?entity.agentAssetPrompts[stage][language==='zh'?'promptZh':'promptEn']:'';}
function linkedCharacterFor(project,entity){const c=(project.characters||[]).find(c=>c.id===entity.characterId);return c?{id:c.id,name:c.name,description:c.description,descriptionEn:c.descriptionEn,visualDesign:c.visualDesign}:undefined;}
function sourceFingerprint(project,stage,entity){return hash({entity:entityFingerprint(stage,entity),linkedCharacter:stage==='wardrobe_asset'?linkedCharacterFor(project,entity):undefined,source:require('./asset-source-evidence').source(project,[entity]),product:{name:project.product?.name,description:project.product?.description,sellingPoints:project.product?.sellingPoints,visualEvidence:project.product?.visualEvidence},mode:project.generation?.mode});}
function findingsKey(item){return hash({prompt:item.prompt,issues:item.agentAudit?.issues||[]});}
function canAuthor(project,item){
 const entity=entityFor(project,item);
 if(!supported(item.stage)||!entity||item.mode==='manual'||entity.assetRequired===false||entity.promptOverrides?.[item.stage]?.mode==='manual')return false;
 return !(project.candidates||[]).some(c=>c.entityId===entity.id&&c.filePath&&!c.stale&&[item.entityType,...(item.entityType==='library'?['prop']:[])].includes(c.entityType));
}
function applyResolutions(project,items){
 for(const item of items){const e=entityFor(project,item),row=e?.agentAssetPrompts?.[item.stage];
  if(!current(item.stage,e)||row.sourceFingerprint!==sourceFingerprint(project,item.stage,e)||row.resolution!=='source_supported'||row.findingsKey!==findingsKey(item)||!item.agentAudit?.issues?.length)continue;
  item.agentAudit={...item.agentAudit,status:'disputed',authorChallenge:{reason:row.reason,sourceEvidence:row.sourceEvidence,at:row.authoredAt}};
 }
}
const INSTRUCTION=require('./generation-prompts').build("asset_prompt","You own the COMPLETE promptEn; the application executes it verbatim without appending a legacy template. promptZh is the complete faithful mirror. Return the supplied IDs and resolution/reason/sourceEvidence fields. Initial generation produces the complete requested image prompt. An existing prompt challenged by a finding is changed only when evidence supports the change; source_supported is counterevidence for independent adjudication, never self-approval.\ncharacter_intro: one vertical three-quarter identity image. character_sheet/character_three_view: four aligned full-body views, front, left90, right90, back, identical source-approved person or ensemble in EACH view, plain #E9E9E9 background, neutral closed mouths, no handled story props. scene_asset: 16:9 2x2 EMPTY reusable location, forward/reverse/left45/right45 in that order, consistent geometry, no moving actors or temporary props; its neutral display is not the story opening. prop_asset: actual object/collection count and required supports; never hide members by overlap while claiming all visible. Digital content has no invented carrier. wardrobe_asset: exact approved garment pieces, materials, colors and layering from linkedCharacter and approved design, not a new outfit inferred from a vague name. Preserve source-required intrinsic writing and original product printing. No added labels, captions or watermark.");
async function author({getProject,saveProject,items,generate,status=()=>{},signal,repairOnly=false,concurrency=4}){
 let project=getProject();applyResolutions(project,items);
 const pending=items.filter(item=>canAuthor(project,item)&&(!repairOnly||item.agentAudit?.issues?.length)).filter(item=>{
  const entity=entityFor(project,item),row=entity.agentAssetPrompts?.[item.stage];
  return item.agentAudit?.issues?.length||!current(item.stage,entity)||row.sourceFingerprint!==sourceFingerprint(project,item.stage,entity);
 });
 let changed=false;
 const batches=[];for(let offset=0;offset<pending.length;offset+=5)batches.push(pending.slice(offset,offset+5));
 await require('./preproduction-performance').mapBatches(batches,Math.min(4,Math.max(1,concurrency)),async batch=>{
  require('./agent-stage-tasks').throwIfCancelled(signal);
  const project=getProject();
  const inputs=batch.map(item=>{const entity=entityFor(project,item);return {id:item.id,stage:item.stage,entityId:item.entityId,name:entity.name,description:entity.description,descriptionEn:entity.descriptionEn,linkedCharacter:item.stage==='wardrobe_asset'?linkedCharacterFor(project,entity):undefined,priorPrompt:item.prompt,findings:item.agentAudit?.issues||[],sourceFingerprint:sourceFingerprint(project,item.stage,entity)};});
  for(const input of inputs)input.stagePresentation=require('./asset-presentation-authority').packet([input.stage]);
  const attempts=[];
  status(repairOnly?'Agent 正在按具体意见修订完整资产提示词，包含布局与所有通用段落':'Agent 正在编写完整资产执行提示词及中文对应稿');
  const result=await require('./agent-item-contract').complete({items:inputs,signal,
   valid:row=>{const input=inputs.find(i=>i.id===row.id);return Boolean(input&&typeof row.promptEn==='string'&&row.promptEn.trim()&&typeof row.promptZh==='string'&&row.promptZh.trim()&&['revised','source_supported'].includes(row.resolution)&&typeof row.reason==='string'&&row.reason.trim()&&Array.isArray(row.sourceEvidence)&&row.sourceEvidence.length&&(!input.findings.length||row.resolution!=='revised'||row.promptEn.trim()!==input.priorPrompt.trim()));},
   generate:async(scope,delivery)=>{
    const response=await generate([{role:'system',content:INSTRUCTION},{role:'user',content:JSON.stringify({source:require('./asset-source-evidence').source(project,scope.map(i=>entityFor(project,items.find(x=>x.id===i.id)))),product:project.product,items:scope,delivery,previousAttempts:attempts.slice(-1)})}],{agentStage:'planning',costOperation:'asset_execution_prompt',json:true,requiredKeys:['items'],maxAttempts:1,allowPartialItems:true,maxTokens:15000,responseSchema:{type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,required:['id','promptEn','promptZh','resolution','reason','sourceEvidence'],properties:{id:{type:'string',enum:scope.map(i=>i.id)},promptEn:{type:'string'},promptZh:{type:'string'},resolution:{type:'string',enum:['revised','source_supported']},reason:{type:'string'},sourceEvidence:{type:'array',items:{type:'string'}}}}}}}});
    attempts.push(response);return response;
   },
   save:receipt=>{const latest=getProject();latest.assetPromptDelivery={status:'authoring',itemIds:inputs.map(i=>i.id),receipt,at:new Date().toISOString()};saveProject(latest);}
  });
  require('./agent-stage-tasks').throwIfCancelled(signal);
  const latest=getProject();
  for(const row of result.items){const item=batch.find(i=>i.id===row.id),entity=entityFor(latest,item),input=inputs.find(i=>i.id===row.id);
   if(!entity||sourceFingerprint(latest,item.stage,entity)!==input.sourceFingerprint)continue;
   const prior=entity.agentAssetPrompts?.[item.stage];
   entity.agentAssetPrompts={...entity.agentAssetPrompts,[item.stage]:{...row,promptEn:row.promptEn.trim(),promptZh:row.promptZh.trim(),version:VERSION,status:'authored',entityFingerprint:entityFingerprint(item.stage,entity),sourceFingerprint:input.sourceFingerprint,findingsKey:findingsKey(item),authoredAt:new Date().toISOString()}};
   if(prior)entity.assetPromptHistory=[...(entity.assetPromptHistory||[]),{stage:item.stage,...prior}];
   entity.promptOverrides={...entity.promptOverrides,[item.stage]:{...entity.promptOverrides?.[item.stage],mode:'system',system:row.promptEn.trim()}};
   item.prompt=row.promptEn.trim();item.displayPrompt=row.promptZh.trim();item.displayLanguage='zh-CN';item.translationStatus='structured';item.executionLanguage='en';item.language='en';
   changed=true;
  }
  latest.assetPromptDelivery={status:'completed',itemIds:inputs.map(i=>i.id),at:new Date().toISOString()};saveProject(latest);
 },{signal});
 applyResolutions(getProject(),items);
 return {changed,authoredCount:pending.length};
}
module.exports={VERSION,INSTRUCTION,supported,entityFor,entityFingerprint,sourceFingerprint,current,output,canAuthor,applyResolutions,author};
