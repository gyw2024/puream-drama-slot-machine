'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchStore,defaultSettings}=require('../app/workbench-store'),{WorkbenchWorkflow}=require('../app/workbench-workflow');
test('manual translation failure preserves source and leaves recoverable pending review',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'simple-no-text-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new WorkbenchStore(dir);const settings=defaultSettings();settings.localAgents={text:'codex',stages:{review:'codex'},providers:{codex:{model:'gpt-5.6-sol',reasoningEffort:'medium'}}};store.saveSettings(settings);
 const p=store.createProject('manual',{mode:'storyboard_sheet',modeConfirmed:true,inputMode:'manual'});p.productionPlan.simpleAssetOnly=true;
 p.characters=[{id:'C01',name:'陈岩',description:'30岁男性，短黑发，灰色衬衫。'}];p.scenes=[{id:'SC01',name:'餐桌',description:'空客厅，固定木餐桌，左窗右门。'}];
 p.shots=[{id:'S01',number:1,duration:10,sceneId:'SC01',scene:'餐桌',action:'陈岩在桌左侧站稳，低头自语。',visibleCharacterIds:['C01'],dialogue:'陈岩（沉稳）：我会把这件事做完。',dialogueTurns:[{speakerId:'C01',speaker:'陈岩',text:'我会把这件事做完。',tone:'沉稳',startSecond:1,endSecond:4}],startFrame:'陈岩站在木桌左侧。',endFrame:'陈岩仍在木桌左侧。'}];store.saveProject(p);
 let calls=0;const w=new WorkbenchWorkflow({store,bridge:{},textGenerator:async()=>{calls++;throw Error('Unexpected text dispatch');},remoteFetch:async()=>{throw Error('Unexpected paid media');}});
 const r=await w.requestPromptReview(p.id);assert.equal(calls,1);assert.equal(r.project.promptReview.status,"pending");assert.equal(r.project.shots[0].action,p.shots[0].action);assert.equal(r.project.manualDirectionTranslation.status,"needs_attention");assert.ok(r.project.promptReview.items.length>0);assert.equal(r.project.promptReview.stageAgentAudit.status,"deferred");assert.equal(r.project.promptReview.stageAgentAudit.stage,"prompt_review");assert.ok(r.project.promptReview.items.some(i=>i.stage==='shot_video'));
});
