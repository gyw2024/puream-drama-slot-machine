'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const delivery=require('../app/mcp/stage-delivery');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-stage-')),dir=path.join(root,'agent_test');fs.mkdirSync(dir);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({jobId:'agent_test',json:true,responseSchema:{type:'object',properties:{characters:{type:'array',items:{type:'object',properties:{id:{type:'string'},name:{type:'string'}},required:['id','name']}}},required:['characters']}}));fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'running'}));return dir;}
const data={characters:[{id:'zhou',name:'老周'},{id:'mei',name:'阿梅'}]};
test('sparse typed object fragments and exact JSON envelopes survive MCP save and final schema checks',async t=>{
 const dir=fixture(t),entry={type:'object',additionalProperties:false,properties:{evidence:{type:'string',minLength:1}},required:['evidence']},schema={type:'object',additionalProperties:false,properties:{checks:{type:'object',additionalProperties:false,properties:{S01:entry,S02:entry},required:['S01','S02']},ok:{type:'boolean'}},required:['checks','ok']};
 fs.writeFileSync(dir+'/request.json',JSON.stringify({jobId:'agent_test',json:true,responseSchema:schema,progressiveDelivery:true}));const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio'),client=new Client({name:'typed-parts-test',version:'1'});
 try{await client.connect(new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}));const advertised=(await client.listTools()).tools.find(t=>t.name==='stage_result_part').inputSchema;assert.deepEqual(advertised.properties.field.enum,['checks','ok']);assert.ok(advertised.properties.data.anyOf.some(s=>s.type==='object'&&s.properties.S01));
  let r=(await client.callTool({name:'stage_result_part',arguments:{field:'checks',index:5,data:JSON.stringify({S01:{evidence:'Agent exact evidence one'}})}})).structuredContent;assert.equal(r.status,'part_saved');assert.equal((await client.callTool({name:'submit_stage_result',arguments:{useStaged:true}})).structuredContent.status,'needs_revision');
  r=(await client.callTool({name:'stage_result_part',arguments:{field:'checks',index:9,data:{S01:{evidence:'conflicting overwrite'}}}})).structuredContent;assert.equal(r.status,'needs_revision');assert.match(r.findings[0].reason,/part 5/);
  assert.equal((await client.callTool({name:'stage_result_part',arguments:{field:'checks',index:9,data:{S02:{evidence:'Agent exact evidence two'}}}})).structuredContent.status,'part_saved');
  assert.equal((await client.callTool({name:'stage_result_part',arguments:{field:'ok',index:0,data:true}})).structuredContent.status,'part_saved');assert.equal((await client.callTool({name:'submit_stage_result',arguments:{useStaged:true}})).structuredContent.status,'saved');
  assert.deepEqual(delivery.read(dir).value,{checks:{S01:{evidence:'Agent exact evidence one'},S02:{evidence:'Agent exact evidence two'}},ok:true});const trace=fs.readFileSync(dir+'/mcp-part-submissions.jsonl','utf8').trim().split('\n').map(JSON.parse);assert.equal(trace[0].decodedJsonEnvelope,true);assert.equal(typeof trace[0].data,'string');
 }finally{await client.close();}
});
test('structured envelope decoding never extracts prose or coerces scalar creative text',()=>{
 const parts=require('../app/mcp/stage-parts');assert.deepEqual(parts.decodeData('true',{type:'boolean'}),{data:'true'});assert.deepEqual(parts.decodeData('{"id":"x"}',{type:'string'}),{data:'{"id":"x"}'});assert.deepEqual(parts.decodeData('Here is {"id":"x"}',{type:'object'}),{data:'Here is {"id":"x"}'});assert.deepEqual(parts.decodeData('[{"id":"x"}]',{type:'array'}),{data:[{id:'x'}],decodedJsonEnvelope:true});
});
test('adaptation row schema is readable and incomplete rows repair in the same MCP task',t=>{
 const dir=fixture(t),schema=require('../app/script-adaptation').adaptationResponseSchema('write_2_missing_1');
 fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({jobId:'agent_test',json:true,requiredKeys:['rows'],responseSchema:schema}));
 assert.deepEqual(delivery.readTask(dir).responseSchema,schema);
 const bad=delivery.submit(dir,{data:{rows:[{id:'P00106'}]}});assert.equal(bad.status,'needs_revision');assert.equal(delivery.read(dir),null);
 const corrected={rows:[{id:'P00106',text:'姜德山把粥碗放到柜台上。'}]};assert.equal(delivery.submit(dir,{data:corrected}).status,'saved');assert.deepEqual(delivery.read(dir).value,corrected);
});
test('progressive delivery advertises a small commit and resumes saved parts after a real MCP disconnect',async t=>{
 const dir=fixture(t),file=path.join(dir,'request.json'),request=JSON.parse(fs.readFileSync(file));request.progressiveDelivery=true;fs.writeFileSync(file,JSON.stringify(request));
 const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
 const connect=async()=>{const c=new Client({name:'progressive-client',version:'1'});await c.connect(new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}));return c;};
 let client=await connect();try{
  const tools=(await client.listTools()).tools;for(const name of ['preview_stage_result','submit_stage_result']){const schema=tools.find(t=>t.name===name).inputSchema;assert.deepEqual(schema.anyOf,[{required:['useStaged']},{required:['file']}]);assert.equal(schema.properties.data,undefined);assert.equal(schema.properties.useStaged.const,true);}
  assert.equal((await client.callTool({name:'stage_result_part',arguments:{field:'characters',index:0,data:[data.characters[0]]}})).structuredContent.status,'part_saved');
 }finally{await client.close();}
 client=await connect();try{
  const recovered=(await client.callTool({name:'stage_result_part',arguments:{field:'characters',index:0,read:true}})).structuredContent;assert.deepEqual(recovered.data,[data.characters[0]]);
  await client.callTool({name:'stage_result_part',arguments:{field:'characters',index:1,data:[data.characters[1]]}});
  assert.equal((await client.callTool({name:'submit_stage_result',arguments:{useStaged:true}})).structuredContent.status,'saved');assert.deepEqual(delivery.read(dir).value,data);
 }finally{await client.close();}
});
test('internal preview snapshots stay on the server and never re-enter the Agent task view',t=>{
 const dir=fixture(t),file=path.join(dir,'request.json'),request=JSON.parse(fs.readFileSync(file));
 request.messages=[{role:'user',content:'Only this one shot and its neighbors.'}];request.deliveryPreview={kind:'master-production-decision',project:{privateHistory:'server-only-snapshot'.repeat(10000),shots:[{id:'S01'}]}};
 fs.writeFileSync(file,JSON.stringify(request));const before=fs.readFileSync(file,'utf8');
 for(const visible of [delivery.modelView(request),delivery.readTask(dir)]){assert.deepEqual(visible.deliveryPreview,{kind:'master-production-decision'});assert.deepEqual(visible.messages,request.messages);assert.deepEqual(visible.responseSchema,request.responseSchema);assert.ok(!JSON.stringify(visible).includes('server-only-snapshot'));}
 assert.equal(fs.readFileSync(file,'utf8'),before,'the compiler still needs its original snapshot');
});
test('task reading returns only job-local attached images as native image content',t=>{
 const dir=fixture(t),file=path.join(dir,'evidence.png'),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');fs.writeFileSync(file,bytes);
 const request=JSON.parse(fs.readFileSync(path.join(dir,'request.json')));request.visionImages=[{path:file},{path:path.join(dir,'../outside.png')}];fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify(request));
 const result=require('../app/mcp/stage-delivery-server').taskResult(dir),images=result.content.filter(x=>x.type==='image');
 assert.equal(images.length,1);assert.equal(images[0].mimeType,'image/png');assert.deepEqual(Buffer.from(images[0].data,'base64'),bytes);
});
test('real MCP tool discovery exposes the job schema while incomplete drafts still receive repair feedback',async t=>{
 const dir=fixture(t),{Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
 const client=new Client({name:'schema-discovery-test',version:'1'});
 try{await client.connect(new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}));
  const listed=(await client.listTools()).tools;
  for(const name of ['preview_stage_result','submit_stage_result']){
   const schema=listed.find(x=>x.name===name).inputSchema.properties.data;
   assert.deepEqual(schema.required,['characters']);assert.deepEqual(schema.properties.characters.items.required,['id','name']);
   const response=await client.callTool({name,arguments:{data:{}}});
   assert.equal(response.structuredContent.status,'needs_revision');assert.equal(response.isError,undefined);
  }
 }finally{await client.close();}
});
test('incomplete submission stays in the same task as repair feedback, then saves exact authored data',t=>{const dir=fixture(t);assert.equal(delivery.submit(dir,{data:{}}).status,'needs_revision');assert.equal(delivery.read(dir),null);const first=delivery.submit(dir,{data});assert.equal(first.status,'saved');assert.deepEqual(delivery.read(dir).value,data);assert.equal(fs.readFileSync(path.join(dir,'mcp-submissions.jsonl'),'utf8').trim().split('\n').length,2);assert.equal(delivery.submit(dir,{data}).sha256,first.sha256);assert.equal(delivery.submit(dir,{data}).at,first.at);});
test('cancelled and completed tasks cannot be overwritten by late Agent calls',t=>{const dir=fixture(t);delivery.submit(dir,{data});fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'completed'}));assert.equal(delivery.submit(dir,{data}).reused,true);assert.equal(delivery.submit(dir,{data:{characters:[]}}).status,'closed');fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'cancelled'}));assert.equal(delivery.submit(dir,{data:{characters:[]}}).status,'closed');assert.deepEqual(delivery.read(dir).value,data);});
test('chat-like strings are not parsed into production objects and tampered receipts are rejected',t=>{const dir=fixture(t);assert.equal(delivery.submit(dir,{data:JSON.stringify(data)}).status,'needs_revision');delivery.submit(dir,{data});const p=path.join(dir,'mcp-result.json'),record=JSON.parse(fs.readFileSync(p,'utf8'));record.value.characters=[];fs.writeFileSync(p,JSON.stringify(record));assert.equal(delivery.read(dir),null);});
test('real stdio MCP client can submit, receive repair feedback, and save without chat parsing',async t=>{const dir=fixture(t);const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');const transport=new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}),client=new Client({name:'stage-test',version:'1'});try{await client.connect(transport);assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['read_stage_file','write_stage_file','read_stage_task','preview_stage_result','stage_result_part','submit_stage_result']);const bad=await client.callTool({name:'submit_stage_result',arguments:{data:{}}});assert.equal(bad.structuredContent.status,'needs_revision');const good=await client.callTool({name:'submit_stage_result',arguments:{data}});assert.equal(good.structuredContent.status,'saved');assert.deepEqual(delivery.read(dir).value,data);}finally{await client.close();}});

test('preview drafts survive task rereads without becoming authoritative and stopped tasks stay immutable',t=>{const dir=fixture(t);const first=delivery.previewTask(dir,{data});assert.equal(first.status,'not_required');assert.deepEqual(delivery.readTask(dir).priorPreview.input.data,data);assert.equal(delivery.read(dir),null);fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'interrupted'}));assert.equal(delivery.previewTask(dir,{data:{characters:[]}}).status,'closed');assert.deepEqual(delivery.readTask(dir).priorPreview.input.data,data);});

