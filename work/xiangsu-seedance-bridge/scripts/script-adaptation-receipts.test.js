const test=require('node:test'),assert=require('node:assert/strict'),a=require('../app/script-adaptation');
test('context echoes and output order never discard all requested rows',()=>{
 const expected=[{id:'P36'},{id:'P37'}];const r=a.receiveRows(expected,[{id:'P33',text:'context'},{id:'P37',text:'b'},{id:'P36',text:'a'}]);
 assert.deepEqual(r.rows,[{id:'P36',text:'a'},{id:'P37',text:'b'}]);assert.equal(r.missing.length,0);assert.deepEqual(r.ignored,['P33']);
});
test('conflicting duplicate rows require correction; identical duplicates are idempotent',()=>{
 const r=a.receiveRows([{id:'A'},{id:'B'}],[{id:'A',text:'one'},{id:'A',text:'two'},{id:'B',text:'ok'},{id:'B',text:'ok'}]);
 assert.deepEqual(r.conflicts,['A']);assert.deepEqual(r.rows,[{id:'B',text:'ok'}]);assert.deepEqual(r.missing,[{id:'A'}]);
});
test('partial receipt is saved before network failure and resumes only missing IDs',async()=>{
 const source='甲走进门。\n乙点头。\n两人握手。';let checkpoint;const calls=[];
 const contract={title:'见面',kernel:'和解',ending:'握手',beats:[{id:'B',cause:'见面',result:'和解'}],replacements:[],productName:'',productLocks:[]};
 await assert.rejects(a.adapt({source,save:p=>checkpoint=structuredClone(p),generate:async(m,o)=>{
  if(o.stage.endsWith('contract'))return contract;
  if(o.stage.endsWith('write_1'))return {rows:[{id:'P00003',text:'两人握手。'},{id:'P00001',text:'甲走进门。'}]};
  throw Object.assign(Error('offline'),{code:'OFFLINE'});
 }}),{code:'OFFLINE'});
 assert.deepEqual(checkpoint.rows.map(r=>r.id),['P00001','P00003']);assert.equal(checkpoint.rowReceipts.length,1);
 const result=await a.adapt({source,checkpoint,generate:async(m,o)=>{
  calls.push(o.stage);if(o.stage.includes('write')){assert.match(m[1].content,/唯一允许输出的段落ID：[[]"P00002"\]/);return {rows:[{id:'P00002',text:'乙点头。'}]};}
  return {ok:true,issues:[],beatChecks:[{id:'B',ok:true,evidence:'P00001到P00003见面握手'}]};
 }});
 assert.equal(result.status,'ready');assert.equal(result.rows.length,3);assert.equal(calls.length,2);
});
