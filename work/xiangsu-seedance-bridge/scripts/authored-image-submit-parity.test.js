const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
const {physicalAssetPrompt}=require('../app/physical-asset-prompt');
function harness(errorCode='TEST_CAPTURE'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'puream-prompt-parity-'));
 const character={id:'C01',name:'角色',assetRequired:true,descriptionEn:('An adult courier with a navy coat, short black hair, a lean build and dark trousers. ').repeat(35),visualDesign:{version:1}};
 const project={id:'test',productionRevision:'r1',generation:{mode:'asset_direct',aspectRatio:'9:16'},characters:[character],scenes:[],shots:[],candidates:[],assetLibraries:{},product:{}};
 const settings={imageProvider:{kind:'test-provider'},generation:{visualStyle:''},prompts:{}};
 const calls=[],workflow=Object.create(WorkbenchWorkflow.prototype);Object.assign(workflow,{operationControls:new Map(),store:{getProject:()=>project,getSettings:()=>settings,assetDir:()=>dir},settleImageFailure:()=>{},executeAdaptiveCapability:async(kind,provider,input)=>{calls.push(input);throw Object.assign(Error('capture only'),{code:errorCode});}});
 return {dir,character,project,settings,workflow,calls};
}
test('approved physical image prompt reaches the provider byte-for-byte beyond old 1850-character cap',async()=>{
 const x=harness();try{const expected=physicalAssetPrompt('character_intro',x.character);assert.ok(expected.length>3000);
 await assert.rejects(x.workflow._generateImageCandidateUnlocked('test','character_intro','C01','',{promptPrepared:true}),{code:'TEST_CAPTURE'});
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].prompt,expected);assert.equal(x.calls[0].options.referenceInputs.length,0);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('provider length rejection never cuts the approved prompt or resubmits silently',async()=>{
 const x=harness('PROMPT_TOO_LONG');try{
 await assert.rejects(x.workflow._generateImageCandidateUnlocked('test','character_intro','C01','',{promptPrepared:true}),e=>e.code==='IMAGE_PROMPT_REVIEW_REQUIRED'&&e.expectedControl===true);
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].prompt,physicalAssetPrompt('character_intro',x.character));
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});

test('every reviewed sheet panel survives the real submission boundary with its actual reference file',async()=>{
 const x=harness();try{
  x.project.generation.mode='storyboard_sheet';x.project.characters=[];
  const file=path.join(x.dir,'scene.png');fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z1cAAAAASUVORK5CYII=','base64'));
  x.project.scenes=[{id:'SC1',name:'Empty room',descriptionEn:'An empty room with one table.'}];
  x.project.candidates=[{id:'scene-image',entityType:'scene',entityId:'SC1',stage:'scene_asset',filePath:file,selected:true,status:'completed',productionRevision:'r1'}];
  const shot={id:'S01',number:1,title:'Empty room',duration:12,sceneId:'SC1',sceneName:'Empty room',visibleCharacterIds:[],imageReferenceCharacterIds:[],characterIds:[],stateBefore:'Empty room',stateAfter:'Empty room',action:'An empty room.',finalPromptEditing:{status:'authored',detailedDescriptionEn:'An empty room remains still.'}};x.project.shots=[shot];
  const still=require('../app/storyboard-still-author');await still.author({getProject:()=>x.project,saveProject:()=>{},kind:'sheet',generate:async()=>({items:[{shotId:'S01',panels:Array.from({length:12},(_,second)=>({second,timeSecond:second===11?12:second,visibleCharacterIds:[],descriptionEn:`An empty room at instant ${second}. One table stands against the northern wall below a closed window. The southern camera shows the unobstructed floor and the same fixed doorway. No person or movable object is present.`}))}]})});
  const expected=x.workflow.compileImagePrompt(x.project,x.settings,'storyboard_sheet',shot);assert.ok(expected.length>2500);
  await assert.rejects(x.workflow._generateImageCandidateUnlocked('test','storyboard_sheet','S01','',{promptPrepared:true}),{code:'TEST_CAPTURE'});
  assert.equal(x.calls.length,1);assert.equal(x.calls[0].prompt,expected);assert.match(x.calls[0].prompt,/Panel 12, instant 12.000/);assert.equal(x.calls[0].options.referenceInputs[0].path,file);
 }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
