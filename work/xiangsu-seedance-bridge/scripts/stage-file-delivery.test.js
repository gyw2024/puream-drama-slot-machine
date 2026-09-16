'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const files=require('../app/mcp/stage-files'),delivery=require('../app/mcp/stage-delivery');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-file-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({jobId:'test',json:true,requiredKeys:['story'],messages:[{role:'user',content:'保留全部原始对白'}]}));fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'running'}));return dir;}

test('local JSON syntax repair changes only one exact Unicode excerpt with CAS',t=>{
 const d=fixture(t),bad='{"story":["对白😀完整" "结尾完整"]}',r=files.write(d,{name:'result.json',text:bad});
 const rejected=files.resolve(d,{file:'result.json'}).feedback;
 assert.equal(rejected.savedDraft,true);assert.ok(rejected.repairLocation.text.includes('对白'));
 assert.equal(files.write(d,{name:'result.json',replaceText:'" "',text:'","',expectedSha256:'stale'}).status,'needs_revision');
 assert.equal(files.read(d,{name:'result.json'}).text,bad);
 const patched=files.write(d,{name:'result.json',replaceText:'" "',text:'","',expectedSha256:r.sha256});assert.equal(patched.patched,true);
 assert.equal(files.read(d,{name:'result.json'}).text,'{"story":["对白😀完整","结尾完整"]}');
 assert.equal(delivery.submit(d,{file:'result.json'}).status,'saved');
 assert.deepEqual(delivery.read(d).value.story,['对白😀完整','结尾完整']);
});
test('ambiguous or conflicting local edits preserve the entire draft',t=>{
 const d=fixture(t),r=files.write(d,{name:'result.json',text:'重复，重复'});
 for(const patch of [{replaceText:'重复',text:'修改'},{replaceText:'不存在',text:'修改'},{replaceText:'，',text:',',replace:true},{replaceText:'，',text:',',offset:0}])assert.equal(files.write(d,{name:'result.json',expectedSha256:r.sha256,...patch}).status,'needs_revision');
 assert.equal(files.read(d,{name:'result.json'}).text,'重复，重复');
});
test('exact paged source, append replay and authoritative file submission',t=>{const d=fixture(t);let s='',offset=0;do{const r=files.read(d,{name:'instructions.json',offset,length:17});s+=r.text;offset=r.nextOffset;}while(offset!==null);assert.equal(JSON.parse(s).messages[0].content,'保留全部原始对白');const a='{"story":';assert.equal(files.write(d,{name:'result.json',text:a,offset:0}).status,'saved');assert.equal(files.write(d,{name:'result.json',text:a,offset:0}).reused,true);assert.equal(delivery.submit(d,{file:'result.json'}).status,'needs_revision');assert.equal(files.write(d,{name:'result.json',text:'"完整结局"}',offset:a.length}).status,'saved');assert.equal(delivery.submit(d,{file:'result.json'}).status,'saved');assert.equal(delivery.read(d).value.story,'完整结局');});
test('repair requires current hash and cannot escape task or mutate closed jobs',t=>{const d=fixture(t);files.write(d,{name:'result.json',text:'bad',offset:0});assert.equal(files.write(d,{name:'result.json',text:'{}',replace:true}).status,'needs_revision');const r=files.read(d,{name:'result.json'});assert.equal(files.write(d,{name:'result.json',text:'{}',replace:true,expectedSha256:r.sha256}).status,'saved');assert.equal(files.read(d,{name:'../request.json'}).status,'needs_revision');fs.writeFileSync(path.join(d,'job.json'),'{"status":"completed"}');assert.equal(files.write(d,{name:'result.json',text:'x',offset:2}).status,'closed');});

test('optional offset permits first creation and exact full replay without guessing a nonempty continuation',t=>{
 const d=fixture(t),text='{"story":"完整正文😀与原话保留"}';
 assert.equal(files.write(d,{name:'result.json',text}).status,'saved');
 assert.equal(files.write(d,{name:'result.json',text}).reused,true);
 const conflict=files.write(d,{name:'result.json',text:'不能猜测这是不是续写'});
 assert.equal(conflict.status,'needs_revision');assert.equal(conflict.nextOffset,text.length);
 assert.equal(files.read(d,{name:'result.json'}).text,text);
 assert.equal(delivery.submit(d,{file:'result.json'}).status,'saved');
 assert.equal(delivery.read(d).value.story,'完整正文😀与原话保留');
});
test('real MCP file transfer survives disconnect and commits without resending the screenplay',async t=>{
 const d=fixture(t),f=path.join(d,'request.json'),r=JSON.parse(fs.readFileSync(f));r.jobId=path.basename(d);r.progressiveDelivery=true;fs.writeFileSync(f,JSON.stringify(r));
 const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
 const connect=async()=>{const c=new Client({name:'file-client',version:'1'});await c.connect(new StdioClientTransport({...delivery.launch(d),stderr:'pipe'}));return c;};
 let c=await connect();const first='{"story":"前因';
 try{assert.ok((await c.callTool({name:'read_stage_file',arguments:{name:'instructions.json'}})).structuredContent.text.includes('保留全部原始对白'));assert.equal((await c.callTool({name:'write_stage_file',arguments:{name:'result.json',text:first}})).structuredContent.status,'saved');await c.close();c=await connect();const draft=(await c.callTool({name:'read_stage_file',arguments:{name:'result.json'}})).structuredContent;assert.equal(draft.text,first);await c.callTool({name:'write_stage_file',arguments:{name:'result.json',text:'后果完整结局"}',offset:draft.totalCharacters}});assert.equal((await c.callTool({name:'submit_stage_result',arguments:{file:'result.json'}})).structuredContent.status,'saved');assert.equal(delivery.read(d).value.story,'前因后果完整结局');}finally{await c.close();}
});

