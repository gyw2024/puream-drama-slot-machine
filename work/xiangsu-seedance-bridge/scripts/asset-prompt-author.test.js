'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const author=require('../app/asset-prompt-author'),physical=require('../app/physical-asset-prompt');
function fixture(){
 let p={id:'p',generation:{mode:'storyboard_sheet'},script:{raw:'门口空场景，门向内开，墙上没有照片。桌子是人物推动的独立道具。'},product:{},characters:[],scenes:[{id:'L1',name:'门口',description:'空门口，固定木门，无照片。',descriptionEn:'An empty doorway with a fixed inward-opening wooden door.',visualDesign:{version:'v',sha256:'design1',sourceScriptSha256:'source1',descriptionEn:'An empty doorway with a fixed inward-opening wooden door.',descriptionZh:'空门口，固定木门，无照片。',designChoices:[]}}],assetLibraries:{props:[]},candidates:[]};
 const get=()=>structuredClone(p),save=v=>{p=structuredClone(v);};
 const item=()=>({id:'scene:L1:scene_asset',entityType:'scene',entityId:'L1',stage:'scene_asset',mode:'system',prompt:physical.physicalAssetPrompt('scene_asset',p.scenes[0]),agentAudit:{issues:[]}});
 return {get,save,item};
}
const row=(item,extra={})=>({id:item.id,promptEn:'One empty four-view location board. The same inward-opening door appears consistently; no wall pictures and no movable table.',promptZh:'一张空场景四视图，同一扇内开门保持一致，不出现墙面照片或可移动桌子。',resolution:'revised',reason:'The full executable prompt follows the original empty doorway; unrelated template objects are omitted.',sourceEvidence:['墙上没有照片。桌子是人物推动的独立道具。'],...extra});
test('Agent owns the entire asset prompt and the program does not reattach its old wrapper',async()=>{
 const f=fixture(),i=f.item();i.agentAudit.issues=['Remove the unsupported wall pictures from the template, not from the source design.'];let calls=0;
 await author.author({getProject:f.get,saveProject:f.save,items:[i],repairOnly:true,generate:async m=>{calls++;const input=JSON.parse(m[1].content);assert.match(input.items[0].priorPrompt,/wall portraits/);return {items:input.items.map(x=>row(x))};}});
 assert.equal(calls,1);assert.equal(physical.physicalAssetPrompt('scene_asset',f.get().scenes[0]),row(i).promptEn);
 assert.equal(physical.physicalAssetPromptChinese('scene_asset',f.get().scenes[0]),row(i).promptZh);
 assert.doesNotMatch(i.prompt,/wall portraits and medals/);assert.equal(f.get().scenes[0].descriptionEn,'An empty doorway with a fixed inward-opening wooden door.');
 await author.author({getProject:f.get,saveProject:f.save,items:[f.item()],generate:()=>assert.fail('completed unchanged asset must not be reauthored')});
});
test('an unchanged claimed repair is sent back to the Agent rather than recycled as progress',async()=>{
 const f=fixture(),i=f.item();i.agentAudit.issues=['Remove template objects'];let n=0;
 await author.author({getProject:f.get,saveProject:f.save,items:[i],repairOnly:true,generate:async m=>{const input=JSON.parse(m[1].content);if(++n===1)return {items:[row(i,{promptEn:i.prompt})]};assert.ok(input.delivery.invalid.length);return {items:[row(i)]};}});
 assert.equal(n,2);assert.equal(i.prompt,row(i).promptEn);
});
test('a source-supported Agent adjudication clears only the exact finding with its evidence retained',async()=>{
 const f=fixture(),i=f.item();i.agentAudit.issues=['Conditional preservation means invent pictures'];const original=i.prompt;
 await author.author({getProject:f.get,saveProject:f.save,items:[i],repairOnly:true,generate:async()=>({items:[row(i,{promptEn:original,resolution:'source_supported',reason:'The clause preserves only approved objects. The source explicitly excludes pictures; it does not authorize adding any.'})]})});
 assert.equal(i.agentAudit.issues.length,1);assert.equal(i.agentAudit.status,'disputed');assert.match(i.agentAudit.authorChallenge.reason,/only approved/);
 const fresh={...f.item(),agentAudit:{issues:['A different real issue']}};author.applyResolutions(f.get(),[fresh]);assert.equal(fresh.agentAudit.issues.length,1);
 const p=f.get();p.script.raw+=' 新增另一项事实。';f.save(p);const stale={...f.item(),agentAudit:{issues:['Conditional preservation means invent pictures']}};author.applyResolutions(f.get(),[stale]);assert.equal(stale.agentAudit.issues.length,1);
});
test('manual edits and approved bitmaps remain user owned',async()=>{
 const f=fixture(),manual={...f.item(),mode:'manual'};let calls=0;await author.author({getProject:f.get,saveProject:f.save,items:[manual],generate:()=>{calls++;}});
 const p=f.get();p.candidates=[{entityType:'scene',entityId:'L1',filePath:'approved.png'}];f.save(p);await author.author({getProject:f.get,saveProject:f.save,items:[f.item()],generate:()=>{calls++;}});assert.equal(calls,0);
});
test('cancelled late author reply cannot overwrite saved assets',async()=>{
 const f=fixture(),i=f.item(),before=f.get(),c=new AbortController();
 await assert.rejects(author.author({getProject:f.get,saveProject:f.save,items:[i],signal:c.signal,generate:async()=>{c.abort();return {items:[row(i)]};}}),{code:'PROVIDER_REQUEST_ABORTED'});
 assert.deepEqual(f.get(),before);
});
test('changing a source design invalidates the complete prompt rather than silently retaining it',async()=>{
 const f=fixture();await author.author({getProject:f.get,saveProject:f.save,items:[f.item()],generate:async m=>({items:JSON.parse(m[1].content).items.map(i=>row(i))})});
 const p=f.get();assert.ok(author.current('scene_asset',p.scenes[0]));p.scenes[0].descriptionEn='A new explicitly approved door geometry';assert.equal(author.current('scene_asset',p.scenes[0]),false);
});
test('actual WorkbenchStore preserves Agent ownership across reload and paid-prompt compilation',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {WorkbenchStore}=require('../app/workbench-store'),{WorkbenchWorkflow}=require('../app/workbench-workflow');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asset-prompt-owner-'));
 try{
  const store=new WorkbenchStore(dir),p=store.createProject('Agent ownership persistence');const f=fixture().get();
  store.patchProject(p.id,{script:f.script,scenes:f.scenes});const get=()=>store.getProject(p.id),save=x=>store.saveProject(x);
  const i={id:'scene:L1:scene_asset',entityType:'scene',entityId:'L1',stage:'scene_asset',mode:'system',prompt:'Legacy template'};
  await author.author({getProject:get,saveProject:save,items:[i],generate:async()=>({items:[row(i)]})});
  const loaded=get(),w=Object.create(WorkbenchWorkflow.prototype);
  assert.ok(author.current('scene_asset',loaded.scenes[0]));
  assert.equal(w.compileImagePrompt(loaded,store.getSettings(),'scene_asset',loaded.scenes[0]),row(i).promptEn);
  await author.author({getProject:get,saveProject:save,items:[i],generate:()=>assert.fail('same saved source must resume without a new request')});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('concurrent independent batches preserve all actual store records',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{WorkbenchStore}=require('../app/workbench-store');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asset-prompt-parallel-'));
 try { const store=new WorkbenchStore(dir), p=store.createProject('parallel assets'), f=fixture().get();
 const scenes=Array.from({length:12},(_,n)=>({...f.scenes[0],id:'L'+n,name:'Room '+n})); store.patchProject(p.id,{script:f.script,scenes});
 const items=scenes.map(e=>({id:'scene:'+e.id+':scene_asset',entityType:'scene',entityId:e.id,stage:'scene_asset',mode:'system',prompt:'Legacy'}));
 let active=0,max=0,calls=0;await author.author({getProject:()=>store.getProject(p.id),saveProject:x=>store.saveProject(x),items,generate:async m=>{active++;max=Math.max(active,max);calls++;await new Promise(r=>setTimeout(r,25));active--;return {items:JSON.parse(m[1].content).items.map(i=>row(i))};}});
 assert.equal(calls,3);assert.equal(max,3);assert.equal(store.getProject(p.id).scenes.filter(e=>author.current('scene_asset',e)).length,12);
 } finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('wardrobe receives the approved linked character ensemble and invalidates on design change',async()=>{const f=fixture(),p=f.get();p.characters=[{id:'c',name:'Gu',descriptionEn:'Navy jacket over pale gray knit, charcoal trousers, dark shoes'}];p.assetLibraries.wardrobes=[{id:'w',characterId:'c',name:'Casual',description:'off-duty clothes'}];f.save(p);const i={id:'library:w:wardrobe_asset',entityId:'w',entityType:'library',stage:'wardrobe_asset',mode:'system',prompt:'vague'};let input;await author.author({getProject:f.get,saveProject:f.save,items:[i],generate:async m=>{input=JSON.parse(m[1].content).items[0];return {items:[row(i)]};}});assert.match(input.linkedCharacter.descriptionEn,/Navy jacket/);const saved=f.get(),before=author.sourceFingerprint(saved,i.stage,saved.assetLibraries.wardrobes[0]);saved.characters[0].descriptionEn='Approved new jacket';assert.notEqual(author.sourceFingerprint(saved,i.stage,saved.assetLibraries.wardrobes[0]),before);});
