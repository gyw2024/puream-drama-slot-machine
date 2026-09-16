const test=require('node:test'),assert=require('node:assert/strict');
const {processFailureCode}=require('../app/local-agent-runtime');
test('WorkBuddy placeholder-only terminal stream enters same-provider empty-result recovery',async()=>{
 const {runTextWithEmptyRetry}=require('../app/local-agent-runtime');
 const terminal=JSON.stringify({type:'result',is_error:true,errors:['Empty stream: upstream gateway sent only placeholder chunks without any model output (chunks=29879, bytes=9660338)']});
 const code=processFailureCode(terminal,'old authentication timeout');
 assert.equal(code,'LOCAL_AGENT_EMPTY_RESPONSE');
 const calls=[];const result=await runTextWithEmptyRetry(async prior=>{calls.push(prior);if(calls.length===1)throw Object.assign(new Error('empty'),{code,agentJobId:'saved-workbuddy-job'});return {receipt:'actual-completed-receipt'};});
 assert.deepEqual(calls,['','saved-workbuddy-job']);assert.equal(result.receipt,'actual-completed-receipt');
});
test('terminal native timeout overrides temporary startup auth diagnostics',()=>{
 assert.equal(processFailureCode(JSON.stringify({event:'result',result:{status:'ERROR',error:'Print mode timed out after 1496 polls'}}),'You are not logged into Antigravity. silent auth succeeded'),'LOCAL_AGENT_TIMEOUT');
 assert.equal(processFailureCode('','E0906 07:01:40.401 Missing expected response'),'LOCAL_AGENT_PROCESS_FAILED');
 assert.equal(processFailureCode(JSON.stringify({event:'result',result:{error:'HTTP 401 unauthorized'}}),'old deadline'),'LOCAL_AGENT_AUTH_REQUIRED');
 assert.equal(processFailureCode(JSON.stringify({type:'result',error:'usage limit reached'})),'LOCAL_AGENT_QUOTA');
});

test('Grok terminal errors array classifies exhausted balance instead of unrelated startup timeout text',()=>{
 const init=JSON.stringify({type:'system',tools:[{name:'wait',description:'timeout control'}]});
 const terminal=JSON.stringify({type:'result',is_error:true,duration_ms:65624,duration_api_ms:0,errors:['Internal error: {"message":"API error (status 402 Payment Required): Grok Build usage balance exhausted","http_status":402}']});
 assert.equal(processFailureCode(init+'\n'+terminal),'LOCAL_AGENT_QUOTA');
 assert.equal(processFailureCode(JSON.stringify({event:'result',result:{errors:[{http_status:429,message:'Limit reached'}]}}),'old timeout'),'LOCAL_AGENT_QUOTA');
 assert.equal(processFailureCode(JSON.stringify({type:'result',errors:['HTTP 401 authentication failed']}),'old timeout'),'LOCAL_AGENT_AUTH_REQUIRED');
});

test('actual nonzero process exit retains the terminal quota classification',async()=>{
 const {runProcess}=require('../app/local-agent-runtime');
 const lines=[{type:'system',description:'Tool timeout'}, {type:'result',is_error:true,errors:['HTTP 402 Payment Required: usage balance exhausted']}];
 await assert.rejects(runProcess(process.execPath,['-e',`for(const e of ${JSON.stringify(lines)})console.log(JSON.stringify(e));process.exitCode=1;`],{timeoutMs:5000}),e=>e.code==='LOCAL_AGENT_QUOTA'&&/余额/.test(e.message));
});
