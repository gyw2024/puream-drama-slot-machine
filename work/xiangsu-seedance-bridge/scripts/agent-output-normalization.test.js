'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),recovery=require('../app/agent-output-normalization');
const row={type:'object',additionalProperties:false,required:['id','text'],properties:{id:{type:'string'},text:{type:'string',minLength:1}}};
const options={json:true,requiredKeys:['items'],responseSchema:{type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',minItems:2,maxItems:2,items:row}}}};
test('output normalization repairs the representation and locks valid authored sibling bytes',async()=>{
 const original=JSON.stringify({items:[{id:'a',text:'原句：别动这罐。'},{id:'b',wrong:'先接稳，再松手。'}]}),requests=[],receipts=[];
 const result=await recovery.recover({rawText:original,error:{code:'LOCAL_AGENT_SCHEMA_REJECTED'},messages:[{role:'user',content:'Original source: 原句：别动这罐。先接稳，再松手。'}],options,invoke:async(m)=>{requests.push(m);return JSON.stringify({items:[{id:'a',text:'unwanted rewrite'},{id:'b',text:'先接稳，再松手。'}]});},onAttempt:r=>receipts.push(r)});
 assert.equal(result.items[0].text,'原句：别动这罐。');assert.equal(result.items[1].text,'先接稳，再松手。');assert.equal(requests.length,1);assert.deepEqual(JSON.parse(requests[0].at(-1).content).acceptedIds,['a']);assert.equal(receipts.at(-1).status,'completed');
});
test('non-JSON prose becomes typed content through Agent normalization with exact original input retained',async()=>{
 const opts={json:true,requiredKeys:['text'],responseSchema:{type:'object',required:['text'],properties:{text:{type:'string'}}}};let calls=0;
 const result=await recovery.recover({rawText:'答案是：老周接稳伞后才松手。',error:{code:'MODEL_JSON_INVALID'},messages:[{role:'user',content:'老周接稳伞后才松手。'}],options:opts,invoke:async(m)=>{calls++;assert.ok(m.some(x=>x.content==='老周接稳伞后才松手。'));return calls===1?'仍是文字':JSON.stringify({text:'老周接稳伞后才松手。'});}});
 assert.equal(result.text,'老周接稳伞后才松手。');assert.equal(calls,2);
});
test('normalization stops on cancellation or authentication rather than pretending repaired content exists',async()=>{
 const c=new AbortController();c.abort();let calls=0;
 await assert.rejects(recovery.recover({rawText:'bad',messages:[],options:{...options,signal:c.signal},invoke:async()=>calls++}),{code:'PROVIDER_REQUEST_ABORTED'});assert.equal(calls,0);
 await assert.rejects(recovery.recover({rawText:'bad',messages:[],options,invoke:async()=>{throw Object.assign(Error('auth'),{code:'LOCAL_AGENT_AUTH_REQUIRED'});}}),{code:'LOCAL_AGENT_AUTH_REQUIRED'});
});
test('diagnostics identify missing and wrongly typed fields without fabricating defaults',()=>{
 assert.deepEqual(recovery.inspect({id:4},row).map(x=>x.path).sort(),['$.id','$.text']);
 assert.throws(()=>recovery.parse('{"items":[{"id":"a"}]}',options));
});
