'use strict';
const {VERSION,TARGET_MS}=require('./preproduction-performance');
// Compatibility code for old saved failures only; new runs never emit it.
const CODE='PREPRODUCTION_TIME_BUDGET_EXCEEDED';
// T07 / §7.5: the soft 20-minute target is a persisted budget view, not a
// stopwatch. Active wall time is the UNION of running request intervals
// (overlaps count once, idle gaps never inflate it); restarts keep the
// accumulated elapsed from the project record, never reset to zero. When the
// target is reached, no NEW whole-script repair round may start automatically
// — already-running tasks finish safely, and the UI offers
// continue/pause explicitly. Slow samples are recorded, never hidden.
const eligible=options=>options.latencyProfile===VERSION&&/^(topics|product_visual_evidence|adaptive_script_|uploaded_script_|h3_asset_direct_semantics|h3_final_editor|prompt_agent_audit|source_editorial_review|source_prop_inventory|asset_visual_design|native_identity|prompt_display|script_adaptation_)/.test(options.costOperation||'');
function unionMs(intervals){
  const sorted=(intervals||[]).filter(i=>i&&i.until>i.since).sort((a,b)=>a.since-b.since);
  let total=0,cursor=null;
  for(const {since,until} of sorted){
    if(!cursor||since>cursor.until){cursor={since,until};total+=until-since;}
    else if(until>cursor.until){total+=until-cursor.until;cursor.until=until;}
  }
  return total;
}
class Budget {
 constructor(store,{now=Date.now,targetMs=TARGET_MS}={}){this.store=store;this.now=now;this.limitMs=0;this.targetMs=Math.max(1,Number(targetMs)||TARGET_MS);this.active=new Map();}
 reset(projectId,reason){if(this.active.has(projectId))return;const p=this.store.getProject(projectId);if(!p)return;const prior=p.preproductionTiming;p.preproductionTiming={version:VERSION,elapsedMs:0,limitMs:0,exceeded:false,reason,startedAt:new Date(this.now()).toISOString(),history:prior?[...(prior.history||[]),{elapsedMs:prior.elapsedMs,exceeded:prior.exceeded,startedAt:prior.startedAt}].slice(-8):[]};this.store.saveProject(p);}
 targetMsFor(){return this.targetMs;}
 // Persisted view: true once the active-time union passed the soft target.
 // Restart-safe: derived from the project record, not from memory.
 isTargetExceeded(projectId){
  const p=this.store.getProject(projectId);if(!p)return false;
  const timing=p.preproductionTiming;if(!timing)return false;
  return timing.exceeded===true||Number(timing.elapsedMs||0)>this.targetMs;
 }
 // A NEW whole-script repair round may not start automatically after the soft
 // target. Explicit user continue (reset with 'manual_continue_after_limit')
 // is the only way past this — no hidden reason can exceed the budget.
 assertCanStartNewWholeScriptRepair(projectId){
  if(this.isTargetExceeded(projectId)){
   throw Object.assign(new Error('已达到 20 分钟文本制作目标；不会自动展开新一轮整稿修复。已完成内容均已保存，可选择显式继续或停止。'),{code:'SOFT_TARGET_NO_NEW_REPAIRS',softTargetExceeded:true});
  }
  return true;
 }
 async run(options,action){
  if(!eligible(options)||!options.costProjectId)return action(options);
  const id=options.costProjectId;let entry=this.active.get(id);
  if(!entry){const p=this.store.getProject(id);if(!p)return action(options);const old=p.preproductionTiming||{};entry={since:this.now(),spent:Number(old.elapsedMs)||0,intervals:[],count:0,stage:options.costOperation,startedAt:old.startedAt||new Date(this.now()).toISOString()};this.active.set(id,entry);}
  entry.count++;
  // Per-request interval: the union of these is the active wall time.
  const interval={since:this.now(),until:this.now()};entry.intervals.push(interval);
  try{return await action(options);}finally{
   interval.until=this.now();
   if(--entry.count===0){
    this.active.delete(id);
    const p=this.store.getProject(id);
    if(p){
     const elapsedMs=entry.spent+unionMs(entry.intervals);
     p.preproductionTiming={...p.preproductionTiming,version:VERSION,startedAt:entry.startedAt,elapsedMs,targetMs:this.targetMs,lastStage:entry.stage,exceeded:elapsedMs>this.targetMs,updatedAt:new Date(this.now()).toISOString()};
     this.store.saveProject(p);
    }
   }
  }
 }
}
module.exports={Budget,CODE,eligible,unionMs};
