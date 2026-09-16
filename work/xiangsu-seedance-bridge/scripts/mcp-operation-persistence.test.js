"use strict";
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),test=require("node:test"),assert=require("node:assert/strict");
const {McpAppController}=require("../app/mcp/app-controller");
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-operation-test-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return ()=>new McpAppController({store:{rootDir:root},workflow:{}});}
test("completed and failed operation receipts survive restart without rerunning work",async t=>{
 const create=fixture(t),first=create();let calls=0;
 const a=first.startOperation("generate_topics","p",async()=>{calls++;return {topics:[{id:"t1"}]};},{confirm_billable:true});
 const b=first.startOperation("analyze_script","p",async()=>{throw Object.assign(new Error("network unavailable"),{code:"NETWORK_ERROR"});},{confirm_billable:true});
 await tick();const second=create();
 assert.equal(second.operationRecord(a.operationId).status,"completed");assert.deepEqual(second.operationRecord(a.operationId).result,{topics:[{id:"t1"}]});
 assert.equal(second.operationRecord(b.operationId).status,"failed");assert.equal(second.operationRecord(b.operationId).errorCode,"NETWORK_ERROR");
 assert.equal(calls,1);assert.equal((await second.dispatch("list_operations",{project_id:"p"})).operations.length,2);
});
test("old running operation preserves identity as interrupted and cannot replay a runner",async t=>{
 const create=fixture(t),first=create();let calls=0;
 const a=first.startOperation("generate_topics","p",()=>{calls++;return new Promise(()=>{});},{confirm_billable:true});await tick();
 const second=create(),r=second.operationRecord(a.operationId);assert.equal(r.status,"interrupted");assert.equal(r.projectId,"p");assert.equal(r.recoverable,true);assert.equal(r.result,null);assert.equal(calls,1);
 assert.throws(()=>second.operationRecord("../../elsewhere"),{code:"MCP_OPERATION_NOT_FOUND"});
});
test("write failure before registration never starts billable work",async t=>{
 const create=fixture(t),first=create();let calls=0;first.persistOperation=()=>{throw new Error("disk full");};
 assert.throws(()=>first.startOperation("generate_topics","p",()=>{calls++;},{confirm_billable:true}),/disk full/);await tick();assert.equal(calls,0);
});
test("receipt write failure preserves an actual completed result rather than claiming generation failed",async t=>{
 const create=fixture(t),first=create();const persist=first.persistOperation.bind(first);let writes=0;
 first.persistOperation=r=>{if(writes++)throw Object.assign(new Error("disk full"),{code:"ENOSPC"});persist(r);};
 const a=first.startOperation("generate_topics","p",()=>({id:"saved-artifact"}),{confirm_billable:true});await tick();
 const r=first.operationRecord(a.operationId);assert.equal(r.status,"completed");assert.equal(r.result.id,"saved-artifact");assert.equal(r.persistenceError,"ENOSPC");
});
