'use strict';
const crypto=require('node:crypto');
const VERSION='source-prop-evidence-selection-v3-identity';
const contract=require('./inventory-evidence-contract');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clean=x=>String(x||'').trim().replace(/[。；;]+$/u,'');
function source(project){return String(project.script?.formatAdaptation?.productionScript||project.script?.sourcePreparation?.parts?.map(p=>p.productionScript).join('\n')||'');}
function declarations(project){
 const rows=[...source(project).matchAll(/【\s*(?:核心物品|核心道具|关键物品|关键道具)\s*】([^\n]+)/gu)].flatMap(m=>m[1].split(/[；;]/u).map(clean)).filter(x=>x&&x!=='无');
 return [...new Set(rows)].map((text,i)=>({id:`G${String(i+1).padStart(3,'0')}`,text}));
}
function fingerprint(project){return hash({version:VERSION,instruction:contract.INSTRUCTION,raw:project.script?.raw||'',source:source(project),shots:(project.shots||[]).map(s=>({id:s.id,evidence:contract.shotEvidence(project,s)}))});}
function identitiesCurrent(project,receipt){
 return !Array.isArray(receipt?.identities)||receipt.identities.every(ref=>(project.assetLibraries?.props||[]).some(p=>p.id===ref.id&&clean(p.name)===ref.name));
}
function pending(project){
 const rows=declarations(project),prior=project.sourcePropInventory;
 if(!rows.length)return false;
 if(prior?.status==='completed'&&prior.fingerprint===fingerprint(project))return !identitiesCurrent(project,prior);
 const names=(project.assetLibraries?.props||[]).flatMap(p=>[p.name,...(p.aliases||[])]).map(clean).filter(Boolean);
 const product=String(project.product?.name||'');
 return rows.some(r=>!(product&&r.text===product)&&!names.includes(r.text));
}
function shotText(s){return [s.action,s.stateBefore,s.stateAfter,s.visualBeat,s.dialogue].filter(Boolean).join('\n');}
function groundedAlias(asset,text,assets){
 const named=[asset.name,...(asset.aliases||[])].filter(n=>typeof n==='string'&&n.length>=2);
 const exact=named.find(n=>text.includes(n));if(exact)return exact;
 // A shorter source suffix is safe only when it identifies one inventory item.
 for(const name of named)for(let start=1;start<name.length-1;start++){const short=name.slice(start);if(text.includes(short)&&!assets.some(other=>other!==asset&&[other.name,...(other.aliases||[])].some(n=>String(n).includes(short))))return short;}
 return '';
}
function expandCompact(result,project){
 contract.bindIdentities(result,project);
 const shots=new Map((project.shots||[]).map(s=>[s.id,s]));
 for(const a of result?.assets||[]){
  // The model may use the disposition vocabulary for an ordinary scene item.
  // Preserve the item and its evidence while translating the equivalent enum.
  if(['incidental','set_dressing'].includes(a.classification))a.classification='in_scene';
  if(Array.isArray(a.appearances)){
   for(const p of a.appearances){const text=contract.shotEvidence(project,shots.get(p.shotId)||{});if(!text.includes(p.evidence||'')||!p.evidence){const match=groundedAlias(a,text,result.assets);if(match)p.evidence=match;}}
  }else{
  const names=[a.name,...(a.aliases||[])].filter(n=>typeof n==='string'&&n.length>=2);
  a.appearances=[['visible',a.visibleShotIds||[]],['stored',a.storedShotIds||[]]].flatMap(([visibility,ids])=>ids.map(shotId=>{
   const text=contract.shotEvidence(project,shots.get(shotId)||{});
   const cupAlias=(a.aliases||[]).includes('杯')&&text.match(/[捧端握拿持举递放接]杯/u)?.[0];
   const supplied=a.shotEvidence?.[shotId];
   const evidence=(supplied&&text.includes(supplied)?supplied:'')||groundedAlias(a,text,result.assets)||cupAlias||'';
   return {shotId,visibility,evidence};
  }));
  }
  // Background occurrence annotations are optional. Never send an ungrounded
  // background reference downstream; preserve the discarded annotation for audit.
  // Core props and unknown shot IDs still fail the strict validator below.
  if(a.classification==='in_scene')a.appearances=a.appearances.filter(p=>{
   if(shots.has(p.shotId)&&!p.evidence){
    (result.discardedUnverifiedAppearances||=[]).push({key:a.key,...p});return false;
   }
   return true;
  });
 }
 // The locked product is already an asset. Unreferenced background inventory
 // remains an exclusion record, not a missing required generated prop.
 const removed=new Map();
 result.assets=(result.assets||[]).filter(a=>{const product=project.product?.name&&String(a.name).trim()===String(project.product.name).trim();const incidental=a.classification==='in_scene'&&!(a.appearances||[]).length;if(!product&&!incidental)return true;removed.set(a.key,product?'product':'incidental');(result.excludedAssets||=[]).push({...a,exclusion:product?'locked product already supplied':'no grounded visible occurrence'});return false;});
 for(const d of result.decisions||[]){const before=d.assetKeys||[];d.assetKeys=before.filter(k=>!removed.has(k));if(!d.assetKeys.length&&before.some(k=>removed.has(k))){d.classification=before.some(k=>removed.get(k)==='product')?'product':'incidental';d.reason=d.reason||'No additional generated prop is required.';}}
 for(const a of result.assets||[])if(removed.has(a.parentKey))a.parentKey='';
 const rows=declarations(project),known=new Set(rows.map(r=>r.id));
 result.decisions=(result.decisions||[]).filter((d,i,all)=>known.has(d.id)&&all.findIndex(x=>x.id===d.id)===i);
 for(const row of rows)if(!result.decisions.some(d=>d.id===row.id)){
  const matched=result.assets.filter(a=>[a.name,...(a.aliases||[])].some(n=>typeof n==='string'&&n.length>=2&&row.text.includes(n)));
  if(matched.length)result.decisions.push({id:row.id,classification:'mapped',assetKeys:matched.map(a=>a.key),reason:'Exact declared source name mapped to the validated inventory.'});
  else if(project.product?.name&&row.text.includes(project.product.name))result.decisions.push({id:row.id,classification:'product',assetKeys:[],reason:'Locked uploaded product is already supplied.'});
 }
 return result;
}
function validate(result,project,rows){
 const errors=[],assets=result?.assets,decisions=result?.decisions,sourceText=[project.script?.raw,source(project),...contract.catalog(project).map(row=>row.text)].join('\n');
 if(!Array.isArray(assets)||!Array.isArray(decisions))return ['Return assets and decisions arrays.'];
 const keys=new Set(assets.map(a=>a.key)),ids=new Set(rows.map(r=>r.id));
 if(keys.size!==assets.length||new Set(assets.map(a=>a.name)).size!==assets.length||assets.some(a=>!a.key||!a.name))errors.push('Asset keys and names must be nonempty and unique.');
 const reused=assets.map(a=>a.existingId).filter(Boolean);if(new Set(reused).size!==reused.length)errors.push('One existing identity cannot be assigned to two different assets.');
 if(decisions.length!==rows.length||new Set(decisions.map(d=>d.id)).size!==rows.length||decisions.some(d=>!ids.has(d.id)))errors.push('Every supplied declaration ID needs exactly one disposition.');
 const shots=new Map((project.shots||[]).map(s=>[s.id,s]));
 for(const a of assets){
  if(!['core','in_scene'].includes(a.classification))errors.push(`${a.key}: invalid asset classification.`);
  if(!Array.isArray(a.sourceQuotes)||!a.sourceQuotes.length||a.sourceQuotes.some(q=>typeof q!=='string'||q.length<3||!sourceText.includes(q)))errors.push(`${a.key}: sourceQuotes must be exact supplied source spans.`);
  if(!Array.isArray(a.appearances)||!a.appearances.length)errors.push(`${a.key}: missing shot-level appearances.`);
  for(const p of a.appearances||[]){if(!shots.has(p.shotId)||!['visible','stored'].includes(p.visibility)||typeof p.evidence!=='string'||p.evidence.length<2||!contract.shotEvidence(project,shots.get(p.shotId)||{}).includes(p.evidence))errors.push(`${a.key}: ${p.shotId} evidence/visibility is not grounded in that shot.`);}
  if(a.classification==='core'&&!(a.appearances||[]).some(p=>p.visibility==='visible'))errors.push(`${a.key}: a core visual asset needs a visible occurrence.`);
  if(a.existingId&&!(project.assetLibraries?.props||[]).some(p=>p.id===a.existingId))errors.push(`${a.key}: unknown existingId.`);
  if(a.parentKey&&!keys.has(a.parentKey))errors.push(`${a.key}: unknown parentKey.`);
  if(project.product?.name&&clean(a.name)===clean(project.product.name))errors.push(`${a.key}: locked product must not be recreated as a prop.`);
 }
 for(const d of decisions){if(!String(d.reason||'').trim()||!Array.isArray(d.assetKeys)||d.assetKeys.some(k=>!keys.has(k))||!['mapped','product','set_dressing','incidental','state_or_part'].includes(d.classification)||(d.classification==='mapped'&&!d.assetKeys.length))errors.push(`${d.id}: incomplete disposition.`);}
 return errors;
}
function apply(result,project,rows){
 const previous=project.assetLibraries?.props||[],idFor=new Map(result.assets.map(a=>[a.key,a.existingId||`prop_${hash(a.name).slice(0,12)}`]));
 const assets=result.assets.map(a=>{
  // Replay preserves physical design only for the same exact named identity;
  // generic aliases must never copy a different photograph's appearance.
  const prior=previous.find(p=>p.id===a.existingId&&clean(p.name)===clean(a.name))
   ||previous.find(p=>p.id===idFor.get(a.key)&&clean(p.name)===clean(a.name))||{},occurrences=a.appearances.filter(p=>p.visibility==='visible');
  return {...prior,id:idFor.get(a.key),name:clean(a.name),aliases:[...new Set([...(a.aliases||[]),...(prior.name&&prior.name!==a.name?[prior.name]:[])].map(clean).filter(Boolean))],
   description:prior.description||String(a.description||''),coreStory:a.classification==='core',assetRequired:a.classification==='core',purpose:a.reason,causalRole:a.reason,
   units:[...new Set(occurrences.map(p=>p.shotId))],sourceInventory:{version:VERSION,classification:a.classification,sourceQuotes:a.sourceQuotes,appearances:a.appearances,parentId:idFor.get(a.parentKey)||''}};
 });
 // Existing real assets are never deleted by reconciliation. Their old files
 // and selections remain reviewable; only new, source-bound refs are added.
 const protectedIds=new Set((project.candidates||[]).filter(c=>c.filePath&&c.stage==='prop_asset').map(c=>c.entityId));
 for(const p of previous)if(protectedIds.has(p.id)&&!assets.some(a=>a.id===p.id))assets.push(p);
 project.assetLibraries={...(project.assetLibraries||{}),props:assets};
 const ids=new Set(previous.map(p=>p.id));
 for(const s of project.shots||[]){
  s.propIds=[...new Set([...(s.propIds||[]).filter(id=>!ids.has(id)),...assets.filter(a=>a.sourceInventory?.classification==='core'&&a.units.includes(s.id)).map(a=>a.id)])];
  s.propNames=assets.filter(a=>a.sourceInventory?.classification==='core'&&a.units.includes(s.id)).map(a=>a.name);
  s.propBindings=(s.propBindings||[]).filter(b=>!ids.has(b.propId)||s.propIds.includes(b.propId));
 }
 project.sourcePropInventory={version:VERSION,status:'completed',fingerprint:fingerprint(project),identities:assets.filter(a=>a.sourceInventory).map(a=>({id:a.id,name:clean(a.name)})),declarations:rows,decisions:result.decisions,excludedAssets:result.excludedAssets||[],discardedUnverifiedAppearances:result.discardedUnverifiedAppearances||[],completedAt:new Date().toISOString()};
 return project;
}
async function reconcile({project,generate,save,status=()=>{}}){
 if(!pending(project))return project;
 const rows=declarations(project);let issues=[];
 const checkpoint=project.sourcePropInventoryCheckpoint;
 if(checkpoint?.fingerprint===fingerprint(project)&&checkpoint.lastResult){
  const cached=expandCompact(checkpoint.lastResult,project);
  issues=validate(cached,project,rows);
  if(!issues.length){apply(cached,project,rows);save(project);return project;}
 }
 const context={declarations:rows,productName:project.product?.name||'',existingNames:(project.assetLibraries?.props||[]).map(p=>p.name),evidence:contract.catalog(project)};
 let semantic=checkpoint?.fingerprint===fingerprint(project)?checkpoint.lastResult?.rawSemanticResponse:null;
 for(let attempt=0;attempt<2;attempt++){
  status(attempt?'正在只修正未通过的道具条目，正确条目保持不变':'正在从原稿证据表选择道具与出场关系，程序负责生成 ID 和引用');
  let scope=null;
  if(semantic&&issues.length){
   const prior=contract.compile(semantic,project,rows),badKeys=new Set(issues.map(x=>x.split(':')[0]));
   const global=issues.some(x=>!x.includes(':'));
   scope={objectNames:prior.assets.filter(a=>global||badKeys.has(a.key)).map(a=>a.name),declarationIds:prior.decisions.filter(d=>global||badKeys.has(d.id)||d.assetKeys.some(k=>badKeys.has(k))).map(d=>d.id)};
   for(const row of rows)if(!prior.decisions.some(d=>d.id===row.id))scope.declarationIds.push(row.id);
  }
  const response=await generate([{role:'system',content:contract.INSTRUCTION+require('./first-delivery-contract').forStage('inventory')+(scope?' Repair ONLY the listed objectNames and declarationIds. Return replacements for those entries only. All other entries are locked and will be preserved by code.':'')},{role:'user',content:JSON.stringify({...context,repair:issues,repairScope:scope,previous:scope?semantic:undefined})}],{json:true,maxAttempts:1,requiredKeys:['objects','coverage'],responseSchema:require('./stage-output-schemas').inventory(),agentStage:'planning',costOperation:'source_prop_inventory',maxTokens:8000});
  if(scope&&Array.isArray(response.objects)&&Array.isArray(response.coverage)){
   const lockedObjects=semantic.objects.filter(o=>!scope.objectNames.includes(o.name));
   const lockedCoverage=semantic.coverage.filter(d=>!scope.declarationIds.includes(d.declarationId));
   semantic={objects:[...lockedObjects,...response.objects.filter(o=>scope.objectNames.includes(o.name)||!semantic.objects.some(old=>old.name===o.name))],coverage:[...lockedCoverage,...response.coverage.filter(d=>scope.declarationIds.includes(d.declarationId))]};
  }else semantic=response;
  const result=expandCompact(contract.compile(semantic,project,rows),project);
  issues=validate(result,project,rows);
  project.sourcePropInventoryCheckpoint={fingerprint:fingerprint(project),lastResult:result,issues,savedAt:new Date().toISOString()};save(project);
  if(!issues.length){apply(result,project,rows);save(project);return project;}
 }
 throw Object.assign(Error('道具台账需要补齐原稿依据，已保留全部已完成内容；继续本阶段可修正。'),{code:'SOURCE_PROP_INVENTORY_INCOMPLETE',issues});
}
module.exports={VERSION,source,declarations,pending,fingerprint,identitiesCurrent,expandCompact,validate,apply,reconcile};

