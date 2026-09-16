'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AdaptiveProductionAgent}=require('../app/adaptive-production-agent');
const {WorkbenchWorkflow,h3AssetDirectSemanticFingerprint}=require('../app/workbench-workflow');
const turn={sourceDialogueId:'D1',speakerId:'C01',text:'一'.repeat(20),sourceTone:'清楚'};
const itemFor=shotId=>({shotId,segments:[],dialogue:[{sourceDialogueId:'D1',startSecond:3,endSecond:7,...Object.fromEntries(['deliveryZh','deliveryEn','vocalArcZh','vocalArcEn','expressionZh','expressionEn','expressionArcEn','bodyZh','bodyEn','blockingZh','blockingEn','speakerFacingZh','speakerFacingEn','listenerReactionZh','listenerReactionEn'].map(k=>[k,'specific performed cue']))}]});

test('Agent error boundary preserves raw structured output and its integrity metadata',async()=>{
 const raw='{"items":[{"shotId":"S01","segments":[],"dialogue":[]}',original=Object.assign(Error('incomplete JSON'),{code:'MODEL_JSON_INVALID',rawText:raw,rawTextLength:raw.length,rawTextSha256:'original-hash',rawTextTruncated:false,noAutomaticRetry:true});
 const agent=new AdaptiveProductionAgent();agent.registerSkill('provider.text',{maxAttempts:1,run:()=>{throw original;}});
 await assert.rejects(agent.runSkill('provider.text',{}),error=>{
  assert.equal(error.rawText,raw);assert.equal(error.rawTextLength,raw.length);assert.equal(error.rawTextSha256,'original-hash');assert.equal(error.rawTextTruncated,false);assert.equal(error.noAutomaticRetry,true);assert.equal(error.cause,original);return true;
 });
});

for(const matchingSource of [true,false])test(`saved numbered-batch JSON recovery requires matching source identity (${matchingSource})`,async()=>{
 let p={id:'saved-raw-recovery',generation:{engine:'hailuo-h3',mode:'asset_direct'},productionPlan:{},script:{},characters:[],scenes:[],assetLibraries:{props:[]},shots:[1,2].map(i=>({id:`S0${i}`,number:i,duration:10,action:'A door opens.',subshots:[],dialogueTurns:[turn]}))};
 const fingerprint=h3AssetDirectSemanticFingerprint(p),sourcePrefix=matchingSource?fingerprint.slice(0,12).toLowerCase():'different-source';
 p.h3AssetDirectSemanticCompile={fingerprint,status:'deferred',batchSize:2};
 p.textProviderDiagnostics={failures:[{operation:'h3_asset_direct_semantics_batch_1',sessionId:`h3-asset-direct-semantics-${p.id}-${sourcePrefix}-b1-test-a1`,code:'MODEL_JSON_INVALID',rawText:'{"items":['+JSON.stringify(itemFor('S01'))}]};
 const store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v)),getSettings:()=>({textProvider:{}})},calls=[];
 const wf=new WorkbenchWorkflow({store,bridge:{}});wf.productionTextOptions=(_p,_s,o)=>o;
 wf.generateText=async(_c,messages)=>{const r=JSON.parse(messages.at(-1).content);calls.push(r.shots.map(s=>s.shotId));return {items:r.shots.map(s=>itemFor(s.shotId))};};
 await wf.compileH3AssetDirectSemanticsBatch(p.id);
 assert.deepEqual(calls,matchingSource?[['S02']]:[['S01','S02']]);assert.equal(p.h3AssetDirectSemanticCompile.compiledCount,2);
});

test('real workflow preserves closed semantic items and resumes only missing shots after truncated transport',async()=>{
 let p={id:'raw-recovery',generation:{engine:'hailuo-h3',mode:'asset_direct'},productionPlan:{},script:{},characters:[],scenes:[],assetLibraries:{props:[]},shots:[1,2,3].map(i=>({id:`S0${i}`,number:i,duration:10,action:'A door opens.',subshots:[],dialogueTurns:[turn]}))};
 const store={getProject:()=>structuredClone(p),saveProject:v=>(p=structuredClone(v)),getSettings:()=>({textProvider:{}})},calls=[];
 const wf=new WorkbenchWorkflow({store,bridge:{},textGenerator:async(_config,messages)=>{
  const request=JSON.parse(messages.at(-1).content);calls.push(request.shots.map(s=>s.shotId));
  const items=request.shots.map(s=>itemFor(s.shotId));
  if(calls.length===1){const rawText='{"items":['+items.slice(0,2).map(JSON.stringify).join(',');throw Object.assign(Error('incomplete JSON'),{code:'MODEL_JSON_INVALID',rawText,rawTextLength:rawText.length});}
  return {items};
 }});
 wf.productionTextOptions=(_p,_s,o)=>o;wf.settleTextGeneration=()=>{};
 await wf.compileH3AssetDirectSemanticsBatch('raw-recovery');
 assert.deepEqual(calls,[['S01','S02','S03'],['S03']]);assert.equal(p.h3AssetDirectSemanticCompile.compiledCount,3);assert.equal(p.h3AssetDirectSemanticCompile.status,'completed');
 await wf.compileH3AssetDirectSemanticsBatch('raw-recovery');
 assert.equal(calls.length,2,'completed shots must never be regenerated on resume');
});
