'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createTracker}=require('../app/codex-text-receipt');
const request={json:true,requiredKeys:['ok'],responseSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}},text='{"ok":false}',error={code:'LOCAL_AGENT_RESULT_FAILED'};
function scenario(tail=[]){const t=createTracker();for(const e of [{type:'turn.started'},{type:'error',message:'retrying transport'},{type:'item.completed',item:{type:'agent_message',text}},...tail])t.observe(e);return t;}
test('completed Codex turn supersedes a transient stream error while preserving a negative content verdict',()=>{
 const t=scenario([{type:'turn.completed'}]),r=t.recover({error,exitCode:0,fileText:text,request});assert.ok(r);assert.equal(JSON.parse(r.text).ok,false);
});
test('missing completion, explicit failed turn, later error, process failure or mismatched output cannot recover',()=>{
 for(const tail of [[],[{type:'turn.failed'},{type:'turn.completed'}],[{type:'turn.completed'},{type:'error'}]])assert.equal(scenario(tail).recover({error,exitCode:0,fileText:text,request}),null);
 for(const extra of [{exitCode:1},{fileText:'{"ok":true}'},{request:{...request,responseSchema:{type:'object',required:['missing']}}}])assert.equal(scenario([{type:'turn.completed'}]).recover({error,exitCode:0,fileText:text,request,...extra}),null);
});
test('a new turn invalidates a previous completed response',()=>{const t=scenario([{type:'turn.completed'},{type:'turn.started'}]);assert.equal(t.recover({error,exitCode:0,fileText:text,request}),null);});
test('successful terminal receipt supersedes any intermediate availability warning, not just a fixed wording',()=>{
 for(const code of ['LOCAL_AGENT_TIMEOUT','LOCAL_AGENT_QUOTA','LOCAL_AGENT_AUTH_REQUIRED','LOCAL_AGENT_UNKNOWN_STREAM_ERROR']){
  const r=scenario([{type:'turn.completed'}]).recover({error:{code},exitCode:0,fileText:text,request});assert.ok(r,code);assert.equal(JSON.parse(r.text).ok,false);
 }
 for(const code of ['PROVIDER_REQUEST_ABORTED','LOCAL_AGENT_OUTPUT_LIMIT','LOCAL_AGENT_TOOL_DENIED'])assert.equal(scenario([{type:'turn.completed'}]).recover({error:{code},exitCode:0,fileText:text,request}),null);
});
test('a completed required-key JSON request recovers without an optional native schema',()=>{
 const minimal={json:true,requiredKeys:['ok']};
 assert.ok(scenario([{type:'turn.completed'}]).recover({error,exitCode:0,fileText:text,request:minimal}));
 assert.equal(scenario([{type:'turn.completed'}]).recover({error,exitCode:0,fileText:text,request:{...minimal,requiredKeys:['topics']}}),null);
});
