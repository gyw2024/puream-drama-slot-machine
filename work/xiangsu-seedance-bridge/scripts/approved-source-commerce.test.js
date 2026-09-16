'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),contract=require('../app/approved-source-commerce');
const project={product:{name:'测试商品'},shots:[{id:'S01',duration:10,action:'甲拿着商品介绍价格',dialogueTurns:[{text:'谢谢你来看望我。',start:0.4,end:2},{text:'这一盒三十九元。',start:3,end:5}]}]};
const options={project,mode:'natural',targetRatio:.057,execution:{model:'test'},sourceProof:{inputFingerprint:'previously-verified-source'}};
test('only new timing is classified; approved source semantics are not randomly re-reviewed',async()=>{
 let calls=0;const generate=async(messages,request)=>{calls++;assert.equal(request.requiredKeys[0],'items');assert.match(messages[0].content,/ALREADY passed/);return {items:[{id:'S01:turns:0',purpose:'none',start:.4,end:2,reason:'gratitude'},{id:'S01:turns:1',purpose:'offer',start:3,end:5,reason:'actual price'}]};};
 const receipt=await contract.review({...options,generate});assert.equal(receipt.ok,true);assert.equal(receipt.timing.effectiveSeconds,2);assert.equal(receipt.timing.duration,10);
 const cached=await contract.review({...options,generate,checkpoint:receipt});assert.equal(cached.ok,true);assert.equal(calls,1);
});
test('unknown or duplicated dialogue IDs cannot fabricate commerce time',async()=>{
 await assert.rejects(contract.review({...options,generate:async()=>({items:[{id:'S01:T2',purpose:'offer',reason:'price'},{id:'S01:T2',purpose:'offer',reason:'duplicate'}]})}),{code:'EDITORIAL_CLASSIFICATION_INCOMPLETE'});
 assert.equal(contract.proof({script:{raw:'changed',adaptiveAuthoring:{status:'ready',text:'original'}}},'natural',.057),null);
});
