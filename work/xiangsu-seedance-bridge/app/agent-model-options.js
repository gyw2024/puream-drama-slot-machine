"use strict";
// Official CLI/SDK and local model catalogs checked 2026-09-06. No credentials.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const EFFORTS=["off","none","minimal","low","medium","high","xhigh","max","ultra"];
const RULES={
 workbuddy:{efforts:["minimal","low","medium","high","xhigh","max"],source:"WorkBuddy 本机模型目录及 CLI --effort"},
 antigravity:{efforts:["low","medium","high"],source:"Antigravity 官方 agy models / --effort"},
 codex:{efforts:["low","medium","high","xhigh","max","ultra"],source:"Codex 本机模型目录 / model_reasoning_effort"},
 "deepseek-harness":{efforts:["off","low","high","max"],source:"官方 DeepSeek Harness SDK reasoning_effort"},
 grokbuild:{efforts:["low","medium","high","xhigh"],source:"Grok Build models / --reasoning-effort"}
};
const row=(id,label=id,efforts=[],tiers=[])=>({id,label,efforts,tiers});
function readJson(file){try{if(fs.statSync(file).size>3*1024*1024)return null;return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
function localModels(id,env=process.env){
 const homeDir=env.USERPROFILE||os.homedir();
 if(id==="workbuddy") {const data=readJson(path.join(homeDir,".workbuddy/models.json"));return (Array.isArray(data)?data:[]).filter(m=>typeof m.id==="string").map(m=>row(m.id,String(m.name||m.id),m.reasoning?.supportedEfforts?.filter(e=>EFFORTS.includes(e))||[]));}
 if(id==="codex") {const data=readJson(path.join(env.CODEX_HOME||path.join(homeDir,".codex"),"models_cache.json"));return (data?.models||[]).filter(m=>m.visibility!=="hide"&&typeof m.slug==="string").map(m=>row(m.slug,m.display_name||m.slug,(m.supported_reasoning_levels||[]).map(e=>e.effort).filter(e=>EFFORTS.includes(e)),(m.service_tiers||[]).map(t=>t.id).filter(t=>["priority","fast"].includes(t))));}
 if(id==="antigravity")return ["3.8","3.7","3.6"].flatMap(v=>["low","medium","high"].map(e=>row(`gemini-${v}-flash-${e}`,`Gemini ${v} Flash (${e})`,["low","medium","high"]))).concat(["low","high"].map(e=>row(`gemini-3.1-pro-${e}`,`Gemini 3.1 Pro (${e})`,["low","high"])),[row("claude-sonnet-4-6","Claude Sonnet 4.6",["low","medium","high"]),row("claude-opus-4-6-thinking","Claude Opus 4.6 Thinking",["low","medium","high"]),row("gpt-oss-120b-medium","GPT-OSS 120B",["medium"])]);
 if(id==="grokbuild")return ["grok-4.6","grok-4.5"].map(m=>row(m,m,RULES[id].efforts));
 if(id==="deepseek-harness")return ["deepseek-v4-flash","deepseek-v4-pro"].map(m=>row(m,m,RULES[id].efforts));
 return [];
}
function capabilities(id,models=localModels(id)){return {models,efforts:RULES[id]?.efforts||[],source:"预置或本机缓存，等待自动同步",checkedAt:null,refreshable:true,note:"目录不等于账号有额度。优先响应/深度优先通过思考强度实现，不保证固定秒数；只有 Codex 官方 Fast 是独立服务档位，可能增加消耗。"};}
function parseCliModels(id,output){
 if(id==='workbuddy'){
  const text=String(output).replace(/\x1b\[[0-9;]*m/g,''),section=text.match(/--model\s+<model>[\s\S]*?(?=\n\s*--[\w-]+|$)/)?.[0]||'';
  const list=section.match(/Currently supported:\s*\(([^)]+)\)/)?.[1];
  if(!list)return [];
  const local=localModels(id);
  return [...new Set(list.split(',').map(s=>s.trim()).filter(s=>/^[\w][\w.:-]*$/.test(s)))].map(model=>{
   const custom=local.find(m=>model===`custom-local:${m.id}`);
   return row(model,custom?`${custom.label}（自定义）`:model,custom?custom.efforts:RULES.workbuddy.efforts);
  });
 }
 const rows=[];for(const line of String(output).replace(/\x1b\[[0-9;]*m/g,"").split(/\r?\n/)){
  const m=id==="antigravity"?line.match(/^([\w][\w.:-]+)\t+(.+)$/):line.match(/^\s*[*-]\s+([\w][\w.:-]+)(?:\s|$)/);
  if(m)rows.push(row(m[1],id==="antigravity"?m[2]:m[1],localModels(id).find(r=>r.id===m[1])?.efforts||RULES[id].efforts));
 }return [...new Map(rows.map(r=>[r.id,r])).values()];
}
function resolveExecution(config,env=process.env){
 const id=config.id;let model=String(config.model||"").trim(),effort=String(config.reasoningEffort||""),speed=String(config.speed||"standard");
 // WorkBuddy's bare IDs select its builtin catalog. Local custom definitions
 // have their own namespace, even when both providers use the same model ID.
 const selected=localModels(id,env).find(m=>id==='workbuddy'?model===`custom-local:${m.id}`:m.id===model),allowed=selected?selected.efforts:RULES[id]?.efforts||[];
 if(speed==="fast")effort=allowed.find(e=>!["ultra","max"].includes(e))||"";
 if(speed==="quality")effort=allowed.filter(e=>e!=="ultra").at(-1)||"";
 if(effort&&!allowed.includes(effort))throw Object.assign(new Error("所选模型不支持该思考强度，请在 Agent 设置中调整；未提交生成，也未切换 API。"),{code:"LOCAL_AGENT_EFFORT_UNSUPPORTED"});
 if(!["standard","fast","quality","priority"].includes(speed))speed="standard";
 if(speed==="priority"&&(id!=="codex"||!selected?.tiers.some(t=>["priority","fast"].includes(t))))throw Object.assign(new Error("该模型没有声明官方 Fast 服务档位，请选择标准速度或刷新模型列表；未提交生成。"),{code:"LOCAL_AGENT_SPEED_UNSUPPORTED"});
 if(id==="antigravity"&&effort&&/-(low|medium|high)$/.test(model)){const variant=model.replace(/-(low|medium|high)$/,`-${effort}`);if(localModels(id).some(m=>m.id===variant))model=variant;}
 return {model,reasoningEffort:effort,speed,serviceTier:speed==="priority"?"priority":"",source:config.transport==="mcp"?"worker-request":"cli-override",defaultModel:!model};
}
function executionArgs(id,e){const args=[];if(e.model)args.push(id==="codex"?"-m":"--model",e.model);if(e.reasoningEffort){if(id==="codex")args.push("-c",`model_reasoning_effort=${JSON.stringify(e.reasoningEffort)}`);else if(id!=="deepseek-harness")args.push(id==="grokbuild"?"--reasoning-effort":"--effort",e.reasoningEffort);}if(e.serviceTier)args.push("-c",`service_tier=${JSON.stringify(e.serviceTier)}`);return args;}
module.exports={RULES,EFFORTS,localModels,capabilities,parseCliModels,resolveExecution,executionArgs};
