"use strict";
// Read-only source UI served only to 127.0.0.1. No browser is launched, and no
// OS GUI control, upstream generation, credential or user project is accessed.
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore, defaultSettings } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

const root = path.resolve(__dirname, "..");
const evidenceRoot = process.env.LOCAL_AGENT_AUDIT_ROOT || path.join(root, ".codex_tests", "TASK-20260905-DRAMA-JIANYING-DRAFT-001", "ui");
const ffmpeg = path.join(root, "media-tools", "ffmpeg.exe");
const contexts = new Map();
const auditErrors = [];
let fixtureState = "success", serial = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const ok = value => ({ ok: true, ...value });

function projectFixture(store, scope, mediaFile) {
  const project = store.createProject(scope === "simple" ? "简易路线：风雨归人·独立音效与自动字幕" : "风雨归人——长标题与多人对白剪映独立轨道完整验收演示", { inputMode: "manual", executionMode: "step", mode: "asset_direct", simpleAssetOnly: scope === "simple" });
  project.status = "completed"; project.currentStage = "final"; project.productionRevision = "local-ui-audit-r1";
  project.characters = [{ id: "C01", name: "顾云舟", gender: "male", age: 56, description: "穿深色西装的中年男性主角" }, { id: "C02", name: "苏晚晴", gender: "female", age: 54, description: "穿浅色套装的中年女性主角" }];
  project.scenes = [{ id: "L01", name: "雨夜门厅", description: "有屋檐和落地窗的酒店门厅" }];
  project.product = { ...project.product, name: "草本清新牙膏", sellingPoints: "温和清洁与清新口气，具体价格以商品页面为准", price: "用户尚未填写", promotion: "无已确认促销活动" };
  project.shots = [
    { number: 1, title: "雨夜重逢与人物身份说明", action: "顾云舟从门外走入，在门口站定后看向苏晚晴。", text: "我回来，是想把当年的误会说清楚。", character: "C01" },
    { number: 2, title: "证据出现，苏晚晴震惊后反问", action: "苏晚晴接过信封，低头读信后抬头直视顾云舟。", text: "原来一直帮助我的人，真的是你。", character: "C02" },
    { number: 3, title: "化解误会，拥抱与温暖收束", action: "两人走近，顾云舟轻轻拥抱苏晚晴。", text: "从今往后，我们再也不要错过彼此。", character: "C01" }
  ].map(shot => ({ ...shot, id: `S0${shot.number}`, duration: 12, sceneId: "L01", scene: "雨夜门厅", visibleCharacterIds: ["C01", "C02"], dialogue: [{ speaker: shot.character === "C01" ? "顾云舟" : "苏晚晴", characterId: shot.character, text: shot.text, startSeconds: 1, endSeconds: 5 }], videoPrompt: `Medium shot in a rainy hotel entrance. The established speaker delivers the line once with emotion: “${shot.text}” Other character listens silently.` }));
  project.script = { ...project.script, content: project.shots.map(shot => `${shot.id} ${shot.title}\n${shot.dialogue[0].speaker}：${shot.text}`).join("\n\n") };
  project.candidates = project.shots.map(shot => ({ id: `${scope}-video-${shot.id}`, entityType: "shot", entityId: shot.id, stage: "shot_video", status: "completed", selected: true, stale: false, filePath: mediaFile, durationSeconds: 12, productionRevision: project.productionRevision, createdAt: new Date().toISOString() }));
  project.videoJobs = []; project.automation = { ...project.automation, status: "completed", stage: "video", completedAt: new Date().toISOString() };
  store.saveProject(project); return project;
}

async function setup() {
  await fsp.mkdir(evidenceRoot, { recursive: true });
  const runRoot = await fsp.mkdtemp(path.join(evidenceRoot, "runtime-"));
  const mediaFile = path.join(runRoot, "local-synthetic-dialogue-test.mp4");
  const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=128x192:r=24:d=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", mediaFile], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  if (generated.status !== 0) throw new Error(`Local fixture generation failed: ${generated.stderr}`);
  for (const scope of ["workbench", "simple"]) {
    const store = new WorkbenchStore(path.join(runRoot, scope));
    const settings = defaultSettings();
    settings.generation = { ...settings.generation, qualityGatesEnabled: false, structureGateEnabled: false };
    settings.jianyingDraftRoot = path.join(runRoot, `${scope}-native-drafts`);
    store.saveSettings(settings);
    const project = projectFixture(store, scope, mediaFile);
    const denied = async () => { throw Object.assign(new Error("审查环境不调用真实生成服务；现有视频与本地后期仍可操作。"), { code: "AUDIT_NO_UPSTREAM" }); };
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => ffmpeg, stagingRoot: path.join(runRoot, scope, "staging"), textGenerator: denied, remoteFetch: denied });
    contexts.set(scope, { store, workflow, projectId: project.id, baseline: clone(project), runRoot });
  }
  return runRoot;
}

