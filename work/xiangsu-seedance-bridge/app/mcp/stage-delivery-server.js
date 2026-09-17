'use strict';
const fs=require('node:fs'),path=require('node:path');
const {McpServer}=require('@modelcontextprotocol/server');
const {serveStdio}=require('@modelcontextprotocol/server/stdio');
const {z}=require('zod');
function deliveryInputSchema(request){
 const envelope=z.object({data:z.unknown().optional(),text:z.string().optional(),useStaged:z.boolean().optional(),file:z.enum(['result.json','result.txt']).optional()});
 const advertised=request.progressiveDelivery
  ?{type:'object',additionalProperties:false,properties:{useStaged:{type:'boolean',const:true},file:{type:'string',enum:['result.json']}},anyOf:[{required:['useStaged']},{required:['file']}],description:'Commit a saved result.json file, or the parts already saved using stage_result_part.'}
  :{type:'object',additionalProperties:false,properties:{data:request.json&&request.responseSchema?require('./stage-parts').interfaceSkeleton(request.responseSchema):{},text:{type:'string'},useStaged:{type:'boolean'},file:{type:'string',enum:['result.json','result.txt']}}};
 // Describe the real job fields at the point where the Agent calls the tool.
 // Keep validation in the handler so malformed drafts are retained and receive
 // actionable needs_revision feedback instead of an SDK-level rejection.
 return {'~standard':{version:1,vendor:'puream',validate:value=>envelope['~standard'].validate(value),jsonSchema:{input:()=>advertised,output:()=>advertised}}};
}
function partInputSchema(request){
 const envelope=z.object({field:z.string(),index:z.number().int().min(0),data:z.unknown().optional(),read:z.boolean().optional()});
 const entries=Object.entries(request.responseSchema?.properties||{}),fields=[...new Set([...entries.map(([key])=>key),...(request.requiredKeys||[])])];
 const advertised={type:'object',additionalProperties:false,properties:{field:{type:'string',...(fields.length?{enum:fields}:{})},index:{type:'integer',minimum:0},data:entries.length?{anyOf:entries.map(([,schema])=>{const parts=require('./stage-parts');return parts.interfaceSkeleton(parts.fragmentSchema(schema));})}:{},read:{type:'boolean'}},required:['field','index'],description:'data is the actual typed value of the selected field. Object fragments retain real property names; array fragments are arrays. Do not quote an object as text. Fragments remain in this one task. Object fragment indexes are storage addresses; arrays retain consecutive ordering. This is the top-level shape only: instructions.json carries the exact nested structure for every declared field, and read_stage_task section "responseSchema" can page to it directly. Saved parts are validated against the full schema.'};
 return {'~standard':{version:1,vendor:'puream',validate:value=>envelope['~standard'].validate(value),jsonSchema:{input:()=>advertised,output:()=>advertised}}};
}
function taskResult(dir,input={}){
 const request=require('./stage-delivery').readTask(dir);
 const sections=['messages','responseSchema','priorPreview','stagedParts'];
 const serialized=Object.fromEntries(sections.filter(key=>request[key]!==undefined).map(key=>[key,JSON.stringify(request[key])]));
 let value;
 if(input.section&&Object.hasOwn(serialized,input.section)){
  const text=serialized[input.section],offset=Math.min(text.length,Math.max(0,Math.trunc(input.offset||0))),length=Math.min(8000,Math.max(1,Math.trunc(input.length||8000)));
  const end=Math.min(text.length,offset+length);
  value={jobId:request.jobId,section:input.section,encoding:'JSON text; concatenate fragments in offset order before decoding',offset,nextOffset:end<text.length?end:null,totalCharacters:text.length,fragment:text.slice(offset,end)};
 }else value={jobId:request.jobId,json:request.json,requiredKeys:request.requiredKeys,deliveryPreview:request.deliveryPreview,stagedParts:(request.stagedParts||[]).slice(0,40),stagedPartCount:(request.stagedParts||[]).length,sections:Object.entries(serialized).map(([section,text])=>({section,totalCharacters:text.length})),instruction:'Read instructions.json with read_stage_file for the complete scoped task, source and schema; follow nextOffset until null. This is its recovery manifest, not a new authoring task. Section/offset/length can also retrieve exact preserved source/schema/draft pages. Use stage_result_part read:true for a saved part. No source content was discarded.'};
 const content=[{type:'text',text:JSON.stringify(value)}];
 for(const item of input.section?[]:request.visionImages||[]){
  const file=path.resolve(item.path),relative=path.relative(dir,file);
  if(relative.startsWith('..')||path.isAbsolute(relative))continue;
  const mimeType={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(file).toLowerCase()];
  if(mimeType&&fs.existsSync(file)&&fs.statSync(file).size<=30*1024*1024)content.push({type:'image',mimeType,data:fs.readFileSync(file).toString('base64')});
 }
 return {content,structuredContent:value};
}
async function main(){
 const dir=path.resolve(process.argv.at(-1));
 const request=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));
 if(path.basename(dir)!==request.jobId)throw Error('Task directory does not match request');
 const server=new McpServer({name:'puream_delivery',version:'1.0.0'});
 const inputSchema=deliveryInputSchema(request);
 const result=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v});
 server.registerTool('read_stage_file',{description:'Read task inputs (writing-task.txt: all writing requirements and source; schema.json: storage structure; instructions.json: full request) or a saved draft/result. Follow nextOffset until null. Files are compact JSON without indentation; page them by character offset.',inputSchema:z.object({name:z.enum(['writing-task.txt','draft.txt','instructions.json','schema.json','result.json','result.txt']),offset:z.number().int().min(0).optional(),length:z.number().int().min(1).max(24000).optional()}),annotations:{readOnlyHint:true}},input=>result(require('./stage-files').read(dir,input)));
 server.registerTool('write_stage_file',{description:'Persist this task output in draft.txt or result.json/result.txt within the SAME task. The first write may omit offset (it starts at 0). For subsequent chunks supply the returned character count as offset. Exact whole-file replays and repeated chunks are idempotent. For local repair supply replaceText (an exact unique old excerpt), text (its replacement), and current expectedSha256. Only use replace:true for deliberate whole-file replacement. Incomplete files are drafts, never completed results.',inputSchema:z.object({name:z.enum(['draft.txt','result.json','result.txt']),text:z.string(),offset:z.number().int().min(0).optional(),replace:z.boolean().optional(),replaceText:z.string().min(1).optional(),expectedSha256:z.string().optional()}),annotations:{destructiveHint:false,idempotentHint:true}},input=>result(require('./stage-files').write(dir,input)));
 server.registerTool('read_stage_task',{description:'Read this task recovery manifest and original evidence images. Full instructions are in instructions.json via read_stage_file. Read exact source, schema, prior preview or staged manifest in bounded pages using section/offset/length when needed.',inputSchema:z.object({section:z.enum(['messages','responseSchema','priorPreview','stagedParts']).optional(),offset:z.number().int().min(0).optional(),length:z.number().int().min(1).max(8000).optional()}),annotations:{readOnlyHint:true}},input=>taskResult(dir,input));
 server.registerTool('preview_stage_result',{description:'Preview the exact final bound request and measured capacity. Preserve this task draft for recovery without committing production data or generating media. Revise the same draft before submitting.',inputSchema,annotations:{destructiveHint:false,idempotentHint:true}},input=>result(require('./stage-delivery').previewTask(dir,input)));
 server.registerTool('stage_result_part',{description:'Save or read an Agent-authored typed field. Arrays use consecutive indexes from0; disjoint object-property fragments may use any non-negative unique part addresses; scalar fields use index0. Read and replace the original part when correcting an existing property. Finish via submit_stage_result useStaged:true. These saves remain in ONE task.',inputSchema:partInputSchema(request),annotations:{destructiveHint:false,idempotentHint:true}},input=>result(require('./stage-parts').stage(dir,input)));
 server.registerTool('submit_stage_result',{description:'Save your authored stage data. The saved receipt is authoritative. needs_revision is feedback for you to repair in this session, not task failure. The advertised data schema shows the top-level shape only; instructions.json holds the exact nested structure for this stage and is checked against the real submission.',inputSchema,annotations:{destructiveHint:false,idempotentHint:true}},input=>result(require('./stage-delivery').submit(dir,input)));
 await serveStdio(()=>server,{legacy:'serve'});
}
module.exports={main,deliveryInputSchema,partInputSchema,taskResult};if(require.main===module)main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
