'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const writer=require('../app/shot-screenplay'),director=require('../app/agent-production-decisions');
const patcher=require('../app/agent-decision-patch');
const {fixture,project,decision}=require('./compact-screenplay-fixtures');

test('compact duration repair is accepted through actual MCP preview without editing source or base',()=>{
 const p=project('asset_direct'),base=[decision(p.shots[0].shotExecution)],before=structuredClone(base);
 const schema=director.schema(p,p.shots),data={items:[{shotId:base[0].shotId,changes:[{path:['duration'],value:15}]}]};
 const result=patcher.apply(base,data,schema);
 assert.equal(result.items[0].duration,15);assert.deepEqual(base,before);
 const preview=require('../app/mcp/stage-preview').preview({deliveryPreview:{kind:'master-production-patch',project:p,baseItems:base,decisionSchema:schema}},{data});
 assert.equal(preview.ok,true);
 for(const value of [9,16,12.5])assert.throws(()=>patcher.apply(base,{items:[{...data.items[0],changes:[{path:['duration'],value}]}]},schema));
 const fixed=structuredClone(schema);fixed.properties.items.items.anyOf[0].properties.duration={const:12};
 assert.throws(()=>patcher.apply(base,data,fixed));
 assert.deepEqual(base,before);
});

test('focused causal task inherits actual shared authority and full remote evidence',()=>{
 const d=fixture(),s=d.shots[0];d.shots=Array.from({length:12},(_,i)=>({...structuredClone(s),id:'S'+i,action:'Fact '+i,dialogue:s.dialogue.map(t=>({...t,id:'D'+i}))}));
 const task=require('../app/screenplay-causal-review').task({mode:'adapt',screenplay:d});
 assert.ok(task.messages[0].content.includes(require('../app/screenplay-source-authority').INSTRUCTION));
 assert.deepEqual(JSON.parse(task.messages[1].content).screenplay.shots.map(s=>s.action),d.shots.map(s=>s.action));
 const p={script:{shotScreenplay:{document:d}}},e=require('../app/screenplay-source-recovery').relevantSource(p,{S11:['Late claim refers to first event.']});
 assert.deepEqual(e,d);e.shots[0].action='uncommitted';assert.equal(d.shots[0].action,'Fact 0');
});

test('saved source from old authority is retained for review rather than sent back to a writer',async()=>{
 const d=fixture(),raw=writer.render(d),old={...writer.makeRecord(d,raw,{}),version:'shot-screenplay-v15-time-authority'};
 assert.equal(writer.current(old,raw),false);
 let writes=0,reviews=0;
 const result=await writer.author({source:raw,mode:'upload',draftDocument:old.document,generate:async(_m,o)=>{
  if(o.stage==='shot_screenplay_write')writes++;
  assert.equal(o.stage,'shot_screenplay_review');reviews++;
  return {ok:true,storyComplete:true,sourcePreserved:true,checks:{S01:{evidence:'Current complete source compared'}},criteria:Object.fromEntries(['story','commerce','dialogue'].map(k=>[k,{passed:true,evidence:'Compared supplied source'}])),issues:[]};
 }});
 // A structurally sound draft recovered from an older authority version is
 // revalidated locally: no whole-film writer runs, and because the recovered
 // document already reports no delivery issues it needs no paid review round
 // either. The retained source must come back byte-identical.
 assert.equal(writes,0);assert.equal(reviews,0);assert.deepEqual(result.document,d);
 assert.equal(result.status,'ready');
 assert.deepEqual((result.attempts||[]).map(a=>a.stage),['recover_draft_for_review']);
});
