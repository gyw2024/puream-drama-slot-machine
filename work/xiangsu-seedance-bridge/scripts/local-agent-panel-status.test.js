"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../app/renderer/local-agent-panel.js"), "utf8");
const ids = ["workbuddy", "antigravity", "codex", "deepseek-harness", "grokbuild"];
const discovered = () => ids.map(id => ({id, executable:"fixture-only", image:id === "antigravity" ? "native" : "worker", help:"测试入口", workerConnected:false, imageWorkerConnected:false}));
const settings = (text="codex", image="api", transport="cli") => ({localAgents:{text,image,providers:{[text]:{transport}}}});
const defer = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const flush = async () => { for(let i=0;i<64;i++)await Promise.resolve(); };

function fixture(config=settings(), scope="workbench") {
  const nodes = new Map(), timers = new Map(), calls = [],events={}; let root, timerId=0, invoke;
  function node(key) {
    if (nodes.has(key)) return nodes.get(key);
    const n = {value:"", dataset:{}, textContent:"", disabled:false, placeholder:"", listeners:{},
      setAttribute(){}, prepend(){}, getClientRects:()=>[{}], matches:()=>true,
      querySelector:s=>node(`${key} ${s}`), querySelectorAll:()=>ids.map(id=>node(`root [data-probe="${id}"]`)),
      addEventListener(type, fn){this.listeners[type]=fn;}};
    nodes.set(key,n);return n;
  }
  invoke = async method => method === "discover" ? {ok:true,agents:discovered(),jobs:[]} : {ok:true,status:"detected_not_authenticated"};
  const ctx = {location:{pathname:`/${scope}.html`}, Date, console, setInterval:()=>1, clearInterval(){},
    setTimeout(fn){timers.set(++timerId,fn);return timerId;}, clearTimeout:id=>timers.delete(id),
    document:{querySelector:()=>({prepend(){}}), createElement:tag=>tag === "section" ? (root=node("root")) : node(tag)},
    window:{addEventListener(name,fn){events[name]=fn;}, dramaSlot:{localAgents:{call:async(method,workspace,...args)=>{calls.push({method,workspace,args});return invoke(method,...args);}}}}};
  vm.runInNewContext(source,ctx);
  ctx.window.LocalAgentPanel.render(config);
  return {panel:ctx.window.LocalAgentPanel,calls,timers,
    q:s=>root.querySelector(s), indicator:()=>root.querySelector("#localAgentConnection").dataset.state,
    label:()=>root.querySelector("#localAgentConnection").querySelector("[data-connection-label]").textContent,
    detail:()=>root.querySelector("#localAgentStatus").textContent,
    invoke:fn=>{invoke=fn;}, async ready(){await flush();calls.length=0;},
    focus:()=>events.focus?.(),
    models(id='workbuddy'){const button=root.querySelector(`[data-models="${id}"]`);button.dataset.models=id;button.closest=()=>button;return root.listeners.click({target:button});},
    edit(selector,value){const target=root.querySelector(selector);target.value=value;root.listeners.input({target});},
    click(id){const button=root.querySelector(id === "refreshLocalAgents" ? "#refreshLocalAgents" : `[data-probe="${id}"]`);button.id=id;if(id!=="refreshLocalAgents")button.dataset.probe=id;button.closest=()=>button;return root.listeners.click({target:button});},
    timeout(){[...timers.values()].forEach(fn=>fn());}};
}

test("selected CLI check lights immediately, ignores duplicate clicks and releases controls",async()=>{
  const app=fixture();await app.ready();const pending=defer();
  app.invoke(async method=>method==="discover"?{ok:true,agents:discovered()}:pending.promise);
  const first=app.click("refreshLocalAgents");const second=app.click("refreshLocalAgents");
  assert.equal(app.indicator(),"checking");assert.equal(app.label(),"检测中");assert.equal(app.q("#refreshLocalAgents").disabled,true);
  await flush();assert.equal(app.calls.filter(c=>c.method==="probe").length,1);
  pending.resolve({ok:true,status:"detected_not_authenticated"});await Promise.all([first,second]);
  assert.equal(app.indicator(),"success");assert.match(app.detail(),/授权.*未实测/);assert.equal(app.q("#refreshLocalAgents").disabled,false);
});
test("MCP config without a live worker is red despite successful discovery RPC",async()=>{
  const app=fixture(settings("codex","api","mcp"));await app.ready();await app.panel.refresh();
  assert.equal(app.indicator(),"failure");assert.match(app.detail(),/写作工作端未连接/);assert.equal(app.calls.some(c=>c.method==="probe"),false);
});
test("MCP live text worker is green without a generation request",async()=>{
  const app=fixture(settings("codex","api","mcp"));await app.ready();app.invoke(async()=>({ok:true,agents:discovered().map(a=>({...a,workerConnected:true}))}));
  await app.panel.refresh();assert.equal(app.indicator(),"success");assert.match(app.detail(),/MCP 工作端在线/);assert.deepEqual(app.calls.map(c=>c.method),["discover"]);
});
test("text connectivity cannot masquerade as image-worker connectivity",async()=>{
  const app=fixture(settings("codex","codex"));await app.ready();await app.panel.refresh();
  assert.equal(app.indicator(),"failure");assert.match(app.detail(),/生图工作端未连接/);
});
test("image-only MCP worker does not incorrectly require a text worker",async()=>{
  const app=fixture(settings("api","codex"));await app.ready();app.invoke(async()=>({ok:true,agents:discovered().map(a=>({...a,imageWorkerConnected:true}))}));
  await app.panel.refresh();assert.equal(app.indicator(),"success");assert.match(app.detail(),/生图工作端在线/);
});
test("native image CLI verifies entry, with capability disclaimer",async()=>{
  const app=fixture(settings("api","antigravity"));await app.ready();await app.panel.refresh();
  assert.equal(app.indicator(),"success");assert.equal(app.calls.filter(c=>c.method==="probe").length,1);assert.match(app.detail(),/实际生成能力未实测/);
});

