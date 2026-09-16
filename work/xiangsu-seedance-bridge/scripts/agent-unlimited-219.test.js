const test=require('node:test'),assert=require('node:assert/strict');
const runtime=require('../app/local-agent-runtime');
test('saved and legacy agent timeout settings cannot impose a production deadline',()=>{
 for(const value of [undefined,1,600,3600,6000])for(const p of Object.values(runtime.normalizeSettings({providers:{workbuddy:{timeoutSeconds:value}}}).providers))assert.equal(p.timeoutSeconds,0);
});
test('unlimited process waits for completion and still supports explicit user cancellation',async()=>{
 const result=await runtime.runProcess(process.execPath,['-e',"setTimeout(()=>console.log('complete'),120)"],{timeoutMs:0});assert.match(result.output,/complete/);
 const controller=new AbortController(),pending=runtime.runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});setTimeout(()=>controller.abort(),70);await assert.rejects(pending,{code:'PROVIDER_REQUEST_ABORTED'});
});
test('production elapsed time is telemetry and an old fifteen-minute pause cannot block resumption',async()=>{
 const {Budget}=require('../app/preproduction-budget'),{VERSION}=require('../app/preproduction-performance');let now=0,p={id:'P',preproductionTiming:{elapsedMs:900001,exceeded:true}};
 const b=new Budget({getProject:()=>p,saveProject:value=>p=value},{now:()=>now});
 await b.run({latencyProfile:VERSION,costProjectId:'P',costOperation:'adaptive_script_complete'},async({signal})=>{now=24*60*60*1000;assert.equal(signal,undefined);});
 assert.equal(p.preproductionTiming.limitMs,0);assert.equal(p.preproductionTiming.exceeded,false);assert.ok(p.preproductionTiming.elapsedMs>24*60*60*1000);
});
test('local post-production waits for its terminal operation across arbitrary elapsed time',async()=>{
 const {LocalPostProductionAgent}=require('../app/mcp/local-post-production-agent');let polls=0;
 const a=new LocalPostProductionAgent({timeoutMs:1,pollIntervalMs:0,controller:{dispatch:async method=>method==='get_operation'?{ok:true,operation:{status:++polls<3?'running':'completed'}}:{ok:true}}});
 assert.equal(a.timeoutMs,0);assert.equal((await a.wait('operation','project')).operation.status,'completed');assert.equal(polls,3);
});
test('preparation preserves agent default reasoning instead of lowering it to meet a timer',()=>{
 const p=require('../app/preproduction-performance');assert.equal(p.executionConfig({localAgent:{id:'workbuddy',reasoningEffort:''}},{latencyProfile:p.VERSION}).localAgent.reasoningEffort,'');
});
