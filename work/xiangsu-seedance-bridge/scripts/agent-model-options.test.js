"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const m=require("../app/agent-model-options"),r=require("../app/local-agent-runtime");
const base=path.resolve(__dirname,"../../../.codex_tests/TASK-20260906-AGENT-MODELS-184/tests");
fs.mkdirSync(base,{recursive:true});
test("all five agents persist model/effort/speed without replacing existing selection",()=>{
 for(const id of Object.keys(m.RULES)){const a=r.normalizeSettings({text:id,image:"codex",providers:{[id]:{model:"explicit-model",reasoningEffort:"high",speed:"quality"}}});assert.equal(a.text,id);assert.equal(a.providers[id].model,"explicit-model");assert.equal(a.providers[id].reasoningEffort,"high");assert.equal(a.providers[id].speed,"quality");}
});
test("native argument mapping never fabricates a speed switch or drops effort",()=>{
 for(const id of ["antigravity","workbuddy","grokbuild","codex"]){const args=m.executionArgs(id,{model:"chosen-model",reasoningEffort:"high",serviceTier:""});assert.ok(args.includes("chosen-model"));assert.ok(args.includes(id==="codex"?'model_reasoning_effort="high"':"high"));assert.equal(args.includes("--speed"),false);}
 assert.deepEqual(m.executionArgs("codex",{model:"",reasoningEffort:"",serviceTier:"priority"}),["-c",'service_tier="priority"']);
});
test("Antigravity resolves supported effort variant and rejects absent Pro medium",()=>{
 assert.equal(m.resolveExecution({id:"antigravity",model:"gemini-3.8-flash-high",reasoningEffort:"low"}).model,"gemini-3.8-flash-low");
 assert.throws(()=>m.resolveExecution({id:"antigravity",model:"gemini-3.1-pro-high",reasoningEffort:"medium"}),{code:"LOCAL_AGENT_EFFORT_UNSUPPORTED"});
 assert.throws(()=>m.resolveExecution({id:"workbuddy",speed:"priority"}),{code:"LOCAL_AGENT_SPEED_UNSUPPORTED"});
});
test("speed presets honestly map to reasoning and do not enable charged priority",()=>{
 assert.equal(m.resolveExecution({id:"grokbuild",model:"grok-4.6",speed:"fast"}).reasoningEffort,"low");
 const e=m.resolveExecution({id:"grokbuild",model:"grok-4.6",speed:"quality"});assert.equal(e.reasoningEffort,"xhigh");assert.equal(e.serviceTier,"");
});
test("local model readers strip credentials, accept custom models and model-specific efforts",()=>{
 const home=fs.mkdtempSync(path.join(base,"catalog-"));fs.mkdirSync(path.join(home,".workbuddy"));
 fs.writeFileSync(path.join(home,".workbuddy/models.json"),JSON.stringify([{id:"custom-a",name:"A",apiKey:"DO_NOT_EXPOSE",baseURL:"https://private.invalid",reasoning:{supportedEfforts:["low","high"]}}]));
 const rows=m.localModels("workbuddy",{USERPROFILE:home});assert.deepEqual(rows,[{id:"custom-a",label:"A",efforts:["low","high"],tiers:[]}]);assert.doesNotMatch(JSON.stringify(rows),/DO_NOT_EXPOSE|private/);
});
test("CLI model lists parse only model rows and de-duplicate",()=>{
 assert.equal(m.parseCliModels("antigravity","Fetching...\ngemini-3.8-flash-low\tGemini\n").length,1);
 assert.deepEqual(m.parseCliModels("grokbuild","Not authenticated\nDefault model: grok-4.6\n * grok-4.6 (default)\n - grok-4.5").map(m=>m.id),["grok-4.6","grok-4.5"]);
});
test("WorkBuddy builtin model never inherits a same-ID custom model effort restriction",()=>{
 const home=fs.mkdtempSync(path.join(base,"namespace-"));fs.mkdirSync(path.join(home,".workbuddy"));
 fs.writeFileSync(path.join(home,".workbuddy/models.json"),JSON.stringify([{id:"glm-5.3-flash",reasoning:{supportedEfforts:[]}},{id:"ds-custom",reasoning:{supportedEfforts:["high"]}}]));
 const env={USERPROFILE:home};
 assert.equal(m.resolveExecution({id:"workbuddy",model:"glm-5.3-flash",reasoningEffort:"medium"},env).reasoningEffort,"medium");
 assert.throws(()=>m.resolveExecution({id:"workbuddy",model:"custom-local:glm-5.3-flash",reasoningEffort:"medium"},env),{code:"LOCAL_AGENT_EFFORT_UNSUPPORTED"});
 assert.equal(m.resolveExecution({id:"workbuddy",model:"custom-local:ds-custom",reasoningEffort:"high"},env).model,"custom-local:ds-custom");
});
test('WorkBuddy help lists built-in and namespaced custom IDs without reading log claims as models',()=>{
 const help='log: fake-model\n  --model <model> Model. Currently supported: (auto, glm-5.1,\n custom-local:glm-5.1, custom-local:Kimi-K3, auto)\n  --effort <level> high';
 const rows=m.parseCliModels('workbuddy',help);
 assert.deepEqual(rows.map(x=>x.id),['auto','glm-5.1','custom-local:glm-5.1','custom-local:Kimi-K3']);
 assert.equal(rows[1].label,'glm-5.1');assert.deepEqual(m.parseCliModels('workbuddy','not authenticated'),[]);
 assert.deepEqual(m.parseCliModels('workbuddy','--other <model> Currently supported: (fake)'),[]);
});
test("visible streaming filters reasoning/tool data and keeps final result separate",()=>{
 assert.equal(r.visibleDelta({event:"step_update",step_update:{step_type:"agent_response",text_delta:"hello"}}),"hello");
 assert.equal(r.visibleDelta({event:"step_update",step_update:{step_type:"thinking",text_delta:"hidden"}}),"");
 assert.equal(r.visibleDelta({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"chunk"}}}),"chunk");
 assert.equal(r.finalEvent({event:"result",result:{status:"SUCCESS",response:"complete"}}),"complete");
});
test("topic stage excludes shot contracts while later stages retain them",()=>{
 const w=require("../app/workbench-workflow");const topic=w.topicIdeationRuntimePrompt({},{});
 assert.doesNotMatch(topic,/screenSide|0\.30秒|3秒动作|10–15秒/);assert.match(topic,/highlights/);
 assert.match(w.h3TextStageDirective("units"),/screenSide/);
});
test("Codex/API confirmation follows saved bound route and no obsolete API-only confirmation",()=>{
 const s=fs.readFileSync(path.join(__dirname,"../app/renderer/workbench.js"),"utf8");
 const fn=s.slice(s.indexOf("function configuredImageSourceName"),s.indexOf("\nconst state ="));
 const ctx={};vm.createContext(ctx);vm.runInContext(fn,ctx);
 assert.match(ctx.configuredImageSourceName({localAgents:{image:"codex"}}),/^Codex/);
 assert.match(ctx.configuredImageSourceName({localAgents:{image:"api"}}),/^已配置的图片 API$/);
 assert.match(ctx.configuredImageSourceName({localAgents:{image:"api"},imageProvider:{localAgent:{id:"antigravity"}}}),/^Antigravity/);
 assert.doesNotMatch(s,/然后调用图片 API|const providers = \["图片 API"\]|文本模型、图片 API/);
});
