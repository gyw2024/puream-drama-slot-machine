'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),audit=require('../app/prompt-chronology-audit');
for(const mode of ['asset_direct','keyframe','storyboard_sheet'])test(`${mode}: full-sequence clock review sees neighboring lighting, routes Agent findings, and reuses unchanged evidence`,async()=>{
 const source={acceptedShotScreenplay:true,storyContext:{synopsis:'当晚冲茶，次日才开摊。'},shots:[{id:'S01',sceneId:'SC01',action:'取茶罐',stateBefore:'夜间桌旁',stateAfter:'手持茶罐',masterAgentDecision:{environmentEn:'At night.',environmentZh:'夜间',soundscapeEn:'Quiet street.'}},{id:'S02',sceneId:'SC01',action:'接着冲茶',stateBefore:'持罐站着',stateAfter:'端茶',masterAgentDecision:{environmentEn:'Morning daylight.',environmentZh:'清晨天光',soundscapeEn:'Quiet street.'}}]};
 const items=source.shots.map(s=>({id:`shot:${s.id}:shot_video`,entityType:'shot',entityId:s.id,stage:'shot_video',mode,agentAudit:{issues:[]}}));let calls=0;
 const generate=async messages=>{const p=JSON.parse(messages[1].content);if(p.findings)return {decisions:p.findings.map(f=>({id:f.id,verdict:'upheld',reason:'Actual source night conflicts with explicitly authored morning.'}))};calls++;assert.equal(p.shots.length,2);assert.equal(p.storySynopsis,source.storyContext.synopsis);return {shots:[{shotId:'S01',sourcePhase:'night',proposedPhase:'night',issues:[]},{shotId:'S02',sourcePhase:'same night',proposedPhase:'morning',issues:[{sourceEvidence:'当晚冲茶',promptEvidence:'Morning daylight.',contradiction:'Continuous night action turned into daylight.',repair:'Change only the environment light to the same established night.'}]}]};};
 const before=JSON.stringify(source),checkpoint=await audit.review({source,items,execution:{model:'current'},generate});assert.equal(calls,1);assert.match(items[1].agentAudit.issues[0],/Continuous night/);assert.equal(items[0].agentAudit.issues.length,0);assert.equal(JSON.stringify(source),before);
 await audit.review({source,items:structuredClone(items).map(i=>({...i,agentAudit:{issues:[]}})),checkpoint,execution:{model:'current'},generate});assert.equal(calls,1);
 source.shots[1].masterAgentDecision.environmentEn='Corrected night.';await audit.review({source,items,checkpoint,execution:{model:'current'},generate});assert.equal(calls,2);
});
test('missing or nonaccepted screenplay does not start an extra chronology review',async()=>{assert.equal(await audit.review({source:{acceptedShotScreenplay:false},items:[],generate:()=>assert.fail()}),null);});
test('incomplete Agent chronology rows return for correction instead of stopping the project',async()=>{
 const source={acceptedShotScreenplay:true,shots:['S01','S02'].map(id=>({id,masterAgentDecision:{environmentEn:'Night'}}))},items=source.shots.map(s=>({entityType:'shot',entityId:s.id,stage:'shot_video'}));let calls=0;
 const result=await audit.review({source,items,generate:async messages=>{if(calls++===0)return {shots:[]};assert.match(messages[1].content,/deliveryFeedback/);return {shots:source.shots.map(s=>({shotId:s.id,sourcePhase:'night',proposedPhase:'night',issues:[]}))};}});
 assert.equal(calls,2);assert.equal(result.shots.length,2);
});
