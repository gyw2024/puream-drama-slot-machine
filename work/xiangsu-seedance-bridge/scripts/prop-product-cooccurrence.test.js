'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decorateProjectAssetMetadata}=require('../app/asset-eligibility');
test('product co-occurrence does not consume independent evidence and handheld props',()=>{
 const p={product:{name:'原装商品',imagePath:'original.png'},characters:[],shots:[{id:'S1',productMention:true,action:'原装商品旁有旧照片、地质笔记本和钢笔。'},{id:'S2',action:'归还旧照片、地质笔记本和钢笔。'}],assetLibraries:{props:['旧照片','地质笔记本','钢笔','原装商品','独立茶包'].map((name,i)=>({id:'P'+i,name,coreStory:true,units:['S1','S2']}))}};
 decorateProjectAssetMetadata(p);
 assert.deepEqual(p.assetLibraries.props.map(x=>x.assetRequired),[true,true,true,false,true]);
 p.assetLibraries.props[4].isProductComponent=true;
 decorateProjectAssetMetadata(p);
 assert.equal(p.assetLibraries.props[4].assetRequired,false,'only an explicit component relation suppresses the otherwise independent prop');
});
test('unnamed product cannot be inferred solely from repeated nearby evidence',()=>{
 const p={product:{imagePath:'original.png'},characters:[],shots:[{id:'S1',productMention:true},{id:'S2',productMention:true}],assetLibraries:{props:[{id:'P1',name:'旧照片',coreStory:true,units:['S1','S2']}]}};
 decorateProjectAssetMetadata(p);assert.equal(p.product.name,undefined);assert.equal(p.assetLibraries.props[0].assetRequired,true);
});
