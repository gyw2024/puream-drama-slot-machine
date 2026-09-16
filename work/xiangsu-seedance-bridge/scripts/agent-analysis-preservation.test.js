'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('source-review version migration retains unchanged asset designs and shot candidates',async()=>{
 const writer=require('../app/shot-screenplay'),d=require('./shot-screenplay-fixture').fixture(),raw=writer.render(d),record=writer.makeRecord(d,raw,{}),data=writer.projectData(record);
 record.version='previous-source-review';
 let project={...data,id:'preserve',product:{},script:{raw,shotScreenplay:record},assetLibraries:{props:data.props,wardrobes:data.wardrobes},currentStage:'script'};
 project.characters[0].visualDesign={descriptionEn:'Already authored fixed appearance',status:'authored'};project.characters[0].imagePath='preserved-existing-image.png';project.scenes[0].visualDesign={descriptionEn:'Already authored scene'};
 project.shots[0].finalPromptEditing={status:'authored',detailedDescriptionEn:'Already authored video candidate'};
 assert.deepEqual(writer.issues(record.document),[]);assert.equal(record.document.characters[0].visualDesign,undefined);
 const prior=structuredClone(project);let calls=[];
 const workflow={store:{getProject:()=>structuredClone(project),saveProject:p=>project=p,getSettings:()=>({textProvider:{}})},operationControls:new Map(),setAutomation:()=>{},productionTextOptions:(_id,_stage,opts)=>opts,
 generateText:async(_provider,m,o)=>{calls.push(o.stage);assert.equal(o.stage,'shot_screenplay_review');return {ok:true,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'Source reviewed against current requirements.'}],issues:[]};}};
 await require('../app/agent-analysis-entry').analyze(workflow,project.id,{forceReanalysis:true});
 assert.deepEqual(calls,['shot_screenplay_review']);assert.ok(writer.runtimeCurrent(project));
 assert.deepEqual(project.characters[0].visualDesign,prior.characters[0].visualDesign);assert.equal(project.characters[0].imagePath,prior.characters[0].imagePath);
 assert.deepEqual(project.scenes[0].visualDesign,prior.scenes[0].visualDesign);assert.deepEqual(project.shots[0].finalPromptEditing,prior.shots[0].finalPromptEditing);
});

for(const mode of ['upload','adapt'])test(mode+': review migration uses original reference and retains entry mode',async()=>{
 const writer=require('../app/shot-screenplay'),d=require('./shot-screenplay-fixture').fixture(),raw=writer.render(d),record=writer.makeRecord(d,raw,{ok:true},mode),data=writer.projectData(record);record.version='old-source-review';
 let project={...data,id:'provenance',product:{},script:{raw,shotScreenplay:record,...(mode==='adapt'?{adaptation:{sourceText:'IMMUTABLE ORIGINAL REFERENCE'}}:{originalRaw:'IMMUTABLE ORIGINAL REFERENCE'})},assetLibraries:{props:data.props,wardrobes:data.wardrobes}};
 const workflow={store:{getProject:()=>structuredClone(project),saveProject:p=>project=p,getSettings:()=>({textProvider:{}})},operationControls:new Map(),setAutomation:()=>{},productionTextOptions:(_id,_stage,opts)=>opts,generateText:async(_provider,m,o)=>{assert.equal(o.stage,'shot_screenplay_review');const input=JSON.parse(m.at(-1).content);assert.equal(input.mode,mode);assert.equal(input.originalSource,'IMMUTABLE ORIGINAL REFERENCE');return{ok:true,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'Complete original source checked'}],issues:[]};}};
 await require('../app/agent-analysis-entry').analyze(workflow,project.id);assert.equal(project.script.shotScreenplay.mode,mode);assert.ok(writer.runtimeCurrent(project));
});
