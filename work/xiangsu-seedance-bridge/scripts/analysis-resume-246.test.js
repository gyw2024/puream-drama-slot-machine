'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {WorkbenchWorkflow,ensureGeneratedDialogueLedger}=require('../app/workbench-workflow');
function fixture(inputMode){
 const raw='父亲（对儿子）：今天留下吃饭吧。';
 const entities=ensureGeneratedDialogueLedger({characters:[{id:'C01',name:'父亲'},{id:'C02',name:'儿子'}],scenes:[{id:'SC01',name:'客厅',visualDesign:{descriptionEn:'The approved room.'}}],shots:[{id:'S01',number:1,sceneId:'SC01',duration:10,characterIds:['C01','C02'],dialogueTurns:[{sourceDialogueId:'D001',speakerId:'C01',listenerIds:['C02'],text:'今天留下吃饭吧。'}],agentProductionDecision:{status:'authored',item:{summaryEn:'The retained paid decision.'}}}]});
 return {id:'resume-test',...entities,script:{raw,sourceFingerprint:crypto.createHash('sha256').update(raw).digest('hex'),analyzedAt:'2026-09-11T00:00:00Z',analysis:{accepted:true},analysisCheckpoint:null,sourceDialogueLedger:entities.sourceDialogueLedger,adaptiveAuthoring:{status:'ready'},ideaSignature:'adaptive-original'},productionPlan:{inputMode},generation:{engine:'hailuo-h3',mode:'asset_direct'},promptReview:{status:'pending',items:[{id:'retained'}]}};
}
for(const mode of ['ai','manual'])test(`unchanged completed ${mode} analysis preserves designs and decisions without writes`,async()=>{
 const p=fixture(mode),before=structuredClone(p);let writes=0;
 const wf=new WorkbenchWorkflow({store:{getProject:()=>p,getSettings:()=>({}),patchProject:()=>{writes++;throw Error('unnecessary reparse');},saveProject:()=>{writes++;throw Error('unnecessary reparse');}},bridge:{},textGenerator:async()=>{throw Error('unnecessary paid request');}});
 const result=await wf.analyzeScript(p.id,{track:false});assert.deepEqual(result,before);assert.equal(writes,0);
});
test('changed source and incomplete analysis cannot use the completed-receipt shortcut',async()=>{
 for(const change of [p=>p.script.raw+='新台词。',p=>p.script.analysisCheckpoint={status:'running'}]){
  const p=fixture('ai');change(p);let reached=false;
  const wf=new WorkbenchWorkflow({store:{getProject:()=>p,getSettings:()=>{reached=true;return {};},saveProject:()=>{throw Object.assign(Error('normal analysis path'),{code:'NORMAL_ANALYSIS'});}},bridge:{},textGenerator:async()=>{throw Error('normal analysis path');}});
  await assert.rejects(wf.analyzeScript(p.id,{track:false}));assert.equal(reached,true);
 }
});