function projectView(ctx, id) {
  const project = clone(ctx.store.getProject(id || ctx.projectId));
  if (fixtureState === "empty") { project.shots = []; project.candidates = []; project.status = "draft"; project.finalVideoPath = ""; project.jianyingDraftExport = null; }
  if (fixtureState === "error") project.postProductionTask = { kind: "jianying", status: "failed", retryable: true, message: "目标文件夹暂时不可写，项目文件已保留；请更换草稿目录后重试。" };
  if (fixtureState === "loading") project.postProductionTask = { kind: "jianying", status: "running", message: "正在复制本地视频，可取消并保留原文件。" };
  return project;
}

async function rpc(scope, method, args) {
  const ctx = contexts.get(scope) || contexts.get("workbench"); const { store, workflow } = ctx;
  if (method === "localAgents") {
    const {getHub}=require("../app/local-agent-runtime");const hub=getHub(path.join(store.rootDir,"agent-jobs"));
    const [action,_scope,input,profile]=args;
    if(action==="discover")return ok({agents:await hub.discover(input||store.getSettings().localAgents),jobs:hub.list()});
    if(action==="probe")return await hub.probe(input,profile||{});
    if(action==="cancel")return hub.cancel(input);
    if(action==="copy-worker-instructions")return ok({text:"Offline UI fixture: worker instructions prepared."});
  }
  const id = args[0] || ctx.projectId;
  if (fixtureState === "offline" && ["authStatus", "walletStatus", "licenseStatus"].includes(method)) return { ok: false, code: "AUDIT_NETWORK_OFFLINE", message: "网络暂时不可用；本地粗剪和剪映草稿仍可继续。" };
  const methods = {
    defaults: () => ({ appVersion: "0.16.168-source-audit", captureMode: true, isPackaged: false }),
    getSettings: () => ok({ settings: store.getSettings() }),
    saveSettings: () => ok({ settings: store.saveSettings(args[0]) }),
    resetSettings: () => ok({ settings: store.getSettings() }),
    listProjects: () => ok({ projects: store.listProjects() }),
    listProjectsOverview: () => ok({ projects: store.listProjects() }),
    getProject: () => ok({ project: projectView(ctx, id) }),
    patchProject: () => { const project = store.getProject(id); Object.assign(project, args[1] || {}); store.saveProject(project); return ok({ project: projectView(ctx, id) }); },
    createProject: () => ok({ project: store.createProject(args[0], args[1]) }),
    deleteProject: () => ok({ result: store.deleteProject(id) }),
    listDeletedProjects: () => ok({ projects: store.listDeletedProjects() }),
    restoreProject: () => ok({ project: store.restoreProject(id) }),
    authStatus: () => ok({ configured: true, active: true, connected: true, bridge: { status: "ready" } }),
    licenseStatus: () => ok({ state: { authenticated: true, active: true, role: "admin" }, status: { active: true, valid: true }, license: { active: true, role: "admin" } }),
    walletStatus: () => ok({ wallet: { availableCents: 10000, frozenCents: 0, available: 100, balance: 100 } }),
    getStorageLocation: () => ok({ rootDir: store.rootDir, projectRoot: store.rootDir, sharedLibraryRoot: store.rootDir }),
    storageLocation: () => ok({ rootDir: store.rootDir, projectRoot: store.rootDir, sharedLibraryRoot: store.rootDir }),
    accountSwitchStatus: () => ok({ state: { status: "idle", pendingJobs: [] } }),
    listVoiceLibrary: () => ok({ voices: [] }), listReusableAssets: () => ok({ assets: [] }), listTextModels: () => ok({ models: [] }),
    syncVideoJobs: () => ok({ jobs: [], project: projectView(ctx, id) }),
    stitch: async () => ok({ result: await workflow.stitchProject(id) }),
    stitchProject: async () => ok({ result: await workflow.stitchProject(id) }),
    exportJianyingDraft: async () => ok({ result: await workflow.exportJianyingDraft(id, { draftRoot: path.join(ctx.runRoot, `${scope}-native-drafts`) }) }),
    cancelPostProduction: () => ok({ result: workflow.cancelPostProduction(id) }),
    openFile: () => ok({ message: "浏览器审查不会打开原生应用；已验证本地文件入口。" }),
    revealFile: () => ok({ message: "浏览器审查不会启动资源管理器；已验证定位入口。" }),
    revealPath: () => ok({}), checkUpdate: () => ({ status: "latest" })
  };
  if (methods[method]) return await methods[method]();
  if (/^on[A-Z]/.test(method)) return ok({});
  if (/^list/.test(method)) return ok({ items: [], projects: [], assets: [], jobs: [] });
  return { ok: false, code: "AUDIT_UNAVAILABLE_OPERATION", message: `此隔离审查不执行“${method}”；可返回继续本地粗剪、字幕与草稿测试。` };
}

