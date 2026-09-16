'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../app/commerce-authoring-policy');
test('production directions stay available to the author without becoming spoken selling points',()=>{
 const product={name:'菊花茶',sellingPoints:'花香；冲泡饮用',description:'不宣称医疗功效。包装外观以用户原图为准。镜头不得单独拍商品。'};
 assert.deepEqual(policy.suppliedFacts(product),['花香','冲泡饮用']);
 assert.deepEqual(policy.context(product).productionConstraints,['不宣称医疗功效','包装外观以用户原图为准','镜头不得单独拍商品']);
});
test('negative product facts and suitability warnings are not treated as production instructions',()=>{
 const product={description:'不含糖。儿童不宜饮用。包装外观为黄色。'};
 assert.deepEqual(policy.suppliedFacts(product),['不含糖','儿童不宜饮用','包装外观为黄色']);
 assert.deepEqual(policy.context(product).productionConstraints,[]);
});
