'use strict';

const VERSION='preproduction-15m-v1';
const TARGET_MS=15*60_000;
const CONCURRENCY=4;
function isPreparation(options={}) {
  return options.latencyProfile===VERSION && !/post[_ .-]|sfx|actual_media/i.test(String(options.costOperation||options.stage||''));
}
function executionConfig(config,options={}) {
  if(!config?.localAgent||!isPreparation(options))return config;
  const agent={...config.localAgent};
  // Keep the chosen application/model and every explicit effort/speed choice.
  // An empty override follows the selected agent's default. Never silently
  // reduce reasoning effort to meet a wall-clock target.
  return {...config,localAgent:{...agent,latencyProfile:VERSION}};
}
async function mapBatches(items,limit,worker,{signal}={}) {
  const results=new Array(items.length);let next=0,failure;
  const run=async()=>{
    while(!failure&&!signal?.aborted){
      const index=next++;if(index>=items.length)return;
      try{results[index]=await worker(items[index],index);}catch(error){failure ||= error;}
    }
  };
  await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,limit))},run));
  if(signal?.aborted)throw Object.assign(Error('已暂停，已完成内容保留。'),{code:'PROVIDER_REQUEST_ABORTED'});
  if(failure)throw failure;
  return results;
}
function progress(project,stage,text) {
  const preparation=project?.script?.sourcePreparation;
  if(stage==='uploaded_script_prepare_whole')return `整稿一次拆镜 · ${text}`;
  if(stage==='uploaded_script_source_understanding')return `理解原稿与对白归属 · ${text}`;
  if(stage==='uploaded_script_source_understanding_reconcile')return `核对未归类的原文 · ${text}`;
  if(stage==='uploaded_script_source_audit_recovery')return `复核原稿因果与连续性 · ${text}`;
  const match=String(stage||'').match(/^uploaded_script_prepare_part_(\d+)$/);
  if(match&&preparation?.plan?.length)return `拆镜 ${Math.min((preparation.parts?.filter(Boolean).length||0)+Object.keys(preparation.parallelParts||{}).length,preparation.plan.length)}/${preparation.plan.length} 批已完成 · ${text}`;
  const semantics=project?.h3AssetDirectSemanticCompile;
  if(/^h3_asset_direct_semantics_batch_/.test(stage)&&semantics?.total)return `分镜动作与对白 ${semantics.compiledCount||0}/${semantics.total} 镜已完成 · ${text}`;
  const labels={topics:'选题',h3_final_editor:'分镜提示词',film_continuity_director:'全片连续性规划',prompt_agent_audit:'提示词审核',source_editorial_review:'带货与场景审核',asset_visual_design:'资产形象设计'};
  return labels[stage]?`${labels[stage]} · ${text}`:text;
}
module.exports={VERSION,TARGET_MS,CONCURRENCY,isPreparation,executionConfig,mapBatches,progress};
