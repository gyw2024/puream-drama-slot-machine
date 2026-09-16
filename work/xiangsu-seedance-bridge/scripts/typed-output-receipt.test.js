'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {conforms,createReceiptTracker}=require('../app/typed-output-receipt'),{unwrapTypedEnvelope}=require('../app/local-agent-runtime');
const schema=require('../app/prompt-audit-result').schema();
function tracker(value,ack='Structured output captured successfully',id='call1'){
 const t=createReceiptTracker(schema,unwrapTypedEnvelope);
 t.observe({type:'assistant',message:{content:[{type:'tool_use',name:'StructuredOutput',id:'call1',input:value}]}});
 t.observe({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:ack}]}});return t;
}
test('a successful typed tool receipt survives only an empty final transport acknowledgement',()=>{
 const body={items:[{id:'S01',issues:[{sourceQuote:'unchanged source',promptQuote:'contradicting prompt',contradiction:'wrong holder',repair:'restore holder'}]}]};
 const t=tracker({data:JSON.stringify(body)});assert.deepEqual(t.recover({code:'LOCAL_AGENT_EMPTY_RESPONSE'}).value,body);
 for(const code of ['LOCAL_AGENT_QUOTA','LOCAL_AGENT_AUTH_REQUIRED','PROVIDER_REQUEST_ABORTED','LOCAL_AGENT_RESULT_FAILED'])assert.equal(t.recover({code}),null);
});
test('unacknowledged, mismatched or invalid payloads never become successful receipts',()=>{
 const body={items:[{id:'S01',issues:[]}]};
 assert.equal(tracker(body,'Schema validation failed').accepted,null);
 assert.equal(tracker(body,undefined,'other-call').accepted,null);
 assert.equal(tracker({items:[{id:'S01'}]}).accepted,null);
 assert.deepEqual(tracker({items:[],annotation:'extra'}).accepted.value,{items:[]});
 assert.equal(conforms({x:1},{type:'object',unknownConstraint:true}),false);
});
test('nested required fields, numeric types, prose budgets and union schemas remain enforced',()=>{
 const s={type:'object',required:['items'],additionalProperties:false,properties:{items:{type:'array',minItems:1,items:{anyOf:[{type:'integer',minimum:0},{type:'string',minLength:1,pattern:'^[A-Z]+$'}]}}}};
 assert.equal(conforms({items:[0,'GOOD']},s),true);for(const value of [{items:[]},{items:[-1]},{items:[1.5]},{items:['bad']},{items:[null]},{items:[NaN]}])assert.equal(conforms(value,s),false);
});
test('only empty text transport retries once, keeping cancellation and real failures terminal',async()=>{const {runTextWithEmptyRetry}=require('../app/local-agent-runtime');let calls=0;const value=await runTextWithEmptyRetry(async retryOf=>{calls++;if(!retryOf)throw Object.assign(Error('empty'),{code:'LOCAL_AGENT_EMPTY_RESPONSE',agentJobId:'first'});assert.equal(retryOf,'first');return 'complete';});assert.equal(value,'complete');assert.equal(calls,2);for(const code of ['LOCAL_AGENT_QUOTA','MODEL_JSON_INVALID','PROVIDER_REQUEST_ABORTED']){let count=0;await assert.rejects(runTextWithEmptyRetry(async()=>{count++;throw Object.assign(Error(code),{code});}));assert.equal(count,1);}let count=0;await assert.rejects(runTextWithEmptyRetry(async()=>{count++;throw Object.assign(Error('still empty'),{code:'LOCAL_AGENT_EMPTY_RESPONSE'});}));assert.equal(count,2);});
