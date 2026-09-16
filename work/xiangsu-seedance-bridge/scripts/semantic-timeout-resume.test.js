'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
function fixture(){
 let p={id:'resumable-text',generation:{engine:'hailuo-h3',mode:'asset_direct'},productionPlan:{},script:{},characters:[],scenes:[],assetLibraries:{props:[]},shots:[1,2,3].map(i=>({id:`S0${i}`,number:i,duration:10,action:'A door opens.',subshots:[],dialogueTurns:[{sourceDialogueId:`D${i}`,speakerId:'C01',text:'一'.repeat(20),sourceTone:'清楚'}]}))};
 const store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v)),getSettings:()=>({textProvider:{}})};
 return {wf:new WorkbenchWorkflow({store,bridge:{}}),get:()=>p};
}
test('semantic timeout shrinks unfinished text batches in-place with the same Agent settings',async()=>{
 const {wf,get}=fixture(),calls=[];wf.productionTextOptions=(_p,_s,o)=>o;
 wf.generateText=async(_settings,messages)=>{const request=JSON.parse(messages.at(-1).content);calls.push(request.shots.map(s=>s.shotId));if(calls.length<=2)throw Object.assign(Error('model text timeout'),{code:'LOCAL_AGENT_TIMEOUT'});return {items:request.shots.map(s=>({shotId:s.shotId,segments:[],dialogue:s.dialogue.map(d=>({sourceDialogueId:d.sourceDialogueId,startSecond:3,endSecond:7,...Object.fromEntries(['deliveryZh','deliveryEn','vocalArcZh','vocalArcEn','expressionZh','expressionEn','expressionArcEn','bodyZh','bodyEn','blockingZh','blockingEn','speakerFacingZh','speakerFacingEn','listenerReactionZh','listenerReactionEn'].map(k=>[k,'precise performed cue']))}))}))};};
 await wf.compileH3AssetDirectSemanticsBatch('resumable-text');
 assert.deepEqual(calls,[['S01','S02','S03'],['S01','S02'],['S01'],['S02'],['S03']]);assert.equal(get().h3AssetDirectSemanticCompile.status,'completed');assert.equal(get().h3AssetDirectSemanticCompile.compiledCount,3);
});
test('single-shot timeout remains a saved draft instead of an unbounded retry loop',async()=>{
 const {wf,get}=fixture();let calls=0;wf.productionTextOptions=(_p,_s,o)=>o;wf.generateText=async()=>{calls++;throw Object.assign(Error('model text timeout'),{code:'LOCAL_AGENT_TIMEOUT'});};
 await assert.rejects(wf.compileH3AssetDirectSemanticsBatch('resumable-text'),{code:'LOCAL_AGENT_TIMEOUT'});assert.equal(calls,3);assert.equal(get().h3AssetDirectSemanticCompile.status,'deferred');assert.equal(get().h3AssetDirectSemanticCompile.batchSize,1);
});

test('an explicit upstream conflict is preserved and never retried as missing fields',async()=>{const {wf,get}=fixture();let calls=0;wf.productionTextOptions=(_p,_s,o)=>o;wf.generateText=async()=>{calls++;return {items:[{shotId:'S01',status:'source_planning_repair_required',reasonEn:'A rigid jar cannot unfold.',splitBoundary:'Repair the source action.'}]};};await assert.rejects(wf.compileH3AssetDirectSemanticsBatch('resumable-text'),{code:'H3_SOURCE_PLANNING_REPAIR_REQUIRED'});assert.equal(calls,1);assert.equal(get().h3AssetDirectSemanticCompile.status,'deferred');assert.equal(get().h3AssetDirectSemanticCompile.batches[0].partialItems[0].reasonEn,'A rigid jar cannot unfold.');});
