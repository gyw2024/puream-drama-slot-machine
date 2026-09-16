'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {AgentHub}=require('../app/local-agent-runtime');
test('software dispatch and agent progress/results round-trip through every writing stage',async()=>{
 const root=path.resolve(__dirname,'../../../.codex_tests/TASK-20260912-GLOBAL-248/M07/roundtrip-'+crypto.randomUUID()),hub=new AgentHub(root);
 hub.register({agentId:'codex',workerId:'roundtrip'});
 for(const stage of ['topics','rewrite','original','shot_split','shot_prompts','asset_extract','asset_prompts']){
  const statuses=[],messages=[{role:'system',content:'Preserve the user-confirmation boundary.'},{role:'user',content:stage}];
  const promise=hub.run({id:'codex',transport:'mcp'},{modality:'text',messages},{costProjectId:'roundtrip-project',costOperation:stage,onStatus:s=>statuses.push(s.text)});
  await new Promise(resolve=>setTimeout(resolve,10));const job=hub.list().find(j=>j.operation===stage);
  const claim=hub.claim({jobId:job.id,workerId:'roundtrip'});assert.deepEqual(claim.request.messages,messages);
  const auth={jobId:job.id,workerId:'roundtrip',claimToken:claim.claimToken};hub.progress({...auth,sequence:1,message:stage+' in progress'});
  await new Promise(resolve=>setTimeout(resolve,220));assert.ok(statuses.includes(stage+' in progress'));
  hub.complete({...auth,text:JSON.stringify({stage,result:'completed for business validation'})});
  const result=await promise;assert.equal(JSON.parse(result.text).stage,stage);assert.equal(hub.list().find(j=>j.id===job.id).status,'completed');
 }
});
test('partial batch reconciliation retains only fully valid rows without relaxing the strict transport contract',()=>{
 const projection=require('../app/typed-output-projection'),schema={type:'object',required:['items'],properties:{items:{type:'array',minItems:2,items:{type:'object',required:['id','text'],properties:{id:{type:'string'},text:{type:'string'}},additionalProperties:false}}}};
 const value={items:[{id:'good',text:'complete'},{id:'bad',text:3}]};
 assert.equal(projection.project(value,schema),undefined);
 const receipt=projection.projectItems(value,schema);assert.deepEqual(receipt.items,[{id:'good',text:'complete'}]);assert.equal(receipt.itemRejections[0].id,'bad');assert.equal(value.items.length,2);
 assert.equal(projection.projectItems({items:[{id:'bad'}]},schema),undefined);
});
test('agent progress, completion acknowledgement and restart use one durable job identity',()=>{
 const root=path.resolve(__dirname,'../../../.codex_tests/TASK-20260912-GLOBAL-248/M07/hub-'+crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
 const hub=new AgentHub(root),id='agent_'+crypto.randomUUID(),job={id,agentId:'codex',modality:'text',status:'waiting_agent'};
 fs.mkdirSync(path.join(root,id));fs.writeFileSync(path.join(root,id,'request.json'),JSON.stringify({messages:[],operation:'write'}));hub.jobs.set(id,job);hub.save(job);hub.register({agentId:'codex',workerId:'test'});
 const claim=hub.claim({jobId:id,workerId:'test'}),auth={jobId:id,workerId:'test',claimToken:claim.claimToken};
 hub.progress({...auth,sequence:2,message:'已完成人物设定，正在编写正文'});assert.equal(hub.progress({...auth,sequence:1,message:'旧进度'}).ignored,true);assert.match(hub.list()[0].message,/人物设定/);
 assert.throws(()=>hub.progress({...auth,claimToken:'wrong',sequence:3,message:'伪进度'}),{code:'LOCAL_AGENT_RESULT_STALE'});
 hub.complete({...auth,text:'{"items":[]}'});assert.equal(hub.complete({...auth,text:'{"items":[]}'}).reused,true);
 assert.throws(()=>hub.complete({...auth,text:'different result'}),{code:'LOCAL_AGENT_RESULT_STALE'});
 const resumed=new AgentHub(root);assert.equal(resumed.complete({...auth,text:'{"items":[]}'}).reused,true);assert.equal(resumed.list()[0].claimToken,undefined);
 assert.throws(()=>resumed.progress({...auth,sequence:3,message:'late'}),{code:'LOCAL_AGENT_RESULT_STALE'});
});
