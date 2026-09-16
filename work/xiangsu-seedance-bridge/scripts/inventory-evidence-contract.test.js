'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),contract=require('../app/inventory-evidence-contract'),inventory=require('../app/source-prop-inventory');
function fixture(){return {script:{raw:'老人展示旧照片。',formatAdaptation:{productionScript:'### S01｜场景：出租车内\n【核心物品】出租车；旧照片\n【动作】老人坐在后座展示旧照片，司机转身看向老人\n【承接】两人保持原位'}},shots:[{id:'S01',action:'老人坐在后座展示旧照片，司机转身看向老人'}],assetLibraries:{props:[{id:'P1',name:'旧照片'},{id:'P2',name:'另一张照片'}]}};}
test('shot source headings and declarations are admitted only with matching action provenance',()=>{
 const p=fixture();assert.match(contract.shotEvidence(p,p.shots[0]),/出租车内/);
 assert.doesNotMatch(contract.shotEvidence(p,{id:'S01',action:'另一个故事的动作没有任何关系'}),/出租车内/);
});
test('compiler owns unique references regardless of provider generated IDs and keys',()=>{
 const p=fixture(),ref=contract.catalog(p).find(e=>e.text.includes('【动作】'));
 const response={objects:[{name:'旧照片',existingId:'P2',key:'duplicate',role:'core',sourceEvidenceIds:[ref.id],occurrences:[{shotId:'S01',visibility:'visible',evidenceId:ref.id}]}],coverage:[{declarationId:'G001',assetNames:[],disposition:'set_dressing',reason:'出租车为场景'},{declarationId:'G002',assetNames:['旧照片'],reason:'身份证据'}]};
 const a=contract.compile(response,p,inventory.declarations(p));assert.equal(a.assets[0].existingId,'P1');assert.notEqual(a.assets[0].key,'duplicate');assert.equal(a.decisions[1].assetKeys[0],a.assets[0].key);assert.deepEqual(inventory.validate(a,p,inventory.declarations(p)),[]);
 response.objects[0].occurrences[0].evidenceId='E9999';assert.match(inventory.validate(contract.compile(response,p,[]),p,inventory.declarations(p)).join(' '),/grounded/);
});
test('two names cannot inherit one identity and changed shot evidence invalidates inventory cache',()=>{
 const p=fixture(),r={assets:[{name:'旧照片',existingId:'P1'},{name:'另一张照片',existingId:'P1'}]};contract.bindIdentities(r,p);assert.deepEqual(r.assets.map(a=>a.existingId),['P1','P2']);
 const before=inventory.fingerprint(p);p.shots[0].stateAfter='照片放进口袋';assert.notEqual(inventory.fingerprint(p),before);
});
test('partial repair cannot replace successful semantic objects',async()=>{
 const p=fixture(),ref=contract.catalog(p).find(e=>e.text.includes('【动作】'));let calls=0,first;
 const object={name:'旧照片',role:'core',sourceEvidenceIds:[ref.id],occurrences:[{shotId:'S01',visibility:'visible',evidenceId:ref.id}]};
 await inventory.reconcile({project:p,save:()=>{},generate:async messages=>{calls++;const request=JSON.parse(messages[1].content);if(calls===1){first=structuredClone(object);return {objects:[object],coverage:[{declarationId:'G001',assetNames:[],disposition:'set_dressing',reason:'背景'},{declarationId:'G002',assetNames:['不存在道具'],reason:'错误关联'}]};}assert.deepEqual(request.repairScope.objectNames,[]);return {objects:[{...object,name:'旧照片',description:'MUST NOT OVERWRITE'}],coverage:[{declarationId:'G002',assetNames:['旧照片'],reason:'证据物'}]};}});
 assert.equal(calls,2);assert.equal(p.sourcePropInventory.status,'completed');assert.notEqual(p.assetLibraries.props[0].description,'MUST NOT OVERWRITE');
});
