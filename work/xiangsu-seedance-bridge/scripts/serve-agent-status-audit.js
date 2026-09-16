"use strict";
// Isolated shared-component preview, only for the Codex in-app browser.
// No installed app, credentials, native windows, CLI probes or paid calls.
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),task="TASK-20260906-AGENT-STAGES-182";
const evidence=path.resolve(root,"../../.codex_tests",task,"ui");fs.mkdirSync(evidence,{recursive:true});
const baseline=path.resolve(root,"../../.codex_backups",task,"baseline/app/renderer");
const client=`
const params=new URLSearchParams(location.search);let fixtureState=params.get('state')||'success';
const simple=location.pathname.includes('simple-mode');
const agents=['workbuddy','antigravity','codex','deepseek-harness','grokbuild'].map(id=>({id,image:id==='antigravity'?'native':'worker',executable:'D:/fixture/agent.cmd',workerConnected:false,imageWorkerConnected:false,imageAvailable:false,help:'隔离测试数据：执行入口和 MCP 连接均为模拟，不会访问真实账号。'}));
window.__auditErrors=[];addEventListener('error',e=>window.__auditErrors.push(String(e.message)));
window.dramaSlot={localAgents:{call:async(method,scope,...args)=>{
  if(method==='discover'){if(fixtureState==='offline')throw new Error('本地检测服务暂时不可用，请重试。');return {ok:true,agents,jobs:[]};}
  if(method==='probe'){await new Promise(r=>setTimeout(r,fixtureState==='loading'?15000:750));if(fixtureState==='failure')return {ok:false,message:'执行入口无法响应。请确认已安装该 Agent，并填写正确路径后重新检测；无需重新生成资产。'};return {ok:true,status:'detected_not_authenticated'};}
  return {ok:true};}},mcp:{copyConfig:async()=>({ok:true})}};
document.addEventListener('DOMContentLoaded',()=>{
 LocalAgentPanel.render({localAgents:{text:simple?'api':'codex',image:simple?'antigravity':'api'}});
 document.querySelector('#fixtureState').value=fixtureState;
 document.querySelector('#fixtureState').onchange=e=>{fixtureState=e.target.value;};
 document.querySelector('#fixtureZoom').onclick=()=>{document.querySelector('main').style.zoom=document.querySelector('main').style.zoom==='2'?'1':'2';};
 document.querySelector('#fixtureWidth').onchange=e=>{document.querySelector('main').style.width=e.target.value+'px';};
 document.querySelector('#fixtureAudit').onclick=async()=>{
   const violations=(await axe.run(document.querySelector('.local-agent-panel'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations;
   const panel=document.querySelector('.local-agent-panel');
   const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
   const report={time:new Date().toISOString(),scope:simple?'simple':'workbench',state:panel.querySelector('#localAgentConnection')?.dataset.state||'baseline',viewport:{width:innerWidth,height:innerHeight,component:panel.getBoundingClientRect().width,zoom:document.querySelector('main').style.zoom||'1'},label:panel.querySelector('#localAgentConnection')?.innerText,details:panel.querySelector('#localAgentStatus').innerText,violations,errors:window.__auditErrors,overflow:document.documentElement.scrollWidth>innerWidth+1,clipped:[...panel.querySelectorAll('button,input,select')].filter(visible).filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>e.id||e.dataset.field),paidCalls:0,source:'actual shared renderer and styles; isolated RPC fixture'};
   await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});
   document.querySelector('#fixtureResult').textContent=JSON.stringify({state:report.state,axe:violations.length,overflow:report.overflow,clipped:report.clipped,errors:report.errors.length});
 };
});`;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://127.0.0.1");
 if(req.method==="POST"&&url.pathname==="/report") {let body="";for await(const chunk of req){body+=chunk;if(body.length>2e6){res.writeHead(413);res.end();return;}}const report=JSON.parse(body);fs.writeFileSync(path.join(evidence,`${Date.now()}-${report.scope}-${report.state}.json`),JSON.stringify(report,null,2));res.end('{}');return;}
 if(url.pathname==="/client.js"){res.setHeader("content-type","text/javascript; charset=utf-8");res.end(client);return;}
 if(url.pathname==="/axe.js"){res.setHeader("content-type","text/javascript");res.end(require('axe-core').source);return;}
 const name=path.basename(url.pathname);
 if(["local-agent-panel.js","local-agent-panel.css","workbench.css","simple-mode.css"].includes(name)){
  const base=url.searchParams.has("baseline")&&name.startsWith("local-agent-panel")?baseline:path.join(root,"app/renderer");
  res.setHeader("content-type",name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');res.end(fs.readFileSync(path.join(base,name)));return;
 }
 const mode=url.pathname.includes("simple-mode")?'simple-mode':'workbench', suffix=url.searchParams.has("baseline")?'?baseline=1':'';
 res.setHeader("content-type","text/html; charset=utf-8");res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地 Agent 状态 · 隔离审查</title><link rel="stylesheet" href="/${mode}.css"><link rel="stylesheet" href="/local-agent-panel.css${suffix}"><style>html,body{height:auto;overflow:auto}body{padding:24px}main{width:1024px;max-width:100%;margin:24px auto}.settings-grid{display:grid;grid-template-columns:minmax(0,1fr)}.settings-card{min-width:0}header{display:flex;flex-wrap:wrap;gap:12px;align-items:center}header select,header button{min-height:44px}h1{font-size:18px}.panel-card{background:var(--panel);padding:24px}#fixtureResult{overflow-wrap:anywhere}a{color:var(--green)}</style><script src="/client.js"></script><script src="/axe.js"></script><script src="/local-agent-panel.js${suffix}"></script></head><body><header aria-label="隔离审查工具"><h1>本地 Agent 状态审查（模拟连接）</h1><label>场景 <select id="fixtureState"><option value="success">成功</option><option value="failure">失败</option><option value="loading">慢响应</option><option value="offline">服务离线</option></select></label><label>组件宽度 <select id="fixtureWidth"><option>1024</option><option>768</option><option>1280</option><option>1440</option><option>1920</option><option>480</option><option>360</option></select></label><button id="fixtureZoom">200% 缩放</button><button id="fixtureAudit">保存审查</button><a href="/workbench.html">Agent 模式</a><a href="/simple-mode.html">简易模式</a></header><p id="fixtureResult" role="status"></p><main data-panel="settings" data-content="settings"><div class="settings-grid"></div></main></body></html>`);
});
server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/workbench.html`,evidence})));
