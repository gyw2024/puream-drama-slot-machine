'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{h3AssetDirectSemanticSource}=require('../app/workbench-workflow');
test('collection/member identity reaches directing semantics without multiplying the group',()=>{
 const p={assetLibraries:{props:[{id:'books',name:'十二本笔记',descriptionEn:'One collection of twelve notebooks, including one green member.'},{id:'green',name:'绿皮笔记',descriptionEn:'The green member of the twelve-book collection.',sourceInventory:{parentId:'books'}}]}};
 const props=h3AssetDirectSemanticSource(p).props;assert.deepEqual(props[0].containsMemberIds,['green']);assert.equal(props[1].parentId,'books');assert.match(props[0].physicalDesign,/including one green/);
});
test('unrelated single-prop semantic source remains byte-compatible',()=>{
 const props=[{id:'paper',name:'投诉单',aliases:['单据']}];assert.deepEqual(h3AssetDirectSemanticSource({assetLibraries:{props}}).props,props);
});
