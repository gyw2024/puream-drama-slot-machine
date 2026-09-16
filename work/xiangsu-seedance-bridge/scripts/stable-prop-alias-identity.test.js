'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
for (const variant of ['stable','source-positional','package-positional']) test(`reference-library synchronization cannot merge distinct ${variant} photo IDs by generic aliases`,()=>{
 let p={id:'test',characters:[],scenes:[],script:{raw:''},shots:[{id:'S01',characterIds:[],propNames:['全队合影'],propIds:['prop_team']},{id:'S02',characterIds:[],propNames:['满月照片'],propIds:['prop_baby']}],product:{},candidates:[],assetLibraries:{props:[
  {id:'prop_team',name:'全队合影',aliases:['老照片','两张照片'],coreStory:true,units:['S01'],description:'Whole team on a mountain.',sourceInventory:{classification:'core'}},
  {id:'prop_baby',name:'满月照片',aliases:['老照片','两张照片'],coreStory:true,units:['S02'],description:'A father holding a baby.',sourceInventory:{classification:'core'}}
 ],wardrobes:[],voices:[]}};
 if(variant!=='stable'){
  p.assetLibraries.props[0].id='P01';p.assetLibraries.props[1].id='P02';p.shots[0].propIds=['P01'];p.shots[1].propIds=['P02'];
 }
 if(variant==='package-positional'){
  p.generation={mode:'production_package'};for(const prop of p.assetLibraries.props)delete prop.sourceInventory;
 }
 const expected=p.assetLibraries.props.map(x=>[x.id,x.name]);
 const store={getProject:()=>p,saveProject:v=>(p=v),getSettings:()=>({})};
 const wf=new WorkbenchWorkflow({store,bridge:{}});
 for(let i=0;i<3;i++)wf.syncReferenceLibraries(p.id);
 assert.equal(p.assetLibraries.props.length,2);assert.deepEqual(p.assetLibraries.props.map(x=>[x.id,x.name]),expected);
 assert.match(p.assetLibraries.props[0].description,/Whole team/);assert.match(p.assetLibraries.props[1].description,/baby/);
 assert.deepEqual(p.assetLibraries.props[0].units,['S01']);assert.deepEqual(p.assetLibraries.props[1].units,['S02']);
});
