const test=require('node:test'),assert=require('node:assert/strict');
const {runProcess}=require('../app/local-agent-runtime');
test('more than eight MB of bounded stream telemetry does not terminate a small final result',async()=>{
 let count=0,final;
 const code=`const line=JSON.stringify({event:'thinking_snapshot',text:'x'.repeat(16000)})+'\\n';for(let i=0;i<600;i++)process.stdout.write(line);process.stdout.write(JSON.stringify({event:'result',result:'complete'})+'\\n');`;
 const r=await runProcess(process.execPath,['-e',code],{timeoutMs:10000,onLine:line=>{const e=JSON.parse(line);count++;if(e.event==='result')final=e.result;}});
 assert.equal(count,601);assert.equal(final,'complete');assert.ok(r.output.length<=12000);
});
test('one oversized event still stops safely',async()=>{
 await assert.rejects(runProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(9*1024*1024))"],{timeoutMs:10000,onLine:()=>{}}),{code:'LOCAL_AGENT_OUTPUT_LIMIT'});
});
test('stream consumer capacity failure propagates instead of being silently discarded',async()=>{
 await assert.rejects(runProcess(process.execPath,['-e',"console.log('{}')"],{timeoutMs:10000,onLine:()=>{throw Object.assign(new Error('body limit'),{code:'LOCAL_AGENT_OUTPUT_LIMIT'});}}),{code:'LOCAL_AGENT_OUTPUT_LIMIT'});
});