test('file task pointers preserve the requested stage and recovery locates the real instructions',t=>{
 const d=fixture(t),f=path.join(d,'request.json'),request={jobId:'test',json:true,requiredKeys:['topics'],messages:[{role:'system',content:'本轮只写10个选题，不写剧本或审查。'}]};fs.writeFileSync(f,JSON.stringify(request));
 const pointer=delivery.taskPointer(request);assert.equal(pointer.taskFile,'instructions.json');assert.equal(pointer.resultFile,'result.json');assert.ok(!pointer.instruction.includes('Author one complete screenplay'));
 const recovered=require('../app/mcp/stage-delivery-server').taskResult(d).structuredContent;assert.ok(recovered.instruction.includes('instructions.json'));assert.ok(!recovered.instruction.includes('already in your initial request'));
 assert.deepEqual(JSON.parse(files.read(d,{name:pointer.taskFile}).text).messages,request.messages);const topics={topics:[{title:'只完成本轮选题'}]};assert.equal(delivery.submit(d,{data:topics}).status,'saved');assert.deepEqual(delivery.read(d).value,topics);
});

test('real MCP advertises and applies exact local repair without resending complete content',async t=>{
 const d=fixture(t),requestFile=path.join(d,'request.json'),req=JSON.parse(fs.readFileSync(requestFile));req.jobId=path.basename(d);req.progressiveDelivery=true;fs.writeFileSync(requestFile,JSON.stringify(req));
 const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
 const c=new Client({name:'local-patch-client',version:'1'});await c.connect(new StdioClientTransport({...delivery.launch(d),stderr:'pipe'}));
 try{
  const listed=await c.listTools();assert.ok(listed.tools.find(t=>t.name==='write_stage_file').inputSchema.properties.replaceText);
  const write=await c.callTool({name:'write_stage_file',arguments:{name:'result.json',text:'{"story":["保留原话" "保留结局"]}'}});
  const rejected=await c.callTool({name:'submit_stage_result',arguments:{file:'result.json'}});assert.equal(rejected.structuredContent.status,'needs_revision');
  const edit=await c.callTool({name:'write_stage_file',arguments:{name:'result.json',replaceText:'" "',text:'","',expectedSha256:write.structuredContent.sha256}});assert.equal(edit.structuredContent.patched,true);
  const accepted=await c.callTool({name:'submit_stage_result',arguments:{file:'result.json'}});assert.equal(accepted.structuredContent.status,'saved');assert.deepEqual(delivery.read(d).value.story,['保留原话','保留结局']);
 }finally{await c.close();}
});

test('inline data plus a not-yet-created output file persists once and survives file-only submission',async t=>{
 const dir=fixture(t),requestFile=path.join(dir,'request.json'),req=JSON.parse(fs.readFileSync(requestFile));req.jobId=path.basename(dir);req.responseSchema={type:'object',properties:{story:{type:'string'}},required:['story'],additionalProperties:false};fs.writeFileSync(requestFile,JSON.stringify(req));
 const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio'),client=new Client({name:'inline-file',version:'1'});await client.connect(new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}));
 try{const data={story:'完整对白与结局😀'};const preview=await client.callTool({name:'preview_stage_result',arguments:{data,file:'result.json'}});assert.notEqual(preview.structuredContent.status,'needs_revision');assert.equal(files.read(dir,{name:'result.json'}).text,JSON.stringify(data));assert.equal(delivery.read(dir),null);assert.equal((await client.callTool({name:'submit_stage_result',arguments:{file:'result.json'}})).structuredContent.status,'saved');assert.deepEqual(delivery.read(dir).value,data);}finally{await client.close();}
});
test('empty-file recovery preserves invalid payloads for schema repair and never overwrites existing or closed files',t=>{
 const dir=fixture(t),file=path.join(dir,'request.json'),req=JSON.parse(fs.readFileSync(file));req.responseSchema={type:'object',properties:{story:{type:'string'}},required:['story']};fs.writeFileSync(file,JSON.stringify(req));
 assert.equal(delivery.submit(dir,{file:'result.json',data:{}}).status,'needs_revision');assert.equal(files.read(dir,{name:'result.json'}).text,'{}');
 assert.equal(delivery.submit(dir,{file:'result.json',data:{story:'Must not overwrite selected existing file'}}).status,'needs_revision');assert.equal(files.read(dir,{name:'result.json'}).text,'{}');
 const stopped=fixture(t);fs.writeFileSync(path.join(stopped,'job.json'),JSON.stringify({status:'cancelled'}));assert.equal(delivery.submit(stopped,{file:'result.json',data:{story:'late'}}).status,'closed');assert.equal(files.read(stopped,{name:'result.json'}).text,'');
 const empty=fixture(t);assert.equal(files.resolve(empty,{file:'result.json'}).feedback.savedDraft,false);
});
