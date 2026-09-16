'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cues=require('../app/native-identity-cues');
const physical='Chinese woman, 74, gray bun, lined oval face, slender build; teal cardigan, dark trousers.';
test('pure appearance extraction uses five-item planning batches, preserves assets and resumes exact sources',async()=>{
 const project={characters:Array.from({length:7},(_,i)=>({id:'C'+i,descriptionEn:physical+' Her hands are empty and relaxed.',gender:'female',age:74})),candidates:[{id:'original',filePath:'unchanged.png'}]};
 const before=JSON.stringify(project.candidates),calls=[];
 const generate=async(m,o)=>{const input=JSON.parse(m[1].content);calls.push(input.items.map(i=>i.id));assert.equal(o.agentStage,'planning');return {items:input.items.map(i=>({id:i.id,text:physical}))};};
 await cues.author({project,generate,save:()=>{}});assert.deepEqual(calls.map(a=>a.length),[5,2]);assert.equal(JSON.stringify(project.candidates),before);assert.ok(project.characters.every(c=>cues.current(c)));assert.match(project.characters[0].descriptionEn,/empty and relaxed/,'original asset description was overwritten');
 await cues.author({project,generate,save:()=>{}});assert.equal(calls.length,2);project.characters[0].descriptionEn+=' A brown coat replaces the cardigan.';
 await cues.author({project,generate,save:()=>{}});assert.deepEqual(calls.at(-1),['C0']);
});
test('identity receipt validates data presence while Agents own wording',()=>{
 assert.equal(cues.valid(physical),true);assert.equal(cues.valid('Chinese elderly woman with calm-looking facial features'),true);
 for(const invalid of ['', '  ',null,{},42])assert.equal(cues.valid(invalid),false);
});
test('incomplete identity delivery continues past two replies without losing accepted items',async()=>{
 const project={characters:[{id:'C1',descriptionEn:physical}]};let n=0;
 await cues.author({project,save:()=>{},generate:async()=>({items:++n<3?[]:[{id:'C1',text:physical}]})});
 assert.equal(n,3);assert.ok(cues.current(project.characters[0]));
});

test('real store roundtrips preserve every cue across five-plus-two batches',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {WorkbenchStore}=require('../app/workbench-store');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'puream-native-cue-store-'));
 try{
  const store=new WorkbenchStore(dir),created=store.createProject('Isolated cue persistence test');
  store.patchProject(created.id,{characters:Array.from({length:7},(_,i)=>({id:'C'+i,name:'人物'+i,descriptionEn:physical,description:'七十四岁女性，灰色发髻，青色开衫。',gender:'female',age:74}))});
  const p=store.getProject(created.id),calls=[];
  await cues.author({project:p,generate:async(m)=>{const items=JSON.parse(m[1].content).items;calls.push(items.length);return {items:items.map(e=>({id:e.id,text:physical}))};},save:v=>store.saveProject(v)});
  assert.deepEqual(calls,[5,2]);
  assert.ok(store.getProject(p.id).characters.every(c=>cues.current(c)),'all seven cues must exist after actual normalization and persistence');
  assert.ok(p.characters.every(c=>cues.current(c)));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
