'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
test('operation polling uses existing authenticated connection without full project health scan',async()=>{
 const root=path.resolve(__dirname,'../../../.codex_tests/TASK-20260913-AGENT-296');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'busy-control-')),file=path.join(dir,'connection.json');
 const calls=[];const gateway=require('../app/mcp/control-gateway').startControlGateway({connectionFile:file,controller:{dispatch:async method=>{calls.push(method);assert.equal(method,'get_operation');return {ok:true,operation:{status:'running'}};}}});
 const previous=process.env.PUREAM_MCP_CONNECTION_FILE;process.env.PUREAM_MCP_CONNECTION_FILE=file;
 try{await new Promise(r=>gateway.server.once('listening',r));const result=await require('../app/mcp/control-client').invokeApp('get_operation',{operation_id:'accepted'});assert.equal(result.operation.status,'running');assert.deepEqual(calls,['get_operation']);}
 finally{gateway.close();if(previous===undefined)delete process.env.PUREAM_MCP_CONNECTION_FILE;else process.env.PUREAM_MCP_CONNECTION_FILE=previous;}
});
test('adaptation API invokes the same preview and apply workflow as UI',async()=>{
 const calls=[];const {McpAppController}=require('../app/mcp/app-controller');const c=new McpAppController({store:{},workflow:{adaptReferenceScript:async(...a)=>{calls.push(a);return {id:'draft'};},applyScriptAdaptation:(...a)=>{calls.push(a);return {id:'new-project'};}}});
 const r=await c.dispatch('adapt_reference_script',{project_id:'source',source_text:'原稿',instructions:'改名',confirm_billable:true});await new Promise(setImmediate);assert.equal(c.operationRecord(r.operation.operationId).status,'completed');
 const applied=await c.dispatch('apply_script_adaptation',{project_id:'source',draft_id:'draft',accept_warnings:false});assert.equal(applied.project.id,'new-project');assert.deepEqual(calls,[['source','原稿','改名'],['source','draft',false]]);
});
