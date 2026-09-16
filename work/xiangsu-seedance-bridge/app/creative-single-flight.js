'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const context=new AsyncLocalStorage(),owners=new WeakMap();
const operations=new Set(['topic_ideation','idea_script','idea_to_full_pipeline','pipeline_from_stage','script_adaptation','dialogue_rewrite','analyze_script','prepare_prompt_review','repair_script_contract']);
function run(owner,projectId,operation,action){
 if(!operations.has(operation))return action();
 if(context.getStore()?.owner===owner&&context.getStore()?.projectId===projectId)return action();
 let flights=owners.get(owner);if(!flights){flights=new Map();owners.set(owner,flights);}
 if(flights.has(projectId))return flights.get(projectId);
 const promise=Promise.resolve().then(()=>context.run({owner,projectId},action));
 flights.set(projectId,promise);
 const clear=()=>{if(flights.get(projectId)===promise)flights.delete(projectId);};
 promise.then(clear,clear);return promise;
}
module.exports={run};
