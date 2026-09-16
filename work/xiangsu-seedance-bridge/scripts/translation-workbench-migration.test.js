'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
function fixture(){
 const wf=Object.create(WorkbenchWorkflow.prototype),settings={textProvider:{kind:'local-agent',localAgent:{id:'codex',model:'selected',reasoningEffort:'high',rootDir:'D:/staging'}}};
 let project={id:'new-project',productionPlan:{}},calls=0;
 wf.store={getSettings:()=>settings,getProject:()=>structuredClone(project),saveProject:p=>{project=structuredClone(p);}};wf.operationControls=new Map();
 wf.generateText=async(_c,m)=>{calls++;return {items:JSON.parse(m.at(-1).content).items.map(x=>({id:x.id,translation:'完整译文 '+x.text}))};};
 const item=()=>({id:'character:C01:character_intro',prompt:'One adult, eyes open, hands empty.',executionLanguage:'en'});
 async function translate(){const items=[item()];project.promptTranslationCache=await wf.translatePromptReviewItemsForDisplay(project.id,items);return items[0];}
 return {wf,settings,item,translate,get project(){return project},get calls(){return calls}};
}
test('same Agent and exact text retain translation across workbench relocation; model/effort edits do not',async()=>{
 const f=fixture();await f.translate();assert.equal(f.calls,1);
 f.settings.textProvider.localAgent.rootDir='D:/production';const reused=await f.translate();assert.equal(f.calls,1);assert.equal(reused.translationReused,true);
 f.settings.textProvider.localAgent.model='different';await f.translate();assert.equal(f.calls,2);
 f.settings.textProvider.localAgent.reasoningEffort='low';await f.translate();assert.equal(f.calls,3);
});
test('a verifiable legacy translation upgrades in place without retranslation or relaxing its old hash',async()=>{
 const f=fixture(),i=f.item(),fingerprint=crypto.createHash('sha256').update(JSON.stringify({version:1,id:i.id,prompt:i.prompt,execution:f.settings.textProvider.localAgent})).digest('hex');
 f.project.promptTranslationCache={[i.id]:{fingerprint,translation:'原有完整译文'}};
 assert.equal((await f.translate()).displayPrompt,'原有完整译文');assert.equal(f.calls,0);assert.equal(f.project.promptTranslationCache[i.id].cacheVersion,2);
 f.settings.textProvider.localAgent.rootDir='D:/production';assert.equal((await f.translate()).displayPrompt,'原有完整译文');assert.equal(f.calls,0);
});
test('an unprovable legacy cache from an unknown old workbench is not trusted',async()=>{
 const f=fixture();f.project.promptTranslationCache={[f.item().id]:{fingerprint:'unknown',translation:'不可核验旧译文'}};
 await f.translate();assert.equal(f.calls,1);
});
