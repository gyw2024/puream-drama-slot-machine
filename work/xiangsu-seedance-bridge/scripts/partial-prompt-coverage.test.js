'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkbenchWorkflow,PROMPT_REVIEW_BUNDLE_VERSION,promptReviewSourceFingerprint,promptReviewSettingsFingerprint,savePromptReviewWithStableFingerprint}=require('../app/workbench-workflow');
for(const method of ['confirmAllPromptReview','confirmPromptReviewItem'])test(`${method} cannot approve a bundle with an unresolved video draft`,async()=>{
 const p={id:'test',generation:{engine:'seedance'},productionPlan:{},script:{},scenes:[],assetLibraries:{props:[],voices:[],wardrobes:[]}};
 let stored=p;const store={getProject:()=>structuredClone(stored),saveProject:v=>(stored=structuredClone(v)),getSettings:()=>({})};
 p.characters=[{id:'C01',name:'Actor',promptOverrides:{}}];p.shots=[{id:'S01',promptCompilationPending:{requiresFinalEditing:true}}];
 p.promptReview={version:PROMPT_REVIEW_BUNDLE_VERSION,status:'ready',productionRevision:String(p.productionRevision||''),counts:{total:1},items:[{id:'character:C01:character_sheet',entityType:'character',entityId:'C01',stage:'character_sheet',prompt:'One actor in a dark coat.',displayPrompt:'One actor in a dark coat.',executionLanguage:'en',translationStatus:'local',status:'pending',mode:'system'}]};
 p.promptReview.sourceFingerprint=promptReviewSourceFingerprint(p);p.promptReview.settingsFingerprint=promptReviewSettingsFingerprint(store.getSettings());savePromptReviewWithStableFingerprint(store,p);
 const wf=new WorkbenchWorkflow({store,bridge:{}});wf.compilePromptReviewEdit=async()=>p.promptReview.items[0].prompt;
 const saved=store.getProject(p.id);assert(wf.promptReviewIsCurrent(saved),JSON.stringify({version:saved.promptReview?.version,expectedVersion:PROMPT_REVIEW_BUNDLE_VERSION,revision:[saved.productionRevision,saved.promptReview?.productionRevision],sourceMatches:saved.promptReview?.sourceFingerprint===promptReviewSourceFingerprint(saved),settingsMatches:saved.promptReview?.settingsFingerprint===promptReviewSettingsFingerprint(store.getSettings()),counts:saved.promptReview?.counts,items:saved.promptReview?.items}));
 const r=method==='confirmAllPromptReview'?await wf[method](p.id):await wf[method](p.id,p.promptReview.items[0].id,p.promptReview.items[0].displayPrompt);
 assert.equal(r.promptReview.status,'ready');assert.equal(r.promptReview.approvedAt,'');assert.equal(wf.promptReviewIsCurrent(r,'approved'),false);
});
test('continuing a current but incomplete review resumes authoring instead of reopening the same unfinished cards',async()=>{
 let p={id:'resume',shots:[{id:'S01',promptCompilationPending:{requiresFinalEditing:true}}],promptReview:{status:'ready'},automation:{}};
 const wf=Object.create(WorkbenchWorkflow.prototype);let preparations=0;
 wf.store={getProject:()=>p,saveProject:v=>(p=v)};wf.promptReviewIsCurrent=()=>true;
 wf.preparePromptReviewBundle=async()=>{preparations++;p.shots[0]={id:'S01'};return p;};wf.setAutomation=()=>{};
 await wf.requestPromptReview('resume',{resumeStage:'assets'});assert.equal(preparations,1);assert.equal(p.shots[0].promptCompilationPending,undefined);
});
test('complete content with a real negative quality opinion remains confirmable without erasing that opinion',async()=>{
 const p={id:'quality-advice',generation:{engine:'seedance'},productionPlan:{},script:{editorialReview:{ok:false,issues:[{message:'Review the emotional transition with the user'}]}},characters:[{id:'C01',name:'Actor',promptOverrides:{}}],shots:[],scenes:[],assetLibraries:{props:[],voices:[],wardrobes:[]}};
 let stored=p;const store={getProject:()=>structuredClone(stored),saveProject:v=>(stored=structuredClone(v)),getSettings:()=>({})};
 p.promptReview={version:PROMPT_REVIEW_BUNDLE_VERSION,status:'ready',qualityStatus:'needs_user_review',productionRevision:'',counts:{total:1},sourceAdvisories:p.script.editorialReview.issues,items:[{id:'character:C01:character_sheet',entityType:'character',entityId:'C01',stage:'character_sheet',prompt:'One actor in a dark coat.',displayPrompt:'One actor in a dark coat.',executionLanguage:'en',translationStatus:'local',status:'pending',mode:'system'}]};
 p.promptReview.sourceFingerprint=promptReviewSourceFingerprint(p);p.promptReview.settingsFingerprint=promptReviewSettingsFingerprint({});savePromptReviewWithStableFingerprint(store,p);
 const wf=new WorkbenchWorkflow({store,bridge:{}});wf.compilePromptReviewEdit=async()=>p.promptReview.items[0].prompt;
 const authored=store.getProject(p.id);authored.script.authoredWithoutDurationTarget=true;savePromptReviewWithStableFingerprint(store,authored);
 const requested=await wf.requestPromptReview(p.id,{requireCompleteDelivery:true,resumeStage:'assets'});
 assert.equal(requested.required,true);assert.equal(requested.project.promptReview.status,'ready');
 const result=await wf.confirmAllPromptReview(p.id);
 assert.equal(result.promptReview.status,'approved');assert.equal(result.script.editorialReview.ok,false);assert.deepEqual(result.promptReview.sourceAdvisories,p.script.editorialReview.issues);
});