const bridgeScript = `"use strict";
(() => {
 const scope = location.pathname.includes('simple-mode') ? 'simple' : 'workbench';
 const call = async (method,...args) => { const response=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope,method,args})});return response.json(); };
 const proxy = new Proxy({}, {get: (_,name) => /^on[A-Z]/.test(name) ? (()=>()=>{}) : (...args)=>call(name,...args)});
 window.dramaSlot = new Proxy({workbench:proxy,simple:{call},localAgents:{call:(...args)=>call('localAgents',...args)},mcp:{getConnectionInfo:()=>Promise.resolve({ok:true,info:{genericJson:'{}'}}),copyConfig:()=>Promise.resolve({ok:true}),testConnection:()=>Promise.resolve({ok:true})},defaults:()=>call('defaults'),onUpdateStatus:()=>()=>{},checkUpdate:()=>call('checkUpdate'),appMode:{select:async(mode)=>{location.href=mode==='simple'?'/app/renderer/simple-mode.html':'/app/renderer/workbench.html?captureStage=final';return {ok:true};}}}, {get:(target,name)=>target[name]||((...args)=>call(name,...args))});
 localStorage.setItem('puream.simple-mode.guide.v1','1');
 window.__postAuditErrors=[]; window.addEventListener('error',event=>window.__postAuditErrors.push(String(event.error?.stack||event.message)));window.addEventListener('unhandledrejection',event=>window.__postAuditErrors.push(String(event.reason?.stack||event.reason)));
})();`;

const monitorScript = `"use strict";
document.addEventListener('DOMContentLoaded',()=>{
 const panel=document.createElement('aside');panel.id='auditControls';panel.setAttribute('aria-label','隔离审查控制，不属于生产界面');panel.style='position:fixed;right:6px;bottom:6px;z-index:99999;background:#183443;color:#fff;padding:6px;font:12px sans-serif;border:1px solid #86c4e4;border-radius:6px;';
 panel.innerHTML='<label>隔离审查 <select id="auditFixture" aria-label="审查状态"><option value="success">正常</option><option value="empty">空项目</option><option value="error">后期失败</option><option value="offline">上游离线</option><option value="loading">处理中</option></select></label> <button id="auditReset">恢复样例</button> <button id="auditZoom">200%</button> <button id="auditSave">保存审查</button> <a href="/app/renderer/workbench.html?captureStage=final" style="color:white">完整模式</a> <a href="/app/renderer/simple-mode.html" style="color:white">简易模式</a>';
 document.body.append(panel);
 document.querySelector('#auditFixture').value=new URLSearchParams(location.search).get('fixture')||'success';
 document.querySelector('#auditFixture').onchange=async event=>{await fetch('/fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:event.target.value})});const url=new URL(location.href);url.searchParams.set('fixture',event.target.value);location.href=url;};
 document.querySelector('#auditReset').onclick=async()=>{await fetch('/fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:'success',reset:true})});location.reload();};
 document.querySelector('#auditZoom').onclick=()=>{document.documentElement.style.zoom=document.documentElement.style.zoom==='2'?'1':'2';schedule();};
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
 let busy=false,timer;
 window.runPostAudit=async()=>{if(busy)return;busy=true;try{const violations=window.axe?(await window.axe.run({exclude:[['#auditControls']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations:[];const report={time:new Date().toISOString(),url:location.href,scope:location.pathname.includes('simple-mode')?'simple':'workbench',fixture:document.querySelector('#auditFixture').value,viewport:{width:innerWidth,height:innerHeight,zoom:document.documentElement.style.zoom||'1'},ready:{...document.body.dataset},title:document.title,bodyOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,errors:[...window.__postAuditErrors],violations,visibleButtons:[...document.querySelectorAll('button')].filter(visible).filter(e=>!panel.contains(e)).map(e=>({id:e.id,text:e.innerText,disabled:e.disabled,clipped:e.scrollWidth>e.clientWidth+2})),activePanel:[...document.querySelectorAll('[data-panel],.panel')].filter(visible).map(e=>({id:e.id,panel:e.dataset.panel,heading:e.querySelector('h2')?.innerText})),bodyText:document.body.innerText.slice(0,22000)};await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});panel.dataset.lastAudit=report.time;return report;}finally{busy=false;}};
 function schedule(){clearTimeout(timer);timer=setTimeout(()=>window.runPostAudit().catch(error=>window.__postAuditErrors.push(String(error))),1000);}
 document.querySelector('#auditSave').onclick=()=>window.runPostAudit();document.addEventListener('click',schedule);document.addEventListener('change',schedule);window.addEventListener('resize',schedule);setTimeout(schedule,1500);
});`;

