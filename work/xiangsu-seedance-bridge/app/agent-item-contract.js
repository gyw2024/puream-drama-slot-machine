'use strict';
// Provider-independent delivery reconciliation. Accepted rows are immutable;
// a response with one bad row must not discard the other paid results.
async function complete({items,cached,generate,valid,save,maxCalls=Infinity,signal}){
 const stalled=new Map(Object.entries(cached?.stalled||{}));
 const accepted=new Map(),allowed=new Set(items.map(i=>i.id)),rejected=[];
 const ingest=result=>{
  const rows=Array.isArray(result?.items)?result.items:[];
  for(const id of allowed){if(accepted.has(id))continue;const matches=[...new Map(rows.filter(r=>r?.id===id).map(r=>[JSON.stringify(r),r])).values()];if(matches.length!==1){rejected.push({id,reason:matches.length?'conflicting duplicate result ID':'missing requested item'});continue;}
   const row=structuredClone(matches[0]);try{if(valid(row))accepted.set(id,row);else rejected.push({id,reason:'incomplete or invalid fields',row});}catch(error){rejected.push({id,reason:error.message,issues:error.issues||error.failures,row});}
  }
 };
 ingest(cached);
 // Revalidate the saved final response under the current contract before paying
 // for another call; never use partial streams or fabricate missing rows.
 if(cached?.rawLastResponse)ingest(cached.rawLastResponse);
 for(let call=0;call<maxCalls&&accepted.size<items.length;call++){
    await new Promise(setImmediate);
  const pending=items.filter(i=>!accepted.has(i.id));
  // After a batch repair, isolate each unresolved item. Keep the complete
  // source in the caller's prompt; shrink only the requested output scope.
  for(const scope of call<2?[pending]:pending.map(i=>[i])){
   require('./agent-stage-tasks').throwIfCancelled(signal);
   const scopeKey=scope.map(i=>i.id).join('|'),prior=stalled.get(scopeKey),beforeCount=accepted.size;
   if(prior?.repeats>=2)throw require('./audit-progress').pending('item-delivery',{itemIds:scope.map(i=>i.id),reason:'unchanged invalid receipt after targeted and isolated diagnosis'});
   const response=await generate(scope,{strategy:call<1?'initial':call<2?'targeted_patch':'isolated_source_reconciliation',attempt:call+1,instruction:call<2?'Keep accepted rows unchanged.':'Re-read the original source for this ONE unresolved item. Explain the previous conflict internally, then rebuild this item only. Do not repeat a failed mechanical patch; preserve source facts and neighbors.',invalid:rejected.filter(r=>scope.some(p=>p.id===r.id)).slice(-scope.length*2),acceptedIds:[...accepted.keys()]});
   require('./agent-stage-tasks').throwIfCancelled(signal);ingest(response);
   if(rejected.length>Math.max(16,items.length*4))rejected.splice(0,rejected.length-Math.max(16,items.length*4));
   const responseKey=require('./foundry/canonical').fingerprint(response);
   if(accepted.size===beforeCount)stalled.set(scopeKey,{responseKey,repeats:prior?.responseKey===responseKey?(prior.repeats||0)+1:0});else stalled.delete(scopeKey);
   save?.({stalled:Object.fromEntries(stalled),items:[...accepted.values()],rejected:structuredClone(rejected),rawLastResponse:response,attempt:call+1,strategy:call<2?'targeted_patch':'isolated_source_reconciliation'});
  }
 }
 return {items:items.flatMap(i=>accepted.has(i.id)?[accepted.get(i.id)]:[]),missingIds:items.filter(i=>!accepted.has(i.id)).map(i=>i.id)};
}
module.exports={complete};
