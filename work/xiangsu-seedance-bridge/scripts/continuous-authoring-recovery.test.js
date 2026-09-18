'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('shared asset and continuity reconciliation keeps accepted rows and stops paying after repeated identical empty replies',async()=>{
 const api=require('../app/agent-item-contract');let calls=0;const scopes=[];
 await assert.rejects(()=>api.complete({items:[{id:'a'},{id:'b'}],cached:{items:[{id:'a',text:'keep'}]},valid:r=>typeof r.text==='string'&&r.text.length>0,generate:async pending=>{calls++;scopes.push(pending.map(r=>r.id));return {items:[]};}}),{code:'AGENT_EVIDENCE_PENDING'});
 // The anti-stall contract allows one targeted patch plus one isolated
 // source reconciliation before refusing to repeat an identical request.
 assert.equal(calls,3);
 assert.deepEqual(scopes,[['b'],['b'],['b']]);
});
test('distinct invalid replies still converge on a valid result without losing accepted data',async()=>{
 const api=require('../app/agent-item-contract');let calls=0;
 const result=await api.complete({items:[{id:'a'},{id:'b'}],cached:{items:[{id:'a',text:'keep'}]},valid:r=>typeof r.text==='string'&&r.text.length>0,generate:async pending=>{
   calls++;
   assert.deepEqual(pending.map(r=>r.id),['b']);
   return calls<3?{items:[{id:'b',text:'',attempt:calls}]}:{items:[{id:'b',text:'authored'}]};
 }});
 assert.equal(calls,3);
 assert.deepEqual(result.items,[{id:'a',text:'keep'},{id:'b',text:'authored'}]);
 assert.deepEqual(result.missingIds,[]);
});
test('continuous recovery yields and honors cancellation without creating placeholder output',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(require('../app/agent-item-contract').complete({items:[{id:'a'}],signal:controller.signal,valid:()=>false,generate:async()=>{if(++calls===2)controller.abort();return {items:[]};}}),{code:'PROVIDER_REQUEST_ABORTED'});
 // Cancellation must be observed on the very next checkpoint, not after a
 // full retry budget has been spent.
 assert.equal(calls,2);
});
test('Agent-first intake resolves even recognized source text and does not trust a program-supplied wrong speaker',async()=>{
 let calls=0;const source='老周：这本账我一直留着。';const result=await require('../app/source-understanding').understand({source,rows:[{speaker:'wrong',text:'wrong'}],forceAgent:true,generate:async()=>{calls++;return {turns:[{line:1,speaker:'老周',text:'这本账我一直留着。',tone:'平静',scene:'店内'}],notes:[]};}});assert.equal(calls,1);assert.equal(result.rows[0].speaker,'老周');assert.equal(result.rows[0].text,'这本账我一直留着。');
});
