'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('shared asset and continuity reconciliation completes after six incomplete replies without losing accepted data',async()=>{
 const api=require('../app/agent-item-contract');let calls=0;
 const result=await api.complete({items:[{id:'a'},{id:'b'}],cached:{items:[{id:'a',text:'keep'}]},valid:r=>typeof r.text==='string'&&r.text.length>0,generate:async pending=>{assert.deepEqual(pending.map(r=>r.id),['b']);return {items:++calls<7?[]:[{id:'b',text:'authored'}]};}});
 assert.equal(calls,7);assert.deepEqual(result.items,[{id:'a',text:'keep'},{id:'b',text:'authored'}]);
});
test('continuous recovery yields and honors cancellation without creating placeholder output',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(require('../app/agent-item-contract').complete({items:[{id:'a'}],signal:controller.signal,valid:()=>false,generate:async()=>{if(++calls===6)controller.abort();return {items:[]};}}),{code:'PROVIDER_REQUEST_ABORTED'});assert.equal(calls,6);
});
test('Agent-first intake resolves even recognized source text and does not trust a program-supplied wrong speaker',async()=>{
 let calls=0;const source='老周：这本账我一直留着。';const result=await require('../app/source-understanding').understand({source,rows:[{speaker:'wrong',text:'wrong'}],forceAgent:true,generate:async()=>{calls++;return {turns:[{line:1,speaker:'老周',text:'这本账我一直留着。',tone:'平静',scene:'店内'}],notes:[]};}});assert.equal(calls,1);assert.equal(result.rows[0].speaker,'老周');assert.equal(result.rows[0].text,'这本账我一直留着。');
});
