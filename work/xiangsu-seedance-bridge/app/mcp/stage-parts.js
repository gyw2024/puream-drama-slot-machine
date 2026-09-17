'use strict';
// Agent-selected top-level fields and ordered array parts. No screenplay parsing.
const fs=require('node:fs'),path=require('node:path');
const file=dir=>path.join(dir,'mcp-staged-parts.json');
function load(dir){return fs.existsSync(file(dir))?JSON.parse(fs.readFileSync(file(dir),'utf8')):{fields:{}};}
function manifest(dir){return Object.entries(load(dir).fields).flatMap(([field,parts])=>Object.entries(parts).map(([index,data])=>({field,index:Number(index),count:Array.isArray(data)?data.length:1,bytes:Buffer.byteLength(JSON.stringify(data))})));}
function declaredFields(req){return [...new Set([...Object.keys(req.responseSchema?.properties||{}),...(req.responseSchema?.required||[]),...(req.requiredKeys||[])])];}
function partCursor(parts={}){
 const savedIndexes=Object.keys(parts).map(Number).sort((a,b)=>a-b),missingRanges=[];let next=0;
 for(const index of savedIndexes){if(index>next)missingRanges.push([next,index-1]);next=index+1;}
 return {savedIndexes,missingRanges,nextPartIndex:missingRanges[0]?.[0]??next};
}
function kindOf(schema,state,field,data){return schema?.type||(state.kinds||{})[field]||(Array.isArray(Object.values(state.fields[field]||{})[0]??data)?'array':'single');}
function fragmentSchema(schema){if(schema.type==='array')return {type:'array',items:schema.items};if(schema.type==='object'){const part=structuredClone(schema);delete part.required;delete part.minProperties;return part;}return schema;}
// Top-level shape of a declared schema, for the MCP tool advertisements only.
//
// The exact output schema reaches the Agent through instructions.json, which the
// transport requires it to read in full. Advertising a second complete copy in
// the tool definitions put the very same 80k-character schema into the context
// twice more — permanently, on every turn. Tool discovery now advertises the
// shape it needs to know what to submit (declared fields, list/object kinds,
// required names) and defers the exact nested structure to instructions.json.
// Nothing is validated against this skeleton: submit_stage_result and
// stage_result_part still check real data against the full schema, so an Agent
// that consults instructions.json is unaffected and one that does not receives
// the same needs_revision feedback as before.
function interfaceSkeleton(schema,depth=5){
 if(!schema||typeof schema!=='object'||Array.isArray(schema))return {};
 const out={};
 if(typeof schema.type==='string')out.type=schema.type;
 if(schema.const!==undefined)out.const=schema.const;
 // Long enums are instance data, not interface shape; short ones help the Agent.
 if(Array.isArray(schema.enum)&&schema.enum.length<=12)out.enum=schema.enum;
 if(schema.additionalProperties===false)out.additionalProperties=false;
 if(depth<=1)return out;
 if(Array.isArray(schema.anyOf))out.anyOf=schema.anyOf.map(branch=>interfaceSkeleton(branch,depth-1));
 if(schema.properties){out.properties={};for(const [key,value]of Object.entries(schema.properties))out.properties[key]=interfaceSkeleton(value,depth-1);}
 if(schema.items)out.items=interfaceSkeleton(schema.items,depth-1);
 if(Array.isArray(schema.required))out.required=schema.required;
 return out;
}
function decodeData(value,schema){
 if(!['object','array'].includes(schema?.type))return {data:value};
 let candidate=value,decodedJsonEnvelope=false;
 if(typeof value==='string')try{candidate=JSON.parse(value);decodedJsonEnvelope=true;}catch{}
 // A complete declared item has exactly one list interpretation. Preserve
 // its fields and original submission; never infer or repair creative data.
 if(schema.type==='array'&&candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&schema.items&&require('../typed-output-receipt').conforms(candidate,schema.items))return {data:[candidate],decodedJsonEnvelope,wrappedSingleItem:true};
 if(schema.type==='array'?Array.isArray(candidate):candidate!==null&&typeof candidate==='object'&&!Array.isArray(candidate))return {data:candidate,...(decodedJsonEnvelope?{decodedJsonEnvelope:true}:{})};
 if(schema.type==='array'&&candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&schema.items)return {data:value,itemFindings:require('../agent-output-normalization').inspect(candidate,schema.items,'$.data[0]')};
 return {data:value};
}
function stage(dir,input){
 const job=JSON.parse(fs.readFileSync(path.join(dir,'job.json'),'utf8'));
 if(['cancelled','interrupted','failed','completed'].includes(job.status))return {ok:true,status:'closed'};
 const req=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8')),fields=declaredFields(req),schema=req.responseSchema?.properties?.[input.field]||{};
 if(!fields.includes(input.field)||['__proto__','constructor','prototype'].includes(input.field)||!Number.isSafeInteger(input.index)||input.index<0)return {ok:true,status:'needs_revision',allowedFields:fields,instruction:'Use one of allowedFields with a non-negative integer part index. If no fields are declared, submit the complete data through submit_stage_result instead of staging parts.'};
 const state=load(dir),parts=state.fields[input.field]||{};
 if(input.read===true)return {ok:true,status:Object.hasOwn(parts,input.index)?'found':'missing',field:input.field,index:input.index,data:parts[input.index]};
 if(input.data===undefined)return {ok:true,status:'needs_revision',instruction:'Supply data, or read:true to retrieve a saved part.'};
 const decoded=decodeData(input.data,schema),data=decoded.data,kind=kindOf(schema,state,input.field,data);
 if(decoded.itemFindings?.length)return {ok:true,status:'needs_revision',field:input.field,expectedType:kind,findings:decoded.itemFindings,instruction:'This object is not a complete declared list item. Correct the exact fields reported below, preserving the rest of the item. A nested event or partial field patch is not a replacement for a whole item. Read the saved part first when correcting it. Complete valid single items are accepted without re-authoring; no invalid content has replaced a saved part.'};
 if(kind==='array'?!Array.isArray(data):kind==='object'?!data||typeof data!=='object'||Array.isArray(data):input.index!==0||Array.isArray(data)&&kind==='single')return {ok:true,status:'needs_revision',field:input.field,expectedType:kind,instruction:'Array fields accept arrays; object fields accept objects with their actual named properties, not quoted prose. Arrays use consecutive indexes 0,1,...; object fragments use any non-negative unique part addresses; scalar fields use index 0 only.'};
 const findings=require('../agent-output-normalization').inspect(data,fragmentSchema(schema));
 if(kind==='object')for(const [index,other]of Object.entries(parts))if(Number(index)!==input.index)for(const key of Object.keys(data))if(Object.hasOwn(other,key))findings.push({path:`$.${input.field}.${key}`,reason:`Already saved in part ${index}; read and replace that part to correct this field. Do not overwrite it from a different part.`});
 if(findings.length)return {ok:true,status:'needs_revision',findings,instruction:'Repair this part only; previously saved parts are unchanged.'};
 fs.appendFileSync(path.join(dir,'mcp-part-submissions.jsonl'),JSON.stringify({at:new Date().toISOString(),field:input.field,index:input.index,data:input.data,decodedJsonEnvelope:decoded.decodedJsonEnvelope===true,wrappedSingleItem:decoded.wrappedSingleItem===true})+'\n');
 parts[input.index]=data;state.fields[input.field]=parts;state.kinds||={};state.kinds[input.field]=kind;
 const temp=file(dir)+'.tmp';fs.writeFileSync(temp,JSON.stringify(state),'utf8');fs.renameSync(temp,file(dir));
 const saved=manifest(dir),missingFields=(req.responseSchema?.required||req.requiredKeys||[]).filter(k=>!Object.hasOwn(state.fields,k));
 const shotParts=state.fields.shots||{},shotIndexes=Object.keys(shotParts).map(Number);let nextShotIndex=0;while(shotIndexes.includes(nextShotIndex))nextShotIndex++;
 const next=missingFields[0]||null;
 const cursors=Object.fromEntries(fields.map(field=>{
  const kind=req.responseSchema?.properties?.[field]?.type||state.kinds?.[field],cursor=partCursor(state.fields[field]);
  return [field,{kind,...cursor,...(kind!=='array'?{missingRanges:[],nextPartIndex:kind==='object'?cursor.nextPartIndex:0}:{}),consecutiveRequired:kind==='array'}];
 }));
 const cursor={missingFields,nextField:next,fields:cursors,indexAuthority:'Each array field has its OWN 0,1,2... sequence. Index is not a global counter across different fields. Read and replace the same saved index when correcting a part; do not append a duplicate.',...(fields.includes('shots')?{nextShotPartIndex:nextShotIndex,savedShotCount:Object.values(shotParts).reduce((n,x)=>n+(Array.isArray(x)?x.length:0),0)}:{})};
 const constructionFacts=require('../authoring-workspace').staged(req,state,input.field,data);
 return {ok:true,status:'part_saved',parts:saved,deliveryCursor:cursor,...(constructionFacts?{constructionFacts}:{}),instruction:`The saved content is durable in this same task. ${next?'The next unsaved required field is '+next+'.':'All required fields have at least one saved part.'} This is storage progress, not semantic approval or proof of completeness. Finish any missing content using the declared fields, preserve all source facts and requirements, and submit_stage_result useStaged:true when you have completed and reviewed the whole requested result. Do not repeat already saved content.`};
}
function assemble(dir){
 const req=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8')),data={},findings=[];
 const state=load(dir);
 for(const [field,parts]of Object.entries(state.fields)){
  const indexes=Object.keys(parts).map(Number).sort((a,b)=>a-b);
  const kind=kindOf(req.responseSchema?.properties?.[field],state,field,parts[indexes[0]]);
  // Object keys, not their storage addresses, define required coverage.
  if(kind!=='object'&&indexes.some((n,i)=>n!==i)){const cursor=partCursor(parts);findings.push({path:field,field,...cursor,reason:`This field has its own consecutive indexes starting at 0. Saved indexes: ${indexes.join(', ')}. Missing ranges: ${cursor.missingRanges.map(([a,b])=>a===b?String(a):a+'-'+b).join(', ')}. The first missing index is ${cursor.nextPartIndex}. Restore the actual missing content at those indexes; do not append later duplicates or assume gaps are empty.`});continue;}
  if(kind==='object'){const merged={};for(const index of indexes)for(const [key,value]of Object.entries(parts[index])){if(Object.hasOwn(merged,key))findings.push({path:`${field}.${key}`,reason:'Duplicate object field in saved parts; correct its original part.'});else Object.defineProperty(merged,key,{value,enumerable:true,writable:true,configurable:true});}data[field]=merged;}
  else data[field]=kind==='array'?indexes.flatMap(i=>parts[i]):parts[0];
 }
 return {data,findings};
}
module.exports={stage,manifest,assemble,fragmentSchema,interfaceSkeleton,decodeData,partCursor};