async function body(request) { let text = ""; for await (const data of request) { text += data; if (text.length > 8e6) throw new Error("Request too large"); } return text ? JSON.parse(text) : {}; }
function sendJson(response, value, status = 200) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
async function serveFile(response, file, request) {
  const stat = await fsp.stat(file);
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".woff2": "font/woff2" };
  const headers = { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" };
  if (file.endsWith(".html")) {
    const html = (await fsp.readFile(file, "utf8")).replace(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i, "").replace("</head>", '<script src="/audit-bridge.js"></script><script src="/axe.js"></script><script src="/audit-monitor.js"></script></head>');
    response.writeHead(200, headers); response.end(html); return;
  }
  if (file.endsWith("workbench.js") || file.endsWith("simple-mode.js")) {
    // HTTP-only replacement for Electron's custom media protocol. Source disk
    // and application rendering logic remain unchanged.
    response.writeHead(200, headers); response.end((await fsp.readFile(file, "utf8")).replaceAll("puream-asset://local/", "/media?path=")); return;
  }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) { const start = Number(range[1]), end = Math.min(Number(range[2]) || stat.size - 1, stat.size - 1); response.writeHead(206, { ...headers, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 }); fs.createReadStream(file, { start, end }).pipe(response); }
  else { response.writeHead(200, { ...headers, "content-length": stat.size }); fs.createReadStream(file).pipe(response); }
}

async function main() {
  const runRoot = await setup();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/rpc") { const data = request.method === "POST" ? await body(request) : { method: url.searchParams.get("method"), scope: url.searchParams.get("scope"), args: JSON.parse(url.searchParams.get("args") || "[]") }; return sendJson(response, await rpc(data.scope, data.method, data.args || [])); }
      if (url.pathname === "/fixture") { const data = await body(request); fixtureState = ["success","empty","error","offline","loading"].includes(data.state) ? data.state : "success"; if (data.reset) for (const ctx of contexts.values()) ctx.store.saveProject(clone(ctx.baseline)); return sendJson(response, ok({ state: fixtureState })); }
      if (url.pathname === "/report") { const data = await body(request); const file = path.join(evidenceRoot, `browser-audit-${Date.now()}-${String(++serial).padStart(3,"0")}-${data.scope || "unknown"}-${data.fixture || "unknown"}.json`); await fsp.writeFile(file, JSON.stringify(data,null,2),"utf8"); return sendJson(response,ok({file})); }
      if (url.pathname === "/health") return sendJson(response, ok({ runRoot, evidenceRoot, fixtureState, projectIds: Object.fromEntries([...contexts].map(([scope,ctx])=>[scope,ctx.projectId])), errors: auditErrors, noPaidCalls: true, interfaceScope: "real source renderer with isolated fake app bridge; real local post-production workflow" }));
      if (["/audit-bridge.js","/audit-monitor.js","/axe.js"].includes(url.pathname)) { response.writeHead(200,{"content-type":"text/javascript; charset=utf-8"});response.end(url.pathname==="/audit-bridge.js"?bridgeScript:url.pathname==="/audit-monitor.js"?monitorScript:require("axe-core").source);return; }
      if (url.pathname === "/media") { const file=path.resolve(url.searchParams.get("path")||""); if (!file.startsWith(runRoot+path.sep)) return sendJson(response,{ok:false,message:"Only isolated fixture media is exposed"},403); return await serveFile(response,file,request); }
      const requested = url.pathname === "/" ? "/app/renderer/workbench.html" : decodeURIComponent(url.pathname);
      const file = path.resolve(root, `.${requested}`);
      if (!file.startsWith(path.join(root,"app")+path.sep)) return sendJson(response,{ok:false},403);
      await serveFile(response,file,request);
    } catch (error) { auditErrors.push({at:new Date().toISOString(),path:request.url,message:error.message,code:error.code});if(!response.headersSent)sendJson(response,{ok:false,code:error.code||"LOCAL_AUDIT_ERROR",message:error.message},request.url?.startsWith('/rpc')?200:500);else response.end(); }
  });
  server.listen(Number(process.env.POST_AUDIT_PORT)||0,"127.0.0.1",()=>{
    const address=server.address();console.log(JSON.stringify({url:`http://127.0.0.1:${address.port}/app/renderer/workbench.html?captureStage=final`,simpleUrl:`http://127.0.0.1:${address.port}/app/renderer/simple-mode.html`,runRoot,evidenceRoot}));
  });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
