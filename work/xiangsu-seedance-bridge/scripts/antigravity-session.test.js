const test=require('node:test'),assert=require('node:assert/strict');
const {completedStep,createSession}=require('../app/antigravity-session');
const {runProcess}=require('../app/local-agent-runtime');
test('AG eligibility network failure retries only with an explicit zero-turn receipt',async()=>{
 const {processFailureCode,runTextWithEmptyRetry}=require('../app/local-agent-runtime');
 const e={event:'result',result:{status:'ERROR',response:'',num_turns:0,error:'failed to send message: send failed; already reported to the user: Eligibility check failed: failed to get profile picture: net/http: TLS handshake timeout'}};
 assert.equal(processFailureCode(JSON.stringify(e)),'LOCAL_AGENT_PRE_SEND_TRANSIENT');
 e.result.num_turns=1;assert.equal(processFailureCode(JSON.stringify(e)),'LOCAL_AGENT_TIMEOUT');
 e.result.num_turns=0;e.result.error+=' quota exceeded';assert.equal(processFailureCode(JSON.stringify(e)),'LOCAL_AGENT_QUOTA');
 let calls=0;assert.equal(await runTextWithEmptyRetry(async()=>{if(++calls===1)throw Object.assign(Error('preflight'),{code:'LOCAL_AGENT_PRE_SEND_TRANSIENT'});return 'ok';}),'ok');assert.equal(calls,2);
});
function vi(n){let b=[];n=BigInt(n);do{let v=Number(n&127n);n>>=7n;b.push(v|(n?128:0));}while(n);return Buffer.from(b);}
const num=(f,n)=>Buffer.concat([vi(f*8),vi(n)]);
const str=(f,s)=>{let b=Buffer.isBuffer(s)?s:Buffer.from(s);return Buffer.concat([vi(f*8+2),vi(b.length),b]);};
const join=(...v)=>Buffer.concat(v);
const user={idx:0,step_type:14,status:3,step_format:0};
function finish(args={title:'茶',lines:['a']}){
 const a={...args,toolAction:'complete',toolSummary:'done'};
 const pairs=Object.entries(a).map(([k,v])=>str(1,join(str(1,k),str(2,typeof v==='string'?v:JSON.stringify(v)))));
 return {idx:2,step_type:132,status:3,step_format:0,step_payload:join(num(1,132),num(4,3),str(5,str(4,join(str(1,'call-1'),str(2,'finish'),str(3,JSON.stringify(a))))),str(140,join(...pairs,str(2,str(1,'Task is complete. Summarize what you did.')))))};
}
function textStep(text,tools=false){return {idx:1,step_type:15,status:3,step_format:0,step_payload:join(num(1,15),num(4,3),str(20,join(str(1,text),...(tools?[str(7,'call')]:[]))))};}
test('only completed accepted finish supplies structured output',()=>{
 assert.deepEqual(completedStep([user,finish()],true).structured_output,{title:'茶',lines:['a']});
 assert.equal(completedStep([user,{...finish(),status:2}],true),null);
 assert.equal(completedStep([user,textStep('{"title":"partial"}')],true),null);
});
test('plain response must have no pending tool calls',()=>{
 assert.equal(completedStep([user,textStep('最终正文')],false).response,'最终正文');
 assert.equal(completedStep([user,textStep('partial',true)],false),null);
 assert.equal(completedStep([user,textStep('')],false),null);
});
test('error, protocol drift and another user turn fail closed',()=>{
 assert.throws(()=>completedStep([user,{...finish(),error_details:Buffer.from('error'),status:4}],true));
 assert.throws(()=>completedStep([user,{...finish(),step_format:1}],true));
 assert.throws(()=>completedStep([user,user,finish()],true));
 const r=finish();r.step_payload=Buffer.from(r.step_payload);r.step_payload[r.step_payload.indexOf(Buffer.from('done'))]^=1;
 assert.throws(()=>completedStep([user,r],true));
});
const cid='11111111-1111-1111-1111-111111111111';
const terminal=JSON.stringify({event:'result',result:{conversation_id:cid,status:'SUCCESS',response:'partial',duration_seconds:0}});
test('native partial result is withheld until the same journal completes',async()=>{
 let ready=false,delivered=[],receipts=[];
 const s=createSession({structured:true,read:id=>{assert.equal(id,cid);return ready?{structured_output:{ok:true},response:'{"ok":true}',proof:'completed-finish-step',stepIndex:2}:null;},onRecovery:r=>receipts.push(r)});
 s.bind({complete:l=>delivered.push(JSON.parse(l)),fail:assert.fail});
 s.stderr('[agy] print timeout after 1s with turn in progress; returning partial output');
 assert.equal(s.observe(terminal),false);await new Promise(r=>setTimeout(r,130));assert.equal(delivered.length,0);
 ready=true;await new Promise(r=>setTimeout(r,1000));s.dispose();
 assert.equal(delivered.length,1);assert.deepEqual(delivered[0].result.structured_output,{ok:true});assert.equal(receipts[0].submittedTurns,1);
});
test('quota error is returned without journal read or generation retry',async()=>{
 let delivered;const s=createSession({read:()=>assert.fail('must not read')});s.bind({complete:l=>delivered=JSON.parse(l),fail:assert.fail});
 s.observe(JSON.stringify({event:'result',result:{conversation_id:cid,status:'ERROR',error:'quota exceeded'}}));await new Promise(r=>setTimeout(r,130));s.dispose();assert.equal(delivered.result.error,'quota exceeded');
});
test('native session exit without final evidence fails instead of hanging',()=>{
 let error;const s=createSession({read:()=>null});s.bind({complete:assert.fail,fail:e=>error=e});s.stderr('returning partial output');s.observe(terminal);s.beforeClose();s.dispose();assert.equal(error.code,'LOCAL_AGENT_RECOVERY_FAILED');
});
test('unlimited session keeps stdin open and closes on explicit terminal result',async()=>{
 let bound,observed=false;
 const session={bind:c=>bound=c,observe:l=>{observed=true;bound.complete(l);return false;},stderr(){},beforeClose(){},dispose(){}};
 const r=await runProcess(process.execPath,['-e',"process.stdin.once('data',()=>setTimeout(()=>console.log('FINAL'),40));process.stdin.on('end',()=>process.exit(0));"],{stdin:'request\n',session,onLine:l=>assert.equal(l,'FINAL')});assert.ok(observed);assert.equal(r.code,0);
});
test('cancellation terminates the owned waiting session and disposes its observer',async()=>{
 let disposed=false;const a=new AbortController();const session={bind(){},observe:()=>true,stderr(){},dispose(){disposed=true;}};
 const result=runProcess(process.execPath,['-e','process.stdin.resume();'],{stdin:'request\n',session,signal:a.signal});setTimeout(()=>a.abort(),50);await assert.rejects(result,e=>e.code==='PROVIDER_REQUEST_ABORTED');assert.ok(disposed);
});
