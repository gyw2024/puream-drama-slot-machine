'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),identity=require('../app/production-identity-contract');
test('machine object references cannot masquerade as physical nouns in new narrative contracts',()=>{
 const schema=identity.narrativeSchema([{id:'prop_table.1'},{id:'prop_cup'}]);const re=new RegExp(schema.pattern);
 assert.equal(re.test('C01 lifts the original product package from the dining table.'),true);
 assert.equal(re.test('C01 lifts prop_table.1 as the product package.'),false);
 assert.equal(re.test('C01 lifts prop_tableX1.'),true);
 assert.equal(re.test('C01 places\nprop_cup on the table.'),false);
});
test('typed manifest preserves an original product distinct from its supporting furniture',()=>{
 const p={product:{name:'菊花茶'},assetLibraries:{props:[{id:'table',name:'餐桌',assetRequired:false},{id:'cup',name:'茶杯',assetRequired:true}]}};
 const m=identity.manifest(p);assert.equal(m.product.id,'product');assert.equal(m.objects[0].kind,'scene_furniture');assert.equal(m.objects[1].kind,'independent_prop');assert.equal(m.objects.some(x=>x.id===m.product.id),false);
});
