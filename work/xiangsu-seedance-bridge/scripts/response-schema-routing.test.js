'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const runtime=require('../app/local-agent-runtime'),provider=require('../app/ai-provider'),parts=require('../app/mcp/stage-parts'),delivery=require('../app/mcp/stage-delivery');
const schema={type:'object',required:['topics'],properties:{topics:{type:'array',items:{type:'object',required:['title'],properties:{title:{type:'string'}}}}}};
test('public and direct Agent entry preserve legacy schema across quoted MCP array parts',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-schema-route-')),hub=runtime.getHub(root),old=hub.run;
 t.after(()=>{hub.run=old;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 let calls=0;
 hub.run=async (_profile,request)=>{
  calls++;assert.deepEqual(request.responseSchema,schema);const dir=path.join(root,'agent_'+calls);fs.mkdirSync(dir);
  fs.writeFileSync(dir+'/job.json',JSON.stringify({status:'running'}));fs.writeFileSync(dir+'/request.json',JSON.stringify({...request,jobId:'agent_'+calls}));
  for(let i=0;i<2;i++){const r=parts.stage(dir,{field:'topics',index:i,data:JSON.stringify([{title:'Original '+i}])});assert.equal(r.status,'part_saved');assert.equal(r.deliveryCursor.fields.topics.kind,'array');assert.equal(r.deliveryCursor.fields.topics.nextPartIndex,i+1);}
  assert.equal(delivery.submit(dir,{useStaged:true}).status,'saved');const saved=delivery.read(dir);
  assert.deepEqual(saved.value,{topics:[{title:'Original 0'},{title:'Original 1'}]});
  return {mcpReceipt:saved.receipt,text:JSON.stringify(saved.value),jobId:'agent_'+calls,agentId:'workbuddy'};
 };
 const config={localAgent:{id:'workbuddy',rootDir:root}},options={json:true,requiredKeys:['topics'],responseJsonSchema:schema};
 assert.deepEqual(await provider.generateText(config,[],options),{topics:[{title:'Original 0'},{title:'Original 1'}]});
 assert.deepEqual(JSON.parse(await runtime.generateAgentText(config,[],options)),{topics:[{title:'Original 0'},{title:'Original 1'}]});
 assert.equal(calls,2);assert.equal(options.responseSchema,undefined,'caller options remain unchanged');
});
test('explicit transport contract wins and invalid aliases are not invented schemas',()=>{
 const {normalize}=require('../app/response-schema-contract'),explicit={type:'string'},options={responseSchema:explicit,responseJsonSchema:schema};
 assert.equal(normalize(options),options);assert.equal(normalize(options).responseSchema,explicit);
 for(const alias of [null,[],true,'text']){const options={responseJsonSchema:alias};assert.equal(normalize(options),options);}
});
