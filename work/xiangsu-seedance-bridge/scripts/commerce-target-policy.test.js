'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../app/commerce-target-policy'),editorial=require('../app/commerce-editorial-contract');
test('reference floor is sourced from all 19 positive reviewed screenplay ratios, not product presence',()=>{
 assert.equal(policy.reference.cases.length,19);assert.equal(policy.DEFAULT_TARGET,Math.ceil(Math.min(...policy.reference.cases.map(c=>c.effectiveSeconds/c.totalSeconds))*1000)/1000);
 assert.equal(policy.reference.videoVerified,false);assert.ok(policy.DEFAULT_TARGET>0&&policy.DEFAULT_TARGET<0.2);
});
test('old automatic 20 percent migrates, explicit targets survive',()=>{
 assert.equal(policy.resolve({}),policy.DEFAULT_TARGET);assert.equal(policy.resolve({commerceTargetRatio:0.2}),policy.DEFAULT_TARGET);
 assert.equal(policy.resolve({commerceTargetRatio:0.2,commerceTargetSource:'user'}),0.2);assert.equal(policy.resolve({commerceTargetRatio:0.3}),0.3);
});
test('low ratio never disables source facts or creates inflated commerce time',()=>{
 const v=editorial.measureCommerce({duration:100,intervals:[{start:0,end:99,purpose:'background_visibility',sourceQuote:'背景摆放',sourceVerified:true}]});
 assert.equal(v.effectiveSeconds,0);assert.ok(v.shortfallSeconds>0);assert.equal(v.semanticApproval,false);
 assert.equal(editorial.evaluate({mode:'natural',units:[],report:{ok:true,issues:[]}}).ok,false);
});