test('ordered staged parts survive restart, reject gaps, and commit exact Agent data once',t=>{
 const dir=fixture(t),parts=require('../app/mcp/stage-parts');
 assert.equal(parts.stage(dir,{field:'characters',index:1,data:[data.characters[1]]}).status,'part_saved');
 assert.equal(delivery.submit(dir,{useStaged:true}).status,'needs_revision');assert.equal(delivery.read(dir),null);
 assert.deepEqual(delivery.readTask(dir).stagedParts.map(x=>[x.field,x.index]),[['characters',1]]);
 assert.equal(parts.stage(dir,{field:'characters',index:0,data:[{id:'broken'}]}).status,'needs_revision');
 assert.deepEqual(parts.stage(dir,{field:'characters',index:1,read:true}).data,[data.characters[1]]);
 parts.stage(dir,{field:'characters',index:0,data:[data.characters[0]]});
 const receipt=delivery.submit(dir,{useStaged:true});assert.equal(receipt.status,'saved');assert.deepEqual(delivery.read(dir).value,data);
 assert.equal(delivery.submit(dir,{useStaged:true}).reused,true);
 fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'completed'}));assert.equal(parts.stage(dir,{field:'characters',index:0,data:[]}).status,'closed');assert.deepEqual(delivery.read(dir).value,data);
});

