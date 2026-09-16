'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const parts=require('../app/mcp/stage-parts');
const schema={type:'array',items:{type:'object',additionalProperties:false,properties:{shotId:{const:'S1'},dialogue:{type:'array',items:{type:'string'},minItems:1}},required:['shotId','dialogue']}};
for(const encoded of [false,true])test('one complete typed item is stored without re-authoring, encoded='+encoded,t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-singleton-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'running'}));fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({responseSchema:{properties:{items:schema},required:['items']}}));
 const row={shotId:'S1',dialogue:['完整对白，不可删改。']},data=encoded?JSON.stringify(row):row,before=structuredClone(data);
 const r=parts.stage(dir,{field:'items',index:0,data});assert.equal(r.status,'part_saved');assert.deepEqual(data,before);assert.deepEqual(parts.assemble(dir).data,{items:[row]});
 const receipt=JSON.parse(fs.readFileSync(path.join(dir,'mcp-part-submissions.jsonl'),'utf8').trim());assert.deepEqual(receipt.data,data);assert.equal(receipt.wrappedSingleItem,true);
});
test('partial or foreign objects and prose cannot be silently promoted to valid rows',()=>{
 for(const data of [{shotId:'S1'},{shotId:'other',dialogue:['x']},{shotId:'S1',dialogue:['x'],extra:'not declared'},{items:[{shotId:'S1',dialogue:['x']}]},'Here is the script']){
  const r=parts.decodeData(data,schema);assert.equal(r.wrappedSingleItem,undefined);assert.deepEqual(r.data,data);
 }
 const object={type:'object',properties:{a:{type:'string'}}},data={a:'x'};assert.deepEqual(parts.decodeData(data,object),{data});
});

test('an invalid singleton reports its actual missing fields without overwriting a saved item',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-singleton-feedback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify({status:'running'}));fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({responseSchema:{properties:{items:schema},required:['items']}}));
 const saved={shotId:'S1',dialogue:['原始完整对白']};assert.equal(parts.stage(dir,{field:'items',index:0,data:saved}).status,'part_saved');
 for(const data of [{shotId:'S1'},JSON.stringify({shotId:'S1'})]){
  const r=parts.stage(dir,{field:'items',index:0,data});assert.equal(r.status,'needs_revision');
  assert.ok(r.findings.some(f=>f.path==='$.data[0].dialogue'&&f.reason==='missing required field'));
  assert.deepEqual(parts.assemble(dir).data,{items:[saved]});
 }
 const nested=parts.stage(dir,{field:'items',index:0,data:{eventId:'E1'}});assert.ok(nested.findings.some(f=>f.path.endsWith('.shotId')));
 assert.deepEqual(parts.assemble(dir).data,{items:[saved]});
});
