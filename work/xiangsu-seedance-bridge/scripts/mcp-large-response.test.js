'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events');
const {startControlGateway}=require('../app/mcp/control-gateway');
const {readConnection,requestConnection}=require('../app/mcp/control-client');
const files=require('../app/mcp/control-response-files');
function temporary(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-response-test-'));
 t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 return root;
}
test('large authenticated project round-trips beyond 8MiB without dropping history or unicode',async t=>{
 const dir=temporary(t),file=path.join(dir,'control.json');
 const project={id:'large-project',script:{history:'剧本😀\n'.repeat(900000)},shots:[{id:'S1',dialogue:'完整对白'}]};
 assert.ok(Buffer.byteLength(JSON.stringify(project))>8*1024*1024);
 const gateway=startControlGateway({connectionFile:file,controller:{dispatch:async method=>method==='get_project'?{ok:true,project}:{ok:true,status:'running'}}});
 t.after(()=>gateway.close());await once(gateway.server,'listening');
 const conn=readConnection(file),actual=await requestConnection(conn,'get_project',{},10000);
 assert.deepEqual(actual,{ok:true,project});assert.deepEqual(await requestConnection(conn,'status'),{ok:true,status:'running'});
 const responseDir=path.join(dir,'mcp-control-responses',gateway.instanceId);
 for(let n=0;n<20&&fs.readdirSync(responseDir).length;n++)await new Promise(r=>setTimeout(r,5));
 assert.deepEqual(fs.readdirSync(responseDir),[],'response lifetime ends after client read');
});
test('legacy clients keep ordinary inline replies and authentication remains required',async t=>{
 const dir=temporary(t),file=path.join(dir,'control.json');
 const gateway=startControlGateway({connectionFile:file,controller:{dispatch:async()=>({ok:true,value:'legacy'})}});t.after(()=>gateway.close());await once(gateway.server,'listening');
 const conn=readConnection(file);
 const socket=net.createConnection(conn.pipeName);socket.setEncoding('utf8');await once(socket,'connect');
 socket.write(JSON.stringify({id:'legacy-request',token:conn.token,method:'read'})+'\n');
 const [raw]=await once(socket,'data');socket.destroy();assert.deepEqual(JSON.parse(raw).result,{ok:true,value:'legacy'});
 await assert.rejects(requestConnection({...conn,token:'wrong'},'read'),{code:'MCP_CONTROL_UNAUTHORIZED'});
});
test('file replies reject traversal, mismatched bytes and tampering instead of accepting corrupt content',async t=>{
 const dir=temporary(t),file=files.responsePath(path.join(dir,'control.json'),'instance','request');
 const receipt=await files.write(file,JSON.stringify({text:'unchanged'}));
 assert.deepEqual(await files.read(file,receipt),{text:'unchanged'});
 assert.throws(()=>files.responsePath(path.join(dir,'control.json'),'../outside','request'));
 assert.throws(()=>files.responsePath(path.join(dir,'control.json'),'instance','../request'));
 await assert.rejects(files.read(file,{...receipt,bytes:receipt.bytes+1}));
 await assert.rejects(files.read(file,{...receipt,sha256:'0'.repeat(64)}));
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{text:'unchanged'});
});