test('real MCP staged delivery preserves all characters across multiple tool calls',async t=>{
 const dir=fixture(t),{Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
 const client=new Client({name:'stage-parts-test',version:'1'});try{await client.connect(new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}));
 for(let index=0;index<data.characters.length;index++){const r=await client.callTool({name:'stage_result_part',arguments:{field:'characters',index,data:[data.characters[index]]}});assert.equal(r.structuredContent.status,'part_saved');}
 const r=await client.callTool({name:'submit_stage_result',arguments:{useStaged:true}});assert.equal(r.structuredContent.status,'saved');assert.deepEqual(delivery.read(dir).value,data);
 }finally{await client.close();}
});

test('native MCP recovery pages preserve every source character without oversized tool output',async t=>{
 const dir=fixture(t),file=path.join(dir,'request.json'),request=JSON.parse(fs.readFileSync(file));request.messages=[{role:'user',content:'原句含引号"、换行\n和表情😀。'.repeat(6000)}];fs.writeFileSync(file,JSON.stringify(request));
 const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio'),client=new Client({name:'bounded-recovery-test',version:'1'});
 try{await client.connect(new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}));const summary=await client.callTool({name:'read_stage_task',arguments:{}});assert.ok(JSON.stringify(summary).length<4000);assert.ok(summary.structuredContent.sections.some(s=>s.section==='messages'));let offset=0,joined='';
 do{const r=await client.callTool({name:'read_stage_task',arguments:{section:'messages',offset,length:7000}});assert.ok(r.structuredContent.fragment.length<=7000);assert.ok(r.content[0].text.length<18000);joined+=r.structuredContent.fragment;offset=r.structuredContent.nextOffset;}while(offset!==null);
 assert.deepEqual(JSON.parse(joined),request.messages);assert.deepEqual(JSON.parse(fs.readFileSync(file)).messages,request.messages);
 }finally{await client.close();}
});
