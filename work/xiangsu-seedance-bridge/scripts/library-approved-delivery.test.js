const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchWorkflow,PROMPT_REVIEW_BUNDLE_VERSION,promptReviewSourceFingerprint}=require('../app/workbench-workflow');
const {defaultSettings}=require('../app/workbench-store');
for(const type of ['props','wardrobes'])test(type+' submits exact confirmed Agent text without legacy template reconstruction',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'library-approved-'));try{
 const ref=path.join(dir,'ref.png');fs.writeFileSync(ref,'test image transport not invoked');const stage=type==='props'?'prop_asset':'wardrobe_asset';
 const asset={id:'a',name:'approved asset',description:'old vague description',assetRequired:true,characterId:'c'};
 const p={id:'p',generation:{mode:'asset_direct'},product:{name:'different product'},characters:[{id:'c',name:'actor'}],scenes:[],shots:[],assetLibraries:{[type]:[asset]},candidates:[{id:'ref',entityType:'character',entityId:'c',stage:'character_intro',filePath:ref,selected:true}],script:{raw:'Approved costume has a navy jacket, grey knit top, charcoal trousers and dark shoes.'}};
 const exact='Agent complete navy jacket, grey knit top, charcoal trousers, dark shoes. Identity from image 1. No extra template.';
 p.promptReview={version:PROMPT_REVIEW_BUNDLE_VERSION,status:'approved',sourceFingerprint:promptReviewSourceFingerprint(p),items:[{entityType:'library',entityId:'a',stage,status:'confirmed',prompt:exact}]};
 const w=Object.create(WorkbenchWorkflow.prototype),settings=defaultSettings();settings.imageProvider={kind:'test'};w.store={getProject:()=>p,getSettings:()=>settings,assetDir:()=>dir};w.operationControls=new Map();w.assertPromptReviewApproved=()=>{};w.settleImageFailure=()=>{};
 let captured;w.executeAdaptiveCapability=async(kind,provider,payload)=>{captured=payload.prompt;throw Object.assign(Error('intercepted before media'),{code:'TEST_INTERCEPT'});};
 await assert.rejects(w.generateLibraryAssetImage('p',type,'a',{track:false,promptPrepared:true,prompt:'unreviewed stale caller text'}),{code:'TEST_INTERCEPT'});assert.equal(captured,exact);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
