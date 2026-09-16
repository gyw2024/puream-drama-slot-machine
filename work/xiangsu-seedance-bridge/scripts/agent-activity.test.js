'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {observe}=require('../app/agent-activity'),view=require('../app/renderer/agent-activity-view');
test('reasoning and answer signals alternate without exposing reasoning',()=>{
 const j={};observe(j,{type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private reasoning'}}});
 assert.equal(j.activity.phase,'thinking');assert.equal(j.outputCharacters,undefined);assert.equal(JSON.stringify(j).includes('private'),false);
 observe(j,{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'正文'}}});assert.equal(j.activity.phase,'output');
 observe(j,{type:'item.started',item:{type:'reasoning'}});assert.equal(j.activity.phase,'thinking');
 observe(j,{type:'item.completed',item:{type:'agent_message',text:'最终正文'}});assert.equal(j.activity.phase,'output');assert.equal(j.outputCharacters,4);
});
test('supports AG thought, WorkBuddy step and tool events without heartbeat guessing',()=>{
 const j={};observe(j,{method:'session/update',params:{update:{sessionUpdate:'agent_thought_chunk'}}});assert.equal(j.activity.phase,'thinking');
 observe(j,{event:'step_update',step_update:{step_type:'agent_response'}});assert.equal(j.activity.phase,'output');
 observe(j,{type:'content_block_start',content_block:{type:'tool_use'}});assert.equal(j.activity.phase,'tool');
 const fresh={};observe(fresh,{type:'system'});assert.equal(fresh.activity.phase,'waiting');
});
test('idle signal is unknown, terminal takes precedence and no invented percent',()=>{
 const j={status:'running',createdAt:'2026-01-01T00:00:00Z',activity:{phase:'thinking',lastSignalAt:'2026-01-01T00:00:00Z'}};
 const now=Date.parse('2026-01-01T00:01:00Z');assert.equal(view.present(j,now).stale,true);
 for(const status of ['completed','failed','cancelled','interrupted'])assert.equal(view.present({...j,status},now).ended,true);
 assert.equal(view.present({...j,activity:undefined},Date.parse(j.createdAt)).label,'正在连接');
});
test('project isolation and concurrent tasks retain independent states',()=>{
 const jobs=[{id:'a',projectId:'one',status:'running'},{id:'b',projectId:'two',status:'running'},{id:'c',projectId:'one',status:'running'},{id:'d',projectId:'one',status:'completed'}];
 assert.deepEqual(view.select(jobs,'one').map(j=>j.id),['a','c']);assert.deepEqual(view.select(jobs,''),[]);
});
