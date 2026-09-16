const test=require('node:test'),assert=require('node:assert/strict'),a=require('../app/script-adaptation');
const contract={title:'和解',kernel:'和解',ending:'握手',beats:[{id:'B1',cause:'见面',result:'握手'}],replacements:[],productName:'',productLocks:[]};
const goodReview={ok:true,issues:[],beatChecks:[{id:'B1',ok:true,evidence:'P00001见面，P00002握手'}]};
test('all adaptation writing and missing-row repair stages expose their nested delivery shape',()=>{
 for(const stage of ['write_1','write_2_missing_1','repair_1','repair_1_missing_3']){
 const schema=a.adaptationResponseSchema(stage);assert.deepEqual(schema.required,['rows']);assert.deepEqual(schema.properties.rows.items.required,['id','text']);assert.equal(schema.properties.rows.items.properties.text.minLength,1);
 }
});
test('1000 permutations, context echoes and benign ID formatting retain exactly the requested content',()=>{
 for(let n=0;n<1000;n++){const expected=Array.from({length:5},(_,i)=>({id:'P'+String(i+1).padStart(5,'0'),text:'内容'+i}));let actual=expected.map(r=>({...r,id:n%2?' p'+Number(r.id.slice(1))+' ':r.id}));actual=actual.slice(n%5).concat(actual.slice(0,n%5));if(n%3)actual.reverse();actual.push({id:'P99999',text:'上下文'},actual[0]);const receipt=a.receiveRows(expected,actual);assert.deepEqual(receipt.rows,expected);assert.equal(receipt.missing.length,0);}
});
test('new names containing old names are not incorrectly flagged; actual old names remain findings',()=>{
 const c={...contract,replacements:[{kind:'name',from:'张明',to:'张明远'}]},rows=a.sourceRows('张明握手。');
 assert.equal(a.deterministicAudit(c,rows,[{id:'P00001',text:'张明远握手。'}]).ok,true);
 assert.equal(a.deterministicAudit(c,rows,[{id:'P00001',text:'张明向张明远点头。'}]).ok,false);
});
test('review protocol failure preserves full text and raw evidence without rewriting',async()=>{
 const source='甲进门。\n乙握手。';let saved;const calls=[];
 await assert.rejects(a.adapt({source,save:p=>saved=structuredClone(p),generate:async(m,o)=>{
  calls.push(o);if(calls.filter(x=>x.stage.includes('review')).length>5)throw Object.assign(Error('cancelled'),{code:'PROVIDER_REQUEST_ABORTED'});if(o.stage.endsWith('contract'))return structuredClone(contract);
  if(o.stage.includes('write'))return {rows:a.sourceRows(source)};
  return {ok:true,issues:[],beatChecks:[{id:'B1',ok:true,evidence:'   '}]};
 }}),{code:'PROVIDER_REQUEST_ABORTED'});
 assert.equal(saved.status,'needs_attention');assert.equal(saved.text,source);assert.equal(saved.rows.length,2);assert.equal(saved.responseReceipts.filter(r=>r.stage.startsWith('review')).length,5);
 assert.equal(calls.filter(o=>o.stage.includes('write')).length,1);assert.ok(calls.filter(o=>o.stage.includes('review')).every(o=>o.agentStage==='review'));
 const resumed=await a.adapt({source,checkpoint:saved,generate:async()=>structuredClone(goodReview)});
 assert.equal(resumed.status,'ready');assert.equal(resumed.error,undefined);
});
test('contradictory review checks cannot pass, harmless repeats and unrelated context can',()=>{
 assert.throws(()=>a.validReview({...goodReview,beatChecks:[goodReview.beatChecks[0],{id:'B1',ok:false,evidence:'P00001有矛盾'}]},['B1']),{code:'SCRIPT_ADAPTATION_REVIEW_INCOMPLETE'});
 assert.equal(a.validReview({...goodReview,beatChecks:[...goodReview.beatChecks,...goodReview.beatChecks,{id:'OTHER',ok:true,evidence:'context'}]},['B1']).ok,true);
});
test('positive semantic verdict needs a citation to an actual source row',()=>{
 assert.throws(()=>a.validReview({...goodReview,beatChecks:[{id:'B1',ok:true,evidence:'全部通过'}]},['B1'],['P00001']),{code:'SCRIPT_ADAPTATION_REVIEW_INCOMPLETE'});
 assert.throws(()=>a.validReview({...goodReview,beatChecks:[{id:'B1',ok:true,evidence:'P99999证明通过'}]},['B1'],['P00001']),{code:'SCRIPT_ADAPTATION_REVIEW_INCOMPLETE'});
 assert.equal(a.validReview({...goodReview,beatChecks:[{id:'B1',ok:true,evidence:'P00001已点头'}]},['B1'],['P00001']).ok,true);
});
test('1106 source rows complete despite every batch returning context and reversed order',async()=>{
 const source=Array.from({length:1106},(_,i)=>'第'+i+'行动：人物点头。').join('\n');let writes=0;
 const result=await a.adapt({source,generate:async(m,o)=>{
  if(o.stage.endsWith('contract'))return structuredClone(contract);
  if(o.stage.includes('write')){writes++;const text=m[1].content,group=JSON.parse(text.slice(text.lastIndexOf('本次必须改写的原文：')+'本次必须改写的原文：'.length));return {rows:[{id:'P99999',text:'context'},...group.reverse()]};}
  return structuredClone(goodReview);
 }});
 assert.equal(writes,6);assert.equal(result.status,'ready');assert.equal(result.rows.length,1106);assert.equal(result.text,source);
});
