'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),api=require('../app/agent-item-contract');
test('invalid cached rows cannot poison future resumes and accepted rows cannot be overwritten',async()=>{
 const requests=[];const r=await api.complete({items:[{id:'a'},{id:'b'}],cached:{items:[{id:'a',text:'accepted'},{id:'b'}]},valid:r=>Boolean(r.text),generate:async rows=>{requests.push(rows.map(r=>r.id));return {items:[{id:'a',text:'unwanted replacement'},{id:'b',text:'new'}]};}});
 assert.deepEqual(requests,[['b']]);assert.equal(r.items[0].text,'accepted');assert.deepEqual(r.missingIds,[]);
});
test('one malformed row does not discard valid paid siblings and repair is bounded',async()=>{
 const requests=[],receipts=[];const r=await api.complete({maxCalls:2,items:[{id:'a'},{id:'b'}],valid:r=>Boolean(r.text),save:r=>receipts.push(r),generate:async rows=>{requests.push(rows.map(r=>r.id));return {items:[{id:'a',text:'valid'},{id:'b',text:''}]};}});
 assert.deepEqual(requests,[['a','b'],['b']]);assert.deepEqual(r.missingIds,['b']);assert.equal(r.items[0].text,'valid');assert.equal(receipts.length,2);
});
test('conflicting duplicate IDs never count as accepted',async()=>{
 let calls=0;await assert.rejects(api.complete({items:[{id:'a'}],valid:()=>true,generate:async()=>{calls++;return {items:[{id:'a',text:'one'},{id:'a',text:'two'}]};}}),{code:'AGENT_EVIDENCE_PENDING'});assert.equal(calls,3);
});
test('persistent batch omissions automatically fall back to isolated source reconciliation',async()=>{
 const requests=[];const r=await api.complete({items:[{id:'a'},{id:'b'},{id:'c'}],valid:r=>!!r.text,generate:async(rows,repair)=>{requests.push({ids:rows.map(r=>r.id),strategy:repair.strategy});return {items:repair.strategy==='isolated_source_reconciliation'?rows.map(r=>({...r,text:'completed '+r.id})):[{id:'a',text:'accepted'}]};}});
 assert.deepEqual(r.missingIds,[]);assert.equal(r.items[0].text,'accepted');assert.deepEqual(requests.map(r=>r.ids),[['a','b','c'],['b','c'],['b'],['c']]);assert.equal(requests[2].strategy,'isolated_source_reconciliation');
});
