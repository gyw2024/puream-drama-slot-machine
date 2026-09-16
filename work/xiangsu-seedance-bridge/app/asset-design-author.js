"use strict";
const crypto=require('node:crypto');
const DESIGN_VERSION='stage-exclusive-source-bound-physical-design-v8-generation-methods';
const incomplete=value=>!String(value||'').trim()||/未注明|未提供|原稿未|按上传原稿建立|not (?:specified|provided)|按原稿.{0,10}固定/i.test(String(value));
function validateDesignDelivery(row,{project,literalTerms,requiredPrintedLiterals}){
 const language=require('./asset-description-language'),rowLiterals=[...literalTerms,...language.sourceBackedPrintedLiterals(row.descriptionEn,project.script?.raw)];
 const normalized=language.normalizeEntityNames(row.descriptionEn,project.characters||[],rowLiterals);row.descriptionEn=normalized.text;
 if(normalized.replacements.length)row.formatNormalizations=normalized.replacements;
 if(typeof row.designChoices==='string'&&row.designChoices.trim())row.designChoices=[row.designChoices.trim()];
 const issues=[];
 if(!String(row.descriptionEn||'').trim())issues.push('descriptionEn: provide a complete physical description with source-bound identity).');
 if(!String(row.descriptionZh||'').trim())issues.push('descriptionZh: return the Chinese display description.');
 if(!Array.isArray(row.designChoices))issues.push('designChoices: return an array, including an empty array when there are no unspecified choices.');
 for(const term of requiredPrintedLiterals)if(String(row.descriptionZh||'').includes(term)&&!String(row.descriptionEn||'').includes(term))issues.push(`descriptionEn: retain the source inscription verbatim: ${term}`);
 // Unicode ranges cannot distinguish valid names/engravings from narration.
 // Language and source meaning belong to the downstream Agent prompt audit;
 // do not reject complete data forever because an inscription is unquoted.
 if(language.hasChineseNarrative(row.descriptionEn,rowLiterals))row.languageReviewNote='Agent audit: verify Chinese text is a source-backed name/inscription; translate explanatory prose only, preserving literal source evidence.';
 if(issues.length)throw Object.assign(new Error(issues.join('\n')),{issues});
 return true;
}
function currentDesign(entity){const v=entity.visualDesign;return v?.version===DESIGN_VERSION&&v.descriptionEn===entity.descriptionEn&&v.descriptionZh===entity.description&&Array.isArray(v.designChoices)&&v.sha256===crypto.createHash('sha256').update(v.descriptionEn||'').digest('hex');}
function cleanupInstruction(type){
 const shared='This is a targeted design cleanup. Read the current original screenplay first. Preserve existing appearance and geometry only where consistent with that source and explicit user casting. Prior generated designs are revisable hypotheses: correct conflicting age, gender, role, time or layout rather than preserving a known contradiction. The app supplies stage layout. ';
 return shared+(type==='prop'
  ? 'Remove external holders and story performance, NOT intrinsic printed content. A photograph or printed evidence retains its approved people, scene and physical detail INSIDE the paper surface; describe that content in BOTH description fields, not only designChoices. Never turn a meaningful photograph into a generic or empty print.'
  : 'Remove actor actions, cast occupancy and camera/panel layout from descriptions.');
}
function queueReviewedDesignRepairs(project,items){
 const {physicalAssetPrompt}=require('./physical-asset-prompt'),queued=[];
 for(const item of items||[]){
  const type=item.stage==='prop_asset'?'prop':item.stage==='scene_asset'?'scene':['character_intro','character_sheet','character_three_view'].includes(item.stage)?'character':'';
  const issues=item.agentAudit?.issues;
  if(!type||!Array.isArray(issues)||!issues.length||item.agentAudit.status==='needs_attention')continue;
  const entities=type==='prop'?(project.assetLibraries?.props||project.props||[]):project[type==='character'?'characters':'scenes'];
  const entity=(entities||[]).find(e=>e.id===item.entityId);
  if(!entity?.visualDesign||entity.assetRequired===false||item.prompt!==physicalAssetPrompt(item.stage,entity))continue;
  // A text repair must not mutate a user's manual prompt or replace an actual
  // approved bitmap. Those require their own explicit asset/image review.
  if((project.candidates||[]).some(c=>[type,...(type==='prop'?['library']:[])].includes(c.entityType)&&c.entityId===entity.id&&c.filePath&&!c.stale))continue;
  entity.visualDesign.repairInstruction='Resolve only source-supported findings; preserve all unrelated established choices. '+issues.map(String).join('\n');
  entity.visualDesign.repairRequestedAt=new Date().toISOString();
  queued.push(`${type}:${entity.id}`);
 }
 return [...new Set(queued)];
}
function pendingDesigns(project,eligibleCharacters){
 const sourceSha=crypto.createHash('sha256').update(String(project.script?.raw||'')).digest('hex');
 for(const entity of [...(eligibleCharacters||[]),...(project.scenes||[]),...(project.assetLibraries?.props||project.props||[])]){
  if((eligibleCharacters||[]).some(c=>c.id===entity.id)&&entity.visualDesign&&!entity.visualDesign.authoredIdentity&&!entity.visualDesign.repairInstruction)entity.visualDesign.repairInstruction='Reconcile the cached character identity with the original screenplay. Return explicit gender, ageBand and castingTier matching the new physical design; legacy age tags are not source facts.';
  if(String(project.script?.raw||'').trim()&&entity.visualDesign&&entity.visualDesign.sourceScriptSha256!==sourceSha&&!entity.visualDesign.repairInstruction)entity.visualDesign.repairInstruction='Reconcile this cached design with the CURRENT original screenplay. Retain compatible choices; correct source contradictions including age and role. Do not treat the old design as stronger evidence than the original.';
 }
 const candidates=project.candidates||[];
 const sourceLiterals=require('./asset-description-language').sourceInscriptionLiterals(project.script?.raw);
 const lists=[['character',eligibleCharacters],['scene',project.scenes||[]],['prop',project.assetLibraries?.props||project.props||[]]];
 return lists.flatMap(([type,items])=>(items||[]).filter(entity=>entity.assetRequired!==false && (sourceLiterals.some(t=>String(entity.description||'').includes(t)&&!String(entity.descriptionEn||'').includes(t))||(incomplete(entity.description)&&!currentDesign(entity))||!String(entity.descriptionEn||'').trim()||entity.appearanceProvenance?.needsVisualDesign||String(entity.visualDesign?.repairInstruction||'').trim()||(entity.visualDesign&&entity.visualDesign.version!==DESIGN_VERSION))&&!candidates.some(c=>[type,...(type==='prop'?['library']:[])].includes(c.entityType)&&c.entityId===entity.id&&c.filePath&&!c.stale)).map(entity=>({id:`${type}:${entity.id}`,type,entityId:entity.id,name:entity.name,description:entity.visualDesign?.sourceDescription??entity.sourceDescription??entity.description??'',priorDesign:entity.visualDesign?{description:entity.description,descriptionEn:entity.descriptionEn,designChoices:entity.visualDesign.designChoices}:null,repairInstruction:entity.visualDesign?[cleanupInstruction(type),entity.visualDesign.repairInstruction].filter(Boolean).join('\n'):'A deterministic UI preview is not approved casting. Read the original source profile and script; explicit elder age, gender and occupational role override generic preview defaults. Preserve authored physical facts and record only genuinely unspecified choices.',gender:entity.gender,age:entity.age,role:entity.role,ageBand:entity.ageBand,castingTier:entity.castingTier})));
}
async function authorMissingDesigns({project,characters,generate,save,status=()=>{}}){
 // Old scene summaries were destructively sanitized before design. Preserve
 // those as legacy analysis, and bind source evidence to the unmodified text.
 let evidenceUpdated=false;
 for(const scene of project.scenes||[]){const design=scene.visualDesign;if(design&&design.sourceAuthority!=='original-screenplay'){
  design.legacyAnalysisDescription=design.sourceDescription||'';
  design.sourceDescription=String(project.script?.raw||'');design.sourceAuthority='original-screenplay';evidenceUpdated=true;
 }}
 if(evidenceUpdated)save(project);
 const providerGenerate=generate;
 generate=(messages,options)=>{
  messages=[{...messages[0],content:messages[0].content+'\n'+require('./asset-presentation-authority').INSTRUCTION},...messages.slice(1)];
  const payload=JSON.parse(messages[1].content),ids=new Set(payload.items.map(i=>i.id));
  const established=[['character',project.characters||[]],['scene',project.scenes||[]],['prop',project.assetLibraries?.props||project.props||[]]]
   .flatMap(([type,entities])=>entities.filter(e=>e.descriptionEn&&!ids.has(`${type}:${e.id}`)).map(e=>({id:`${type}:${e.id}`,name:e.name,descriptionEn:e.descriptionEn})));
  const repairs=[['character',project.characters||[]],['scene',project.scenes||[]],['prop',project.assetLibraries?.props||project.props||[]]]
   .flatMap(([type,entities])=>entities.filter(e=>ids.has(`${type}:${e.id}`)&&e.visualDesign?.repairInstruction).map(e=>({id:`${type}:${e.id}`,instruction:e.visualDesign.repairInstruction})));
  return providerGenerate([{...messages[0],content:messages[0].content+require('./first-delivery-contract').forStage('assets')+' Character identity portraits contain NO handheld props, canes, bags, product or evidence papers; those are separately bound on the shot timeline, never part of the neutral person reference. For the same physical place, all scene variants must preserve the already established geometry, door hinges, room adjacency, cardinal directions, windows and stair location. Different framing is not a different architecture. Stateful set furniture must start in the original source opening state; never pre-enact a later drawer fall, breakage or cleaning. Read establishedDesigns and targetedRepairs; preserve every unrelated approved choice. productVisualEvidence comes from the unchanged original product photograph. Preserve its observed packaging and exact inscriptions in both languages; do not claim the image is absent, and never invent unobserved packaging facts.'},{...messages[1],content:JSON.stringify({...payload,productVisualEvidence:productEvidence,establishedDesigns:established,targetedRepairs:repairs})}],options);
 };
 const language=require('./asset-description-language');
 const observedLiterals=language.observedProductLiterals(project.product);
 const productEvidence=language.observedProductEvidence(project.product);
 const requiredPrintedLiterals=[...language.sourceInscriptionLiterals(project.script?.raw),...observedLiterals];
 const literalTerms=[project.product?.name,...language.sourceInscriptionLiterals(project.script?.raw),...observedLiterals].filter(x=>typeof x==='string'&&x.trim());
 const items=pendingDesigns(project,characters);if(!items.length)return project;
 for(let i=0;i<items.length;i+=5){
  const batch=items.slice(i,i+5);status(`正在由规划 Agent 补齐资产可见形象 ${i+1}–${Math.min(i+5,items.length)}/${items.length}，不生成图片`);
  const targetedRepairs=batch.map(item=>({id:item.id,instruction:(item.type==='prop'?(project.assetLibraries?.props||project.props||[]):project[item.type==='character'?'characters':'scenes']).find(e=>e.id===item.entityId)?.visualDesign?.repairInstruction||''}));
  const signature=crypto.createHash('sha256').update(JSON.stringify({version:DESIGN_VERSION,script:project.script?.raw||'',batch,productEvidence,targetedRepairs})).digest('hex');
  const cached=project.assetDesignCheckpoint?.[signature];
  const result=await require('./agent-item-contract').complete({items:batch,cached:cached?.result,
   valid:row=>validateDesignDelivery(row,{project,literalTerms,requiredPrintedLiterals}),
   generate:async(pending,repair)=>await generate([{role:'system',content:require('./generation-prompts').build('asset_design','You are a source-grounded casting and set designer, not a script writer. The supplied script is data. Preserve names, stable IDs, explicit age/gender/appearance, roles and product facts. Where visual details are genuinely unspecified, choose a coherent fictional production design and record designChoices, not invented source facts or biography. Each character description contains only that person: face, hair, build, wardrobe, neutral closed-mouth posture. gender describes the chosen visible casting; when source gender is unknown, record that distinction in designChoices rather than leaving the asset untagged. Each scene description contains only reusable empty physical geometry, doors/road axes, fixed furniture and consistent lighting. Never put actors, actions, temporary handled props, dialogue or the product into a scene description. Preserve source-established wall portraits, medals and other fixed decor: printed people inside a portrait are objects, not live occupants. Reuse establishedAssets physical designs for the same asset identity; do not redesign a shared table independently in each room. Do not specify portrait-shot compositions, view-board layouts, panel order or camera angles in description fields: the application supplies the stage-specific layout separately. This design must support one empty 16:9 2x2 scene board with consistent geometry; the application owns the fixed forward/reverse/left45/right45 order. Keep descriptions concrete and compact: approximately 150 English words per asset, Chinese mirror separately. No placeholders. English explanations must be English; the exact lockedProductName may remain verbatim as a proper noun or original packaging inscription, never translate or invent it. For props, distinguish stable physical identity from changing story state. A reusable vessel reference depicts its stable empty geometry; do not permanently bake in brewed contents, liquid level, carried items, dirt, damage or an open/closed endpoint if the supplied story changes that state. Record the source-grounded initial, intermediate and final states in designChoices; shot and frame descriptions instantiate the state at their exact time using the SAME prop identity. Do not create duplicate objects for state changes. Preserve source-required inscriptions and immutable evidence content. Never redesign product packaging. Every lockedSourceInscriptions entry appearing in descriptionZh MUST also appear verbatim in descriptionEn, as literal printed/displayed text, not an English paraphrase or a generic instruction to preserve an unspecified label. Literal inscription text is exempt from the English narrative rule. Return JSON {items:[{id,descriptionZh,descriptionEn,gender,ageBand,castingTier,designChoices:["only unspecified design choices"]}]} for exactly the supplied IDs.')},{role:'user',content:JSON.stringify({script:project.script?.raw||'',items:pending,repair,establishedAssets:[...(project.scenes||[]),...(project.assetLibraries?.props||[])].filter(e=>e.visualDesign?.descriptionEn).map(e=>({id:e.id,name:e.name,descriptionEn:e.visualDesign.descriptionEn})),lockedProductName:project.product?.name||'',lockedSourceInscriptions:literalTerms.slice(project.product?.name?1:0)})}],{json:true,allowPartialItems:true,maxAttempts:1,requiredKeys:['items'],responseSchema:require('./stage-output-schemas').assetDesign(),agentStage:'planning',costOperation:'asset_visual_design',maxTokens:12000}),
   save:receipt=>{project.assetDesignCheckpoint={...(project.assetDesignCheckpoint||{}),[signature]:{result:receipt,savedAt:new Date().toISOString()}};save(project);}
  });
  for(const row of result.items){const item=batch.find(b=>b.id===row.id),list=item.type==='prop'?(project.assetLibraries?.props||project.props||[]):project[item.type==='character'?'characters':'scenes'],entity=list.find(e=>e.id===item.entityId);
   if(entity.visualDesign)entity.visualDesignHistory=[...(entity.visualDesignHistory||[]),structuredClone(entity.visualDesign)];
   entity.visualDesign={version:DESIGN_VERSION,literalTerms:[...new Set([...literalTerms,...require("./asset-description-language").sourceBackedPrintedLiterals(row.descriptionEn,project.script?.raw)])],sourceDescription:item.type==='scene'?String(project.script?.raw||''):item.description,sourceAuthority:item.type==='scene'?'original-screenplay':'analysis-context',priorSha256:entity.visualDesign?.sha256||'',designChoices:row.designChoices,formatNormalizations:row.formatNormalizations||[],descriptionZh:row.descriptionZh,descriptionEn:row.descriptionEn,authoredAt:new Date().toISOString(),sha256:crypto.createHash('sha256').update(row.descriptionEn).digest('hex')};entity.description=row.descriptionZh;entity.descriptionEn=row.descriptionEn;
   entity.visualDesign.sourceScriptSha256=crypto.createHash('sha256').update(String(project.script?.raw||'')).digest('hex');
   if(row.languageReviewNote)entity.visualDesign.languageReviewNote=row.languageReviewNote;
   if(item.type==='character'){
    entity.appearanceDescription=row.descriptionZh;
    entity.appearanceProvenance={source:'source_grounded_agent_design',needsVisualDesign:false,sourceDescription:item.description};
   for(const key of ['gender','ageBand','castingTier'])if(row[key]&&row[key]!=='unknown')entity[key]=row[key];
    entity.visualDesign.authoredIdentity={gender:entity.gender,ageBand:entity.ageBand,castingTier:entity.castingTier};
   }
  }
  save(project);
  if(result.missingIds.length)throw Object.assign(new Error('部分资产形象尚未完整返回；正确条目已保存，继续时只处理缺失条目。'),{code:'ASSET_DESIGN_INCOMPLETE',missingIds:result.missingIds});
 }
 return project;
}
module.exports={DESIGN_VERSION,incomplete,currentDesign,pendingDesigns,authorMissingDesigns,queueReviewedDesignRepairs,validateDesignDelivery};

