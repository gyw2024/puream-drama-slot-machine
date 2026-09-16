"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {buildApprovedHailuoPrompt}=require('../app/hailuo-h3-natural-prompt');
const {promptReviewReferencePlan}=require('../app/workbench-workflow');
const project={generation:{engine:'hailuo-h3',mode:'asset_direct'},characters:[{id:'C01',name:'陈远'},{id:'C02',name:'赵淑芳'},{id:'C03',name:'梁志刚'}]};
const shot={id:'S03',number:3,duration:12,providerSemanticCompileSource:'ai-batch',characterIds:['C03','C01'],visibleCharacterIds:['C03','C01'],stateAfter:'赵淑芳尚未进入本单元画面。',dialogueTurns:[{speakerId:'C03',speaker:'梁志刚',listenerIds:['C01'],text:'你为什么迟到了？',onScreen:true}]};
test('semantic absence or spoken mention cannot inject a third portrait',()=>{
 const refs=promptReviewReferencePlan(project,shot,'asset_direct');
 assert.deepEqual(refs.imageRoles.filter(x=>x.type==='character').map(x=>x.entityId),['C03','C01']);
});
test('three declared participants remain allowed and uniquely referenced',()=>{
 const refs=promptReviewReferencePlan(project,{...shot,visibleCharacterIds:['C03','C01','C02']},'asset_direct');
 assert.deepEqual(refs.imageRoles.filter(x=>x.type==='character').map(x=>x.entityId),['C03','C01','C02']);
});
test('every explicitly supplied portrait binds its owner even when that owner is not on screen',()=>{
 const refs={images:['c03.png','c01.png','c02.png'],imageRoles:[{type:'character',entityId:'C03'},{type:'character',entityId:'C01'},{type:'character',entityId:'C02'}],audios:[]};
 const prompt=buildApprovedHailuoPrompt({project,shot,references:refs});
 assert.match(prompt,/<Subject \d+>[^\n]*recurring character C02[^\n]*<Picture 3>/);
 assert.doesNotMatch(prompt,/\bis exact face/);
});
