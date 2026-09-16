'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {POLICY,measureCommerce}=require('../app/commerce-editorial-contract');
const interval=(start,end,purpose='feature_explanation')=>({start,end,purpose,sourceQuote:'完整原句证据',sourceVerified:true});
test('background and gratitude cannot inflate commerce time',()=>{
 const r=measureCommerce({duration:550.5,targetRatio:0.2,intervals:[interval(250.458333,294.291666),interval(294.291666,376.291666,'background_visibility'),interval(0,50,'gratitude')]});
 assert.ok(Math.abs(r.effectiveSeconds-43.833333)<1e-6);assert.ok(r.ratio<0.08);assert.ok(r.shortfallSeconds>66);assert.equal(r.semanticApproval,false);
});
test('overlapping explanation and demonstration are counted once',()=>{
 const r=measureCommerce({duration:100,intervals:[interval(10,25),interval(20,30,'verified_demonstration')]});assert.equal(r.effectiveSeconds,20);assert.equal(r.shortfallSeconds,0);
});
test('unverified receipts do not create positive evidence',()=>{
 assert.equal(measureCommerce({duration:100,intervals:[{...interval(0,30),sourceVerified:false}]}).effectiveSeconds,0);
 assert.throws(()=>measureCommerce({duration:100,intervals:[interval(0,101)]}));
});
test('user ratio changes do not impose total duration',()=>{
 assert.equal(measureCommerce({duration:70,targetRatio:0.3,intervals:[interval(0,21)]}).shortfallSeconds,0);
});
test('real writer and craft entry points share the policy',()=>{
 const author=require('../app/adaptive-script-author');assert.ok(author.RULES.startsWith(POLICY));assert.ok(!author.RULES.includes('or fixed product percentage'));
 const craft=require('../app/script-craft');assert.ok(craft.productWindowCraft('测试商品').includes(POLICY));
 const contract=require('../app/drama-writing-contract');assert.ok(contract.dialogueFirstActionContractZh().includes(POLICY));
});