test("Codex native image selection checks CLI without requiring an MCP worker",async()=>{
  const app=fixture(settings("codex","codex"));await app.ready();
  app.invoke(async method=>method === "discover" ? {ok:true,agents:discovered().map(a=>a.id === "codex" ? {...a,image:"native"} : a)} : {ok:true,status:"detected_not_authenticated"});
  await app.panel.refresh();assert.equal(app.indicator(),"success");assert.equal(app.calls.filter(c=>c.method==="probe").length,1);assert.doesNotMatch(app.detail(),/生图工作端未连接/);
});
test("mixed providers report partial failure and preserve per-agent result",async()=>{
  const app=fixture(settings("codex","workbuddy"));await app.ready();await app.panel.refresh();
  assert.equal(app.indicator(),"failure");assert.match(app.label(),/1\/2/);
  assert.equal(app.q('[data-agent="codex"] [data-agent-status]').dataset.state,"success");
  assert.equal(app.q('[data-agent="workbuddy"] [data-agent-status]').dataset.state,"failure");
});
test("API-only stays neutral and does not test unselected programs",async()=>{
  const app=fixture(settings("api","api"));await app.ready();await app.panel.refresh();
  assert.equal(app.indicator(),"idle");assert.equal(app.label(),"未选择本地 Agent");assert.equal(app.calls.length,0);
});
test("simple scope ignores inactive writing source",async()=>{
  const app=fixture(settings("codex","antigravity"),"simple-mode");await app.ready();await app.panel.refresh();
  assert.equal(app.indicator(),"success");assert.equal(app.calls.find(c=>c.method==="probe").args[0],"antigravity");
  assert.equal(app.calls.every(c=>c.workspace==="simple"),true);
});
test("edited configuration invalidates a slow result, without unlocking a newer check",async()=>{
  const app=fixture();await app.ready();const old=defer(),fresh=defer();let probes=0;
  app.invoke(async method=>method==="discover"?{ok:true,agents:discovered()}:(++probes===1?old.promise:fresh.promise));
  const a=app.panel.refresh();await flush();app.edit('[data-agent="codex"] [data-field="model"]',"new-model");
  assert.equal(app.indicator(),"idle");const b=app.panel.refresh();await flush();
  old.resolve({ok:true,status:"detected_not_authenticated"});await a;
  assert.equal(app.indicator(),"checking");assert.equal(app.q("#refreshLocalAgents").disabled,true);
  fresh.resolve({ok:false,message:"执行路径错误，请修改后重试。"});await b;assert.equal(app.indicator(),"failure");
});
test("timeout is visible, unlocks retry and discards late success",async()=>{
  const app=fixture();await app.ready();const pending=defer();
  app.invoke(async()=>pending.promise);const check=app.panel.refresh();app.timeout();await check;
  assert.equal(app.indicator(),"failure");assert.match(app.detail(),/检测超时/);assert.equal(app.q("#refreshLocalAgents").disabled,false);
  pending.resolve({ok:true,agents:discovered()});await flush();assert.equal(app.indicator(),"failure");
});
test("background polling does not overwrite manual failure or issue repeated probes",async()=>{
  const app=fixture(settings("codex","api","mcp"));await app.ready();await app.panel.refresh();const detail=app.detail();
  await app.panel.refresh(true);assert.equal(app.indicator(),"failure");assert.equal(app.detail(),detail);assert.equal(app.calls.some(c=>c.method==="probe"),false);
});
test("raw IPC errors are sanitized and successful retry restores green",async()=>{
  const app=fixture();await app.ready();app.invoke(async()=>{throw new Error("Error invoking remote method: token=SECRET");});
  await app.panel.refresh();assert.equal(app.indicator(),"failure");assert.doesNotMatch(app.detail(),/SECRET|Error invoking/);
  app.invoke(async method=>method==="discover"?{ok:true,agents:discovered()}:{ok:true,status:"detected_not_authenticated"});
  await app.panel.refresh();assert.equal(app.indicator(),"success");
});
test("rendering identical saved settings preserves results, changed settings reset",async()=>{
  const config=settings(),app=fixture(config);await app.ready();await app.panel.refresh();
  app.panel.render(config);assert.equal(app.indicator(),"success");
  app.panel.render(settings("grokbuild"));assert.equal(app.indicator(),"idle");await flush();
});
test("single-provider entry button uses the same visible feedback state machine",async()=>{
  const app=fixture(settings("api","api"));await app.ready();await app.click("grokbuild");
  assert.equal(app.indicator(),"success");assert.equal(app.calls.find(c=>c.method==="probe").args[0],"grokbuild");
});
test("both shipped workspaces include status controller and stylesheet",()=>{
  for(const mode of ["workbench","simple-mode"]){const html=fs.readFileSync(path.join(__dirname,`../app/renderer/${mode}.html`),"utf8");assert.match(html,/local-agent-panel.js/);assert.match(html,/local-agent-panel.css/);}
  assert.match(source,/aria-live="polite"/);assert.match(source,/aria-hidden="true"/);
});
test('WorkBuddy automatically refreshes on first render and focus, preserving custom model and effort',async()=>{
 const cfg=settings('workbuddy');cfg.localAgents.providers.workbuddy.model='saved-custom';
 const app=fixture(cfg);let revision=1;
 const catalog=()=>({ok:true,capabilities:{models:[{id:'model-'+revision,label:'模型'+revision,efforts:['high']}],efforts:['high'],source:'执行入口',checkedAt:new Date().toISOString()}});
 app.invoke(async method=>method==='models'?catalog():{ok:true,agents:discovered(),jobs:[]});
 await flush();assert.equal(app.calls.filter(c=>c.method==='models').length,1);
 assert.match(app.q('[data-agent="workbuddy"] [data-field="modelChoice"]').innerHTML,/model-1/);
 assert.equal(app.q('[data-agent="workbuddy"] [data-field="model"]').value,'saved-custom');
 await app.panel.refresh(true);await flush();assert.equal(app.calls.filter(c=>c.method==='models').length,1);
 revision=2;app.focus();await flush();assert.equal(app.calls.filter(c=>c.method==='models').length,2);
 assert.match(app.q('[data-agent="workbuddy"] [data-field="modelChoice"]').innerHTML,/model-2/);
 assert.equal(app.q('[data-agent="workbuddy"] [data-field="modelChoice"]').value,'saved-custom');
 assert.equal(app.calls.some(c=>c.method==='probe'),false);
});
test('failed refresh preserves catalog and deduplicates simultaneous requests',async()=>{
 const app=fixture(settings('workbuddy'));await app.ready();
 app.invoke(async()=>({ok:true,capabilities:{models:[{id:'valid',label:'有效模型',efforts:[]}],efforts:[],source:'执行入口'}}));await app.models();
 const pending=defer();app.invoke(()=>pending.promise);const a=app.models(),b=app.models();
 pending.resolve({ok:false,message:'读取失败，请重试'});await Promise.all([a,b]);
 assert.match(app.q('[data-agent="workbuddy"] [data-field="modelChoice"]').innerHTML,/valid/);
 assert.equal(app.q('[data-models="workbuddy"]').disabled,false);
});
test('a result for an edited executable cannot overwrite the current directory',async()=>{
 const app=fixture(settings('workbuddy'));await app.ready();const pending=defer();app.invoke(()=>pending.promise);
 const request=app.models();app.edit('[data-agent="workbuddy"] [data-field="executable"]','D:/new/WorkBuddy.exe');
 pending.resolve({ok:true,capabilities:{models:[{id:'stale',label:'旧入口',efforts:[]}],efforts:[],source:'old'}});await request;
 assert.doesNotMatch(String(app.q('[data-agent="workbuddy"] [data-field="modelChoice"]').innerHTML),/stale/);
});
for(const id of ids)test(`automatic model discovery and focus refresh cover ${id}`,async()=>{
 const app=fixture(settings(id));
 app.invoke(async method=>method==='models'?{ok:true,capabilities:{models:[{id:'live-model',label:'当前模型',efforts:[]}],efforts:[],source:'当前入口'}}:{ok:true,agents:discovered(),jobs:[]});
 await flush();assert.ok(app.calls.some(c=>c.method==='models'&&c.args[0]===id));
 assert.match(app.q(`[data-agent="${id}"] [data-field="modelChoice"]`).innerHTML,/live-model/);
 const before=app.calls.filter(c=>c.method==='models').length;app.focus();await flush();assert.equal(app.calls.filter(c=>c.method==='models').length,before+1);
});

