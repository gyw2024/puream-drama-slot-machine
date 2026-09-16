'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const delivery=require('../app/mcp/stage-delivery'),parts=require('../app/mcp/stage-parts');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-required-keys-')),dir=path.join(root,'agent_test');fs.mkdirSync(dir);t.after(()=>{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});fs.writeFileSync(dir+'/job.json',JSON.stringify({status:'running'}));fs.writeFileSync(dir+'/request.json',JSON.stringify({jobId:'agent_test',json:true,requiredKeys:['topics']}));return dir;}
test('requiredKeys-only topics persist across real MCP sessions and submit without a schema',async t=>{
 const dir=fixture(t),{Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
 const connect=async()=>{const c=new Client({name:'required-keys-test',version:'1'});await c.connect(new StdioClientTransport({...delivery.launch(dir),stderr:'pipe'}));return c;};
 const authored=[{id:'T1',title:'original first topic'},{id:'T2',title:'original second topic'}];
 let c=await connect();try{const result=(await c.callTool({name:'stage_result_part',arguments:{field:'topics',index:0,data:[authored[0]]}})).structuredContent;assert.equal(result.status,'part_saved');assert.equal(result.deliveryCursor.nextField,null);assert.equal(result.deliveryCursor.nextShotPartIndex,undefined);}finally{await c.close();}
 c=await connect();try{assert.deepEqual((await c.callTool({name:'stage_result_part',arguments:{field:'topics',index:0,read:true}})).structuredContent.data,[authored[0]]);assert.equal((await c.callTool({name:'stage_result_part',arguments:{field:'topics',index:1,data:[authored[1]]}})).structuredContent.status,'part_saved');assert.equal((await c.callTool({name:'submit_stage_result',arguments:{useStaged:true}})).structuredContent.status,'saved');assert.deepEqual(delivery.read(dir).value,{topics:authored});}finally{await c.close();}
});
test('untyped declared fields still reject gaps, kind changes and undeclared keys',t=>{
 const dir=fixture(t);assert.equal(parts.stage(dir,{field:'topics',index:1,data:['second']}).status,'part_saved');assert.equal(delivery.submit(dir,{useStaged:true}).status,'needs_revision');assert.equal(parts.stage(dir,{field:'topics',index:0,data:{title:'not an array'}}).status,'needs_revision');
 const rejected=parts.stage(dir,{field:'shots',index:0,data:[]});assert.equal(rejected.status,'needs_revision');assert.deepEqual(rejected.allowedFields,['topics']);assert.equal(parts.stage(dir,{field:'__proto__',index:0,data:{}}).status,'needs_revision');
});

test('each array reports its own exact missing addresses while sparse object fragments remain valid',t=>{
 const dir=fixture(t);fs.writeFileSync(dir+'/request.json',JSON.stringify({responseSchema:{type:'object',properties:{issues:{type:'array',items:{type:'string'}},advisories:{type:'array',items:{type:'string'}},checks:{type:'object',properties:{S1:{type:'string'}},additionalProperties:false,required:['S1']}},required:['issues','advisories','checks']}}));
 parts.stage(dir,{field:'issues',index:0,data:[]});parts.stage(dir,{field:'issues',index:9,data:['actual last part']});
 parts.stage(dir,{field:'advisories',index:2,data:['advisory']});
 const saved=parts.stage(dir,{field:'checks',index:7,data:{S1:'Actual evidence'}});
 assert.deepEqual(saved.deliveryCursor.fields.issues.missingRanges,[[1,8]]);
 assert.equal(saved.deliveryCursor.fields.issues.nextPartIndex,1);
 assert.equal(saved.deliveryCursor.fields.advisories.nextPartIndex,0);
 assert.deepEqual(saved.deliveryCursor.fields.checks.missingRanges,[]);
 assert.equal(saved.deliveryCursor.fields.checks.consecutiveRequired,false);
 const result=parts.assemble(dir);assert.equal(result.findings.length,2);
 assert.deepEqual(result.findings.find(f=>f.field==='issues').savedIndexes,[0,9]);
 assert.deepEqual(result.data.checks,{S1:'Actual evidence'});
 assert.equal(result.data.issues,undefined,'never infer absent ordered chunks are empty');
 assert.deepEqual(parts.partCursor({0:[],9000000000000:[]}).missingRanges,[[1,8999999999999]],'large addresses must not allocate or loop through every missing index');
});
