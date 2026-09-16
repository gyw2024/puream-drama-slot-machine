const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ensureAntigravityWriterProfile}=require('../app/local-agent-runtime');
test('Antigravity pure writer is discoverable, content addressed and does not change permissions',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-writer-test-'));
 try{const name=ensureAntigravityWriterProfile(root),file=path.join(root,'.gemini/config/agents',name,'agent.md');assert.match(name,/^puream-writer-[a-f0-9]{12}$/);assert.equal(ensureAntigravityWriterProfile(root),name);assert.match(fs.readFileSync(file,'utf8'),/commandExecutionPolicy: "off"/);assert.equal(fs.existsSync(path.join(root,'.gemini/settings.json')),false);fs.writeFileSync(file,'user-owned conflict');assert.throws(()=>ensureAntigravityWriterProfile(root),{code:'LOCAL_AGENT_PROFILE_CONFLICT'});}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('structured Antigravity writer permits only native final-output completion',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app/agents/puream-writer.md'),'utf8');
 assert.match(source,/^tools: \[finish\]$/m);
 assert.match(source,/response schema[\s\S]*built-in finish tool exactly once/);
 assert.match(source,/commandExecutionPolicy: "off"/);
 for(const field of ['mcpServers','skills','plugins'])assert.match(source,new RegExp('^'+field+': \\[\\]$','m'));
 assert.match(source,/invoke any other tool/);
});
