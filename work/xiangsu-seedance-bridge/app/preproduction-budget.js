'use strict';
const {VERSION}=require('./preproduction-performance');
// Compatibility code for old saved failures only; new runs never emit it.
const CODE='PREPRODUCTION_TIME_BUDGET_EXCEEDED';
const eligible=options=>options.latencyProfile===VERSION&&/^(topics|product_visual_evidence|adaptive_script_|uploaded_script_|h3_asset_direct_semantics|h3_final_editor|prompt_agent_audit|source_editorial_review|source_prop_inventory|asset_visual_design|native_identity|prompt_display|script_adaptation_)/.test(options.costOperation||'');
// Tracks active elapsed time only; overlapping requests count once.
class Budget {
 constructor(store,{now=Date.now}={}){this.store=store;this.now=now;this.limitMs=0;this.active=new Map();}
 reset(projectId,reason){if(this.active.has(projectId))return;const p=this.store.getProject(projectId);if(!p)return;const prior=p.preproductionTiming;p.preproductionTiming={version:VERSION,elapsedMs:0,limitMs:0,exceeded:false,reason,startedAt:new Date(this.now()).toISOString(),history:prior?[...(prior.history||[]),{elapsedMs:prior.elapsedMs,exceeded:prior.exceeded,startedAt:prior.startedAt}].slice(-8):[]};this.store.saveProject(p);}
 async run(options,action){
  if(!eligible(options)||!options.costProjectId)return action(options);
  const id=options.costProjectId;let entry=this.active.get(id);
  if(!entry){const p=this.store.getProject(id);if(!p)return action(options);const old=p.preproductionTiming||{};entry={since:this.now(),spent:Number(old.elapsedMs)||0,count:0,stage:options.costOperation,startedAt:old.startedAt||new Date(this.now()).toISOString()};this.active.set(id,entry);}
  entry.count++;
  try{return await action(options);}finally{if(--entry.count===0){this.active.delete(id);const p=this.store.getProject(id);if(p){p.preproductionTiming={...p.preproductionTiming,version:VERSION,startedAt:entry.startedAt,elapsedMs:entry.spent+Math.max(0,this.now()-entry.since),limitMs:0,exceeded:false,lastStage:entry.stage,updatedAt:new Date(this.now()).toISOString()};this.store.saveProject(p);}}}
 }
}
module.exports={Budget,CODE,eligible};