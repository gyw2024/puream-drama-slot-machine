'use strict';
const VERSION='prompt-audit-source-and-prompt-facts-v9-speech-authority';
function catalog(source){
 const rows=[],seen=new Map();
 function visit(value,path,context={}){
  if(path==='source.script')context={namespace:'original_screenplay',role:'whole_story_source',shotNumberAuthority:false};
  if(path==='source.storyContext')context={namespace:'original_screenplay',role:'read_only_story_chronology',shotNumberAuthority:false};
  if(/\.masterAgentDecision$/.test(path))context={...context,authority:'derived_proposal_under_review'};
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean'){
   for(const [i,line] of String(value).split(/\r?\n/).entries()){
    if(!line.trim())continue;
    const key=JSON.stringify(context)+'\n'+line;
    if(seen.has(key)){seen.get(key).paths.push(`${path}:${i+1}`);continue;}
    const row={id:`F${String(rows.length+1).padStart(4,'0')}`,context,paths:[`${path}:${i+1}`],text:line};rows.push(row);seen.set(key,row);
   }
  }else if(Array.isArray(value))value.forEach((v,i)=>visit(v,`${path}[${i}]`,context));
  else if(value&&typeof value==='object'){
   const type=path.match(/^source\.(shots|characters|scenes|props)\[\d+\]$/)?.[1];
   if(type)context={entityType:({shots:'shot',characters:'character',scenes:'scene',props:'prop'})[type],entityId:value.id||value.shotId,name:value.name||'',...(type==='shots'?{role:(source.readOnlyNeighborShotIds||[]).includes(value.id)?'read_only_neighbor':'current'}:{})};
   if(type==='shots')context={...context,namespace:'canonical_production',shotNumberAuthority:true};
   if(value.sourceDialogueId)context={...context,sourceDialogueId:value.sourceDialogueId};
   Object.entries(value).forEach(([k,v])=>visit(v,path?`${path}.${k}`:k,context));
  }
 }
 visit(source,'source');return rows;
}
function promptCatalog(items){return items.flatMap((item,i)=>String(item.prompt||'').split(/\r?\n/).flatMap((text,j)=>text.trim()?[{id:`P${i+1}L${j+1}`,itemId:item.id,text}]:[]));}
function wirePayload(payload){
 const contexts=[],keys=new Map();
 const rows=payload.sourceFacts.map(f=>{const key=JSON.stringify(f.context);if(!keys.has(key)){keys.set(key,contexts.length);contexts.push(f.context);}return [f.id,keys.get(key),f.paths,f.text];});
 return {...payload,items:payload.items.map(({prompt,...item})=>item),sourceFacts:{columns:['id','contextIndex','paths','text'],contexts,rows},catalogEncoding:'sourceFacts.rows use the listed columns; contextIndex refers to sourceFacts.contexts. All source text and IDs are exact. The complete executable prompt appears once in promptFacts in line order, grouped by itemId; items.displayPrompt is its human-facing Chinese mirror. Cite the original F and P IDs.'};
}
function schema(facts=[],items=[]){
 const string={type:'string',minLength:1};
 const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
 const promptFacts=promptCatalog(items);
 const row=item=>{const relevant=facts.filter(f=>!item||item.entityType!=='shot'||f.context?.entityType!=='shot'||f.context.entityId===item.entityId),pf=promptFacts.filter(f=>!item||f.itemId===item.id);
  const issue=object({sourceFactId:relevant.length?{type:'string',enum:relevant.map(f=>f.id)}:string,promptFactId:pf.length?{type:'string',enum:pf.map(f=>f.id)}:string,contradiction:string,repair:string});
  issue.properties.boundarySourceFactIds={type:'array',items:facts.length?{type:'string',enum:facts.map(f=>f.id)}:string};
   return object({id:item?{const:item.id,type:'string'}:string,issues:{type:'array',items:issue}});
 };
 return object({items:{type:'array',...(items.length?{minItems:items.length,maxItems:items.length}:{}),items:items.length?{anyOf:items.map(row)}:row()}});
}
function bind(result,facts,items){
 // Preserve every negative finding when a transport duplicates an item row.
 // Coalesce before assigning finding IDs so verification never receives an
 // impossible duplicate-ID contract. Raw native receipts remain in the job.
 if(Array.isArray(result?.items)){
  const grouped=new Map();
  for(const row of result.items){
   if(!items.some(item=>item.id===row.id)||!Array.isArray(row.issues))throw Object.assign(Error('审核条目身份或问题列表无效'),{code:'PROMPT_AUDIT_EVIDENCE_INVALID'});
   if(!grouped.has(row.id))grouped.set(row.id,{...row,issues:[]});
   grouped.get(row.id).issues.push(...row.issues);
  }
  result={...result,items:[...grouped.values()]};
 }
 const index=new Map(facts.map(f=>[f.id,f])),prompts=new Map(promptCatalog(items).map(f=>[f.id,f]));
 if(!Array.isArray(result?.items))return result;
 return {...result,items:result.items.map(item=>({...item,issues:Array.isArray(item.issues)?item.issues.map(issue=>{
  if(!issue||typeof issue!=='object'||Array.isArray(issue))return issue;
  const row=index.get(issue.sourceFactId),prompt=items.find(x=>x.id===item.id)?.prompt||'';
  const target=items.find(x=>x.id===item.id);
  if(target?.entityType==='shot'&&row?.context?.entityType==='shot'&&row.context.entityId!==target.entityId)throw Object.assign(Error('审核把相邻镜头的事实当成本镜要求'),{code:'PROMPT_AUDIT_EVIDENCE_INVALID',itemId:item.id});
  if(issue.promptFactId){const fact=prompts.get(issue.promptFactId);if(!fact||fact.itemId!==item.id)throw Object.assign(Error('审核引用了其他提示词或不存在的行'),{code:'PROMPT_AUDIT_EVIDENCE_INVALID',itemId:item.id});issue={...issue,promptQuote:fact.text};}
  if(!row||typeof issue.promptQuote!=='string'||!issue.promptQuote.trim()||!prompt.includes(issue.promptQuote))throw Object.assign(Error('审核引文未匹配输入事实或实际提示词；不能据此要求重写'),{code:'PROMPT_AUDIT_EVIDENCE_INVALID',itemId:item.id});
  const boundary=(issue.boundarySourceFactIds||[]).map(id=>{const fact=index.get(id);if(!fact)throw Object.assign(Error('衔接证据ID不存在'),{code:'PROMPT_AUDIT_EVIDENCE_INVALID'});return fact;});
   return {sourceQuote:row.text+(boundary.length?'\nRead-only boundary evidence (not actions to perform here): '+boundary.map(f=>f.text).join('\n'):''),promptQuote:issue.promptQuote,contradiction:issue.contradiction,repair:issue.repair};
 }):item.issues}))};
}
const INSTRUCTION='Use sourceFacts and promptFacts as immutable evidence catalogs. Each actual issue MUST identify one sourceFactId and one promptFactId belonging to the current itemId. For a cross-shot continuity finding, optionally cite boundarySourceFactIds as read-only adjacent evidence in addition to the current source/prompt pair. Never execute the neighbor content in this clip. The app inserts both exact original quotations from these IDs; never retype or paraphrase quotes. Return issues=[] when no concrete contradiction exists. Never add placeholder findings or fill an issue slot with a non-issue. User requirements outrank generated screenplay, clocks and prior approvals. Check both user compliance and source fidelity: identical wrong source/prompt timing or an unsupported claim is still a defect. Independently calculate each actual speech window and genuine no-dialogue interval, including adjacent boundaries. If the source is wrong, cite the relevant user requirement and actual prompt evidence and request the smallest upstream Agent repair plus dependent prompt regeneration; do not silently rewrite the original file. Do not redefine scene identities, move another shot’s words here, or invent a compulsory gesture. Silent actions and motivated cuts are valid only when all user timing and complete-speech requirements hold. Judge listener identity, facing and gaze from the actual acting situation; avoid an arbitrary eye-turn preference while detecting a concrete wrong addressee or contradictory gaze. Follow the explicit reference manifest; Subject 1 is not necessarily C01. Scope every finding to the current item only: a video item is ONE clip, never the whole film. A rule saying only the tagged dialogue is spoken refers only to that clip, so other film lines are not missing. Do not infer that an action is already completed from the overview of a scene, neighboring unit, summaryEn, or an empty-set asset description: current shot stateBefore/action/turns/stateAfter define its actual timing, and a summary narrates the whole transition. Scene asset sourceDescription may replace actor names with spatial placeholders and is NOT acting evidence. Referenced prop identity and its animated holder/state are independent: a reference image need not itself depict the holder or motion. A set chair or incidental object may legitimately have no separate picture reference; never require an extra generated image from that absence alone. Report a missing image binding only if an explicit current core-asset contract requires it.';
const SHOT_NAMESPACE_INSTRUCTION=' ORIGINAL AND PRODUCTION NUMBERING ARE DISTINCT: original_screenplay facts retain the complete unchanged user manuscript. Any S01/S38/shot number inside that text is an ORIGINAL label, never an identity match for canonical_production shots. Regrouping can produce a different number of clips. Locate the current production clip in the original by its exact dialogue text, immutable sourceDialogueId/sourceDialogueBindings and causal action, not by equal numeric labels or array positions. Before alleging a source contradiction, establish that the cited original event belongs to this clip using those content bindings. If that association is uncertain, do not declare a defect by matching numbers. Keep original narrative authority: a derived action can still be wrong, but show the actual content association rather than treating original shot N as production shot N.';
module.exports={VERSION,catalog,promptCatalog,schema,bind,INSTRUCTION:INSTRUCTION+SHOT_NAMESPACE_INSTRUCTION+'\n'+require('./screenplay-time-authority').INSTRUCTION+'\n'+require('./agent-speech-authority').INSTRUCTION,wirePayload};
