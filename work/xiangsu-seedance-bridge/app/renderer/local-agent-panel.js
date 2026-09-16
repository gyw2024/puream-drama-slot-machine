"use strict";
(() => {
  const definitions = [
    ["workbuddy","WorkBuddy","cli"], ["antigravity","Antigravity","cli"], ["codex","Codex","cli"],
    ["deepseek-harness","DeepSeek Harness","sdk"], ["grokbuild","Grok Build","cli"]
  ];
  const escape = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const scope = location.pathname.includes("simple-mode") ? "simple" : "workbench";
  let root, stored = {}, detection = [], poll;
  let checkRevision = 0, checkInFlight = null, discoverInFlight = null, rendered = false;
  const checkedProviders = new Set();
  const CHECK_TIMEOUT_MS = 45000;
  const catalogs = new Map();
  const modelRefreshes = new Map(), modelChecked = new Map();
  const MODEL_REFRESH_MS = 60000;
  const effortNames={off:"关闭思考",none:"无",minimal:"极低",low:"低",medium:"中",high:"高",xhigh:"很高",max:"最高",ultra:"Ultra"};
  const query = selector => root?.querySelector(selector);
  const sourceOptions = () => '<option value="api">软件内置 API（保留原设置）</option>'+definitions.map(([id,name])=>`<option value="${id}">${name}</option>`).join("");
  const profile = (id,key) => query(`[data-agent="${id}"] [data-field="${key}"]`);
  const stageFields = [["planning","agentPlanningSource","拆分镜与资产提示词"],["review","agentReviewSource","剧本与提示词审核"],["postProduction","agentPostSource","后期特效音匹配"]];
  const resolvedStage = (config, stage) => !config.stages?.[stage] || config.stages[stage] === "inherit" ? (stage === "postProduction" && !config.stages?.[stage] ? "local" : config.text) : config.stages[stage];
  const textSources = config => [scope !== "simple" ? config.text : "api", ...stageFields.filter(([stage])=>scope!=="simple" || stage==="postProduction").map(([stage])=>resolvedStage(config,stage))];
  async function rpc(method,...args) {
    if (!window.dramaSlot?.localAgents?.call) throw new Error("当前运行版本尚未提供本地 Agent 接入，请安装新版后重新打开。");
    const result=await window.dramaSlot.localAgents.call(method,scope,...args);
    if (!result?.ok) throw Object.assign(new Error(result?.message||"Agent 连接未完成，请检查配置后重试。"), {code: result?.code});
    return result;
  }
  function status(text) { if(query("#localAgentStatus"))query("#localAgentStatus").textContent=text; }
  function indicator(element, state, text) {
    if (!element) return;
    element.dataset.state = state;
    element.querySelector("[data-connection-label]").textContent = text;
  }
  const agentIndicator = id => query(`[data-agent="${id}"] [data-agent-status]`);
  function setChecking(busy) {
    const button = query("#refreshLocalAgents");
    if (button) { button.disabled = busy; button.textContent = busy ? "检测中…" : "检测接入状态"; }
    root?.querySelectorAll("[data-probe]").forEach(button => { button.disabled = busy; });
  }
  function invalidateCheck() {
    checkRevision++;
    checkInFlight = null;
    checkedProviders.clear();
    setChecking(false);
    indicator(query("#localAgentConnection"), "idle", "未检测 · 配置已变更");
    for (const [id] of definitions) indicator(agentIndicator(id), "idle", "未检测");
    status("配置已变更，请重新检测，并点击页面“保存设置”。旧配置的检测结果不会用于新配置。");
  }
  function publicFailure(error) {
    const message = String(error?.message || "");
    // IPC/native exceptions and credentials must not become persistent page text.
    return /[\u3400-\u9fff]/.test(message) && !/Error invoking|https?:\/\/|Bearer\s|api.?key|token[=:]|\n\s*at\s/i.test(message)
      ? message.slice(0, 500) : "无法连接本地 Agent。请检查执行文件路径或 MCP 工作端，再重新检测。";
  }
  function deadline(promise) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("检测超时，尚未确认连通。请检查本地 Agent 后重新检测；本次未提交生成任务。")), CHECK_TIMEOUT_MS);
    })]).finally(() => clearTimeout(timer));
  }
  async function checkProvider(id, config, agents, explicit = false) {
    const agent = agents.find(item => item.id === id);
    const p = config.providers[id];
    if (!agent) throw new Error("未收到该 Agent 的接入信息，请重新检测。");
    const needsText = textSources(config).includes(id) || (explicit && config.image !== id);
    const needsImage = config.image === id;
    const nativeImage = agent.image === "native" && p.transport === "cli";
    if (needsText && p.transport === "mcp" && !agent.workerConnected) throw new Error("写作工作端未连接。请在该 Agent 中配置 MCP，并执行接管指令后重试。");
    const imageMissing = needsImage && !nativeImage && !agent.imageWorkerConnected;
    if ((needsText && p.transport !== "mcp") || (needsImage && nativeImage)) {
      const result = await rpc("probe", id, p);
      if (result.status !== "detected_not_authenticated") throw new Error("执行入口尚未确认响应，请检查路径后重新检测。");
      if (imageMissing) throw Object.assign(new Error("写作执行入口已响应；生图工作端未连接。请复制 MCP 配置和该 Agent 的接管指令，在具有真实生图工具的会话中执行后重试。"), {partial:true});
      return "连通成功 · 执行入口已响应";
    }
    if (imageMissing) throw Object.assign(new Error("生图工作端未连接。请复制 MCP 配置及接管指令，在该 Agent 中连接具备真实生图工具的 MCP 会话后重试。"), {partial:needsText && agent.workerConnected});
    return needsImage && !needsText ? "连通成功 · 生图工作端在线" : "连通成功 · MCP 工作端在线";
  }
  function checkConnections(onlyId) {
    if (checkInFlight) return checkInFlight;
    const config = collect(stored).localAgents;
    const ids = onlyId ? [onlyId] : [...new Set([...textSources(config), config.image].filter(id => id !== "api" && id !== "local"))];
    if (!ids.length) {
      indicator(query("#localAgentConnection"), "idle", "未选择本地 Agent");
      status("当前使用内置 API，无需检测本地 Agent；请在对应 API 设置卡片测试连接，或先选择本地执行来源。");
      return Promise.resolve();
    }
    const revision = ++checkRevision;
    setChecking(true);
    indicator(query("#localAgentConnection"), "checking", "检测中");
    for (const id of ids) { checkedProviders.add(id); indicator(agentIndicator(id), "checking", "检测中"); }
    status("正在检测所选执行入口与 MCP 工作端，请稍候；不会提交写作或生图任务。");
    let expired = false;
    checkInFlight = (async () => {
      try {
        const results = await deadline((async () => {
          const discovered = await rpc("discover", config);
          if (expired || revision !== checkRevision) return [];
          return Promise.all(ids.map(async id => {
            try { return {id, ok:true, message:await checkProvider(id, config, discovered.agents || [], Boolean(onlyId))}; }
            catch (error) { return {id, ok:false, partial:error.partial, message:publicFailure(error)}; }
          }));
        })());
        if (revision !== checkRevision) return;
        for (const result of results) indicator(agentIndicator(result.id), result.ok ? "success" : result.partial ? "checking" : "failure", result.ok ? result.message : result.partial ? "部分可用 · 写作可连接，生图未连接" : "连通失败");
        const failed = results.filter(result => !result.ok);
        const label = failed.length ? (failed.length === results.length ? "连通失败" : `连通失败 · ${failed.length}/${results.length} 项未通过`) : "连通成功";
        indicator(query("#localAgentConnection"), failed.length ? "failure" : "success", onlyId ? `${definitions.find(a => a[0] === onlyId)?.[1]} · ${label}` : label);
        const checkedAt = new Date().toLocaleTimeString("zh-CN", {hour12:false});
        status(`最近检测 ${checkedAt}。${results.map(result => `${definitions.find(a => a[0] === result.id)?.[1] || result.id}：${result.message}`).join("；")}。仅验证执行入口响应或工作端在线；账号授权、额度与实际生成能力未实测。本次未提交生成任务。`);
      } catch (error) {
        expired = true;
        if (revision !== checkRevision) return;
        indicator(query("#localAgentConnection"), "failure", "连通失败");
        for (const id of ids) indicator(agentIndicator(id), "failure", "连通失败");
        status(publicFailure(error));
      } finally {
        if (revision === checkRevision) { checkInFlight = null; setChecking(false); }
      }
    })();
    return checkInFlight;
  }
  function collect(settings={}) {
    if(!root)return settings;
    const providers={};
    for(const [id,,transport] of definitions)providers[id]={
      transport:profile(id,"transport")?.value||transport,executable:profile(id,"executable")?.value.trim()||"",model:profile(id,"model")?.value.trim()||"",
      reasoningEffort:profile(id,"reasoningEffort")?.value||"",speed:profile(id,"speed")?.value||"standard",
      dshHome:profile(id,"dshHome")?.value.trim()||"",timeoutSeconds:0
    };
    return {...settings,localAgents:{text:query("#agentTextSource").value,image:query("#agentImageSource").value,stages:Object.fromEntries(stageFields.map(([stage,id])=>[stage,query(`#${id}`).value || (stage === "postProduction" ? "local" : "inherit")])),providers}};
  }
  function renderJobs(jobs=[]) {
    jobs=jobs.map(j=>({...j,message:`${j.message} · 请求模型：${j.execution?.model||"Agent 自身默认"} · 思考：${j.execution?.reasoningEffort||"默认"} · 速度：${({standard:"标准",fast:"优先响应",quality:"深度优先",priority:"官方 Fast"})[j.execution?.speed]||"默认"}${j.reportedModel?` · 回报模型：${j.reportedModel}`:""}`}));
    const list=query("#localAgentJobs");if(!list)return;
    const rows=jobs.slice(0,12);
    list.innerHTML=rows.length?rows.map(j=>`<li><span><b>${escape(definitions.find(a=>a[0]===j.agentId)?.[1]||j.agentId)} · ${j.modality==="image"?"图片":"写作"}</b><small>${escape(j.message)} · ${escape(j.id)}</small></span>${["running","waiting_agent"].includes(j.status)?`<button type="button" class="outline-button" data-cancel-job="${escape(j.id)}">取消任务</button>`:`<span>${escape({completed:"已交付",failed:"未完成",cancelled:"已取消",interrupted:"需检查旧任务"}[j.status]||j.status)}</span>`}</li>`).join(""):'<li>尚无本地 Agent 任务。保存执行来源后，从原来的生产按钮开始。</li>';
  }
  function renderModelOptions(id, capability) {
    if(capability)catalogs.set(id,capability);
    const cap=catalogs.get(id);if(!cap)return;
    const card=query(`[data-agent="${id}"]`),model=profile(id,"model")?.value||"";
    const choice=profile(id,"modelChoice"),list=card.querySelector("datalist");
    if(choice){choice.innerHTML='<option value="">跟随 Agent 自身默认（不指定模型）</option>'+cap.models.map(m=>`<option value="${escape(m.id)}">${escape(m.label)} · ${escape(m.id)}</option>`).join('')+(model&&!cap.models.some(m=>m.id===model)?`<option value="${escape(model)}">${escape(model)}（保留当前配置）</option>`:'')+'<option value="__custom__">手动输入其他模型 ID</option>';choice.value=model;}
    if(list)list.innerHTML=cap.models.map(m=>`<option value="${escape(m.id)}">${escape(m.label)}</option>`).join('');
    const selected=cap.models.find(m=>m.id===model),levels=selected?selected.efforts:cap.efforts;
    const effort=profile(id,"reasoningEffort"),old=effort?.value||"";
    if(effort){effort.innerHTML='<option value="">跟随 Agent / 模型默认</option>'+levels.map(e=>`<option value="${escape(e)}">${escape(effortNames[e]||e)} · ${escape(e)}</option>`).join('');if(old&&!levels.includes(old))effort.insertAdjacentHTML('beforeend',`<option value="${escape(old)}">${escape(old)}（当前模型不支持，请调整）</option>`);effort.value=old;effort.disabled=["fast","quality"].includes(profile(id,"speed")?.value);}
    const fast=profile(id,"speed")?.querySelector('[value="priority"]');if(fast)fast.disabled=id!=="codex"||!selected?.tiers?.some(t=>["priority","fast"].includes(t));
    for(const option of profile(id,"speed")?.querySelectorAll('[value="fast"],[value="quality"]')||[])option.disabled=levels.length===0;
    const speed=profile(id,"speed")?.value||"standard";
    card.querySelector('[data-model-help]').textContent=`${cap.source}；${cap.models.length} 个模型。${!model?'当前未指定模型，实际模型由 Agent 自身决定。':`当前指定：${model}。`}${levels.length?'':'该模型未声明可调思考档位，保持默认。'}${speed==='fast'?'优先响应使用支持的较低思考档位，不保证固定秒数。':speed==='quality'?'深度优先使用支持的较高思考档位。':speed==='priority'?'官方 Fast 可能增加账号消耗。':''}${profile(id,"transport")?.value==='mcp'?'MCP 会把参数作为执行请求交给工作端，是否应用需工作端确认。':''}`;
    if(cap.checkedAt&&cap.checkedAt.includes('T'))card.querySelector('[data-model-help]').textContent+=` 最近读取 ${new Date(cap.checkedAt).toLocaleTimeString('zh-CN',{hour12:false})}。`;
  }
  async function refreshModels(id,force=false) {
    const p=collect(stored).localAgents.providers[id],key=JSON.stringify([p.executable||'',p.dshHome||'']);
    const currentKey=()=>JSON.stringify([profile(id,'executable')?.value.trim()||'',profile(id,'dshHome')?.value.trim()||'']);
    if(modelRefreshes.has(id))return modelRefreshes.get(id);
    const prior=modelChecked.get(id);
    if(!force&&prior?.key===key&&Date.now()-prior.at<MODEL_REFRESH_MS)return;
    modelChecked.set(id,{key,at:Date.now()});
    const button=query(`[data-models="${id}"]`);if(button){button.disabled=true;button.textContent='正在读取…';}
    const request=(async()=>{try{
      const result=await deadline(rpc('models',id,p));
      if(currentKey()!==key)return;
      if(!Array.isArray(result.capabilities?.models)||!result.capabilities.models.length)throw new Error('未读取到完整模型目录，保留已有模型和配置。');
      renderModelOptions(id,result.capabilities);
      if(force)status('模型目录已刷新；现有模型不自动替换，账号可用性以实际回执为准。');
    }catch(error){
      if(currentKey()===key){
        renderModelOptions(id);
        const help=query(`[data-agent="${id}"] [data-model-help]`);if(help)help.textContent+=' 自动更新未完成，保留上次目录。'+publicFailure(error);
      }
      if(force)status(publicFailure(error));
    }finally{modelRefreshes.delete(id);if(button){button.disabled=false;button.textContent='刷新模型列表';}}})();
    modelRefreshes.set(id,request);return request;
  }
  async function refresh(silent=false) {
    if (!silent) return checkConnections();
    if (discoverInFlight || checkInFlight) return;
    const revision = checkRevision;
    discoverInFlight = true;
    try {
      const result=await deadline(rpc("discover",collect(stored).localAgents));
      if (revision !== checkRevision) return;
      detection=result.agents||[];
      for(const agent of detection) {
        const card=query(`[data-agent="${agent.id}"]`);if(!card)continue;
        if (!checkedProviders.has(agent.id)) indicator(agentIndicator(agent.id), "idle", agent.executable || agent.workerConnected || agent.imageWorkerConnected ? "入口已发现 · 待检测" : "未检测 · 待配置");
        card.querySelector("[data-image-status]").textContent=agent.imageWorkerConnected?"生图：工作端已声明工具，实际图片仍需校验":agent.imageAvailable?"生图：官方工具支持，本机尚未实测":"生图：需要接入具备生图工具的 MCP 会话";
        card.querySelector("[data-agent-help]").textContent=agent.help;
        const input=profile(agent.id,"executable");if(input)input.placeholder=agent.executable||"填写真实 CLI / Python 可执行文件的绝对路径";
        if(!catalogs.has(agent.id)&&agent.capabilities)renderModelOptions(agent.id,agent.capabilities);
      }
      renderJobs(result.jobs);
      const config=collect(stored).localAgents;
      for(const [id] of definitions)if([...textSources(config),config.image].includes(id)||query(`[data-agent="${id}"]`)?.open)void refreshModels(id);
    } catch(error) { /* Passive discovery must not overwrite an explicit check. */ }
    finally { discoverInFlight = null; }
  }
  function mount() {
    if(root)return true;
    const grid=document.querySelector('[data-panel="settings"] .settings-grid, [data-content="settings"] .settings-grid');if(!grid)return false;
    root=document.createElement("section");root.className="settings-card panel-card local-agent-panel";root.setAttribute("aria-labelledby","localAgentHeading");
    root.innerHTML=`<div class="card-title"><div><span class="step-tag">LOCAL AGENT ENGINES</span><h3 id="localAgentHeading">本地 AI 工作软件</h3></div><div class="local-agent-check-actions"><span id="localAgentConnection" class="local-agent-connection" data-state="idle" role="status" aria-live="polite" aria-atomic="true"><i class="local-agent-dot" aria-hidden="true"></i><span data-connection-label>未检测</span></span><button id="refreshLocalAgents" class="outline-button" type="button" aria-describedby="localAgentStatus">检测接入状态</button></div></div>
      <p id="localAgentStatus" class="settings-note" role="status" aria-live="polite">先配置执行入口或连接 MCP 工作端，再保存执行来源。不会扫描整个硬盘或控制桌面窗口。</p>
      <p class="settings-note">写作与生图独立选择，适用于当前工作区所有生产模式。API 配置保留；不会自动换供应商。Agent 使用其账号额度，不等于免费或离线。</p>
      <div class="local-agent-sources"><label for="agentTextSource">① 选题与剧本编写<select id="agentTextSource">${sourceOptions()}</select></label>
      <label for="agentPlanningSource">② 拆剧本分镜、提炼资产、资产与视频提示词<select id="agentPlanningSource"><option value="inherit">沿用选题与剧本 Agent</option>${sourceOptions()}</select></label>
      <label for="agentReviewSource">③ 剧本与提示词审核<select id="agentReviewSource"><option value="inherit">沿用选题与剧本 Agent</option>${sourceOptions()}</select></label>
      <label for="agentPostSource">④ 后期特效音匹配<select id="agentPostSource"><option value="local">内置本地匹配（不请求模型）</option><option value="inherit">沿用选题与剧本 Agent</option>${sourceOptions()}</select></label>
      <label for="agentImageSource">⑤ 人物、场景、道具与分镜图片<select id="agentImageSource">${sourceOptions()}</select></label></div>
      <p class="settings-note">每个阶段独立调用所选来源，不会偷偷切换 Agent 或 API。Codex、Antigravity 可通过本地 CLI 直接接收自然语言与参考图，使用内置生图工具，无需另配生图 MCP；其他 Agent 或主动选择 MCP 接管时才需要连接工作端。入口连通不代表生图已实测，只有收到有效图片才会入库。后期音效仍为剪映独立音轨，不烧进视频。</p>
      <p class="settings-note">完整剧本一次生成；资产与视频提示词随后分别生成，视频提示词每批最多 5 镜。生图须交付真实图片并保留参考图身份、商品包装；图片自动沿用原资产入库流程。更改后点击页面“保存设置”。</p>
      <div class="local-agent-providers">${definitions.map(([id,name,transport])=>`<details data-agent="${id}"><summary><b>${name}</b><span data-agent-status class="local-agent-connection" data-state="idle"><i class="local-agent-dot" aria-hidden="true"></i><span data-connection-label>未检测</span></span></summary><p data-agent-help class="settings-note"></p><p data-image-status class="settings-note"></p>
      <div class="local-agent-fields"><label>接入方式<select data-field="transport" aria-label="${name} 接入方式"><option value="${transport}">${id==="workbuddy"?"WorkBuddy 安装包原生入口":transport==="sdk"?"官方 Python SDK":"官方非交互 CLI"}</option><option value="mcp">外部 Agent 通过 MCP 接管</option></select></label>
      <label>执行文件路径<input data-field="executable" aria-label="${name} 执行文件路径" spellcheck="false"></label>
      <label>选择模型<select data-field="modelChoice" aria-label="${name} 选择模型"><option value="">跟随 Agent 自身默认（不指定模型）</option><option value="__custom__">手动输入其他模型 ID</option></select></label>
      <label>模型 ID（可手填；留空则跟随默认）<input data-field="model" aria-label="${name} 模型" list="agent-models-${id}" spellcheck="false"><datalist id="agent-models-${id}"></datalist></label>
      <label>思考强度<select data-field="reasoningEffort" aria-label="${name} 思考强度"><option value="">跟随 Agent / 模型默认</option></select></label>
      <label>速度策略<select data-field="speed" aria-label="${name} 速度策略"><option value="standard">标准（使用所选思考强度）</option><option value="fast">优先响应（减少思考量）</option><option value="quality">深度优先（增加思考量）</option>${id==="codex"?'<option value="priority" disabled>官方 Fast（可能增加消耗）</option>':""}</select></label>
      ${id==="deepseek-harness"?'<label>已授权的 Harness home<input data-field="dshHome" aria-label="DeepSeek Harness home" placeholder="绝对路径，不填写密钥"></label>':""}
      <p class="settings-note">运行时长：不限。等待 Agent 完成、明确报错或主动停止。</p></div>
      <p data-model-help class="settings-note" role="status">模型目录读取中；不发起生成请求，现有配置保持。</p>
      <div class="card-actions"><button type="button" class="outline-button" data-models="${id}">刷新模型列表</button><button type="button" class="outline-button" data-probe="${id}">检查执行入口</button><button type="button" class="outline-button" data-worker="${id}">复制接管指令</button></div></details>`).join("")}</div>
      <div class="card-actions"><button id="copyAgentMcpConfig" type="button" class="outline-button">复制通用 MCP 配置</button></div>
      <details class="local-agent-task-list"><summary>Agent 任务与取消</summary><ul id="localAgentJobs"></ul></details>`;
    grid.prepend(root);
    if(scope === "simple") {
      query("#agentTextSource").disabled=true;
      query("#agentPlanningSource").disabled=true;
      query("#agentReviewSource").disabled=true;
      const notice=document.createElement("p");notice.className="settings-note";notice.textContent="简易模式不执行选题、编剧或 AI 拆镜，写作来源在这里不生效；生图来源可以独立选择。需要 AI 写作请进入 Agent 模式。";root.prepend(notice);
    }
    root.addEventListener("click",async event=>{
      const button=event.target.closest("button");if(!button)return;
      if(button.id === "refreshLocalAgents" || button.dataset.probe) { await checkConnections(button.dataset.probe); return; }
      if(button.dataset.models){await refreshModels(button.dataset.models,true);return;}
      const original=button.textContent;button.disabled=true;
      try{
        if(button.id==="copyAgentMcpConfig") { const result=await window.dramaSlot.mcp.copyConfig("generic-json");if(!result?.ok)throw new Error(result?.message||"MCP 配置复制失败");status("MCP 配置已复制。添加到对应 Agent 后，再复制并执行它的接管指令。"); }
        else if(button.dataset.worker){await rpc("copy-worker-instructions",button.dataset.worker);status("接管指令已复制，请在对应 Agent 内执行。仅复制指令不会启动工作端。");}
        else if(button.dataset.cancelJob){await rpc("cancel",button.dataset.cancelJob);await refresh(true);status("已取消任务；迟到结果不会覆盖项目。外部 Agent 应同步停止相应任务。");}
      }catch(error){status(publicFailure(error));}finally{button.disabled=false;button.textContent=original;}
    });
    root.addEventListener("input", event => { if(event.target.matches("input,select"))invalidateCheck(); });
    root.addEventListener("change", event => {
      const id=event.target.closest('[data-agent]')?.dataset.agent,field=event.target.dataset.field;
      if(id&&field==="modelChoice"){if(event.target.value!=="__custom__")profile(id,"model").value=event.target.value;else profile(id,"model").focus();}
      if(id&&["modelChoice","model","speed","transport","reasoningEffort"].includes(field)){if(field==="reasoningEffort")profile(id,"speed").value="standard";renderModelOptions(id);}
      if(event.target.matches("select,input"))invalidateCheck();
      if(id&&['executable','dshHome'].includes(field))void refreshModels(id,true);
      if(!id&&definitions.some(([id])=>id===event.target.value))void refreshModels(event.target.value);
    });
    for(const [id] of definitions)query(`[data-agent="${id}"]`).addEventListener('toggle',event=>{if(event.target.open)void refreshModels(id);});
    window.addEventListener('focus',()=>{if(root?.getClientRects().length){modelChecked.clear();void refresh(true);}});
    poll=setInterval(()=>{if(root.getClientRects().length)refresh(true);},5000);
    window.addEventListener("pagehide",()=>clearInterval(poll),{once:true});
    return true;
  }
  function render(settings) {
    if(!mount())return;
    const previous = JSON.stringify(collect(stored).localAgents);
    stored=settings||{};
    const config=stored.localAgents||{};
    query("#agentTextSource").value=config.text||"api";query("#agentImageSource").value=config.image||"api";
    for(const [stage,id] of stageFields) query(`#${id}`).value=config.stages?.[stage] || (stage === "postProduction" ? "local" : "inherit");
    for(const [id,,transport]of definitions){const p=config.providers?.[id]||{};for(const key of ["transport","executable","model","dshHome","reasoningEffort","speed"]){const input=profile(id,key);if(input){const value=p[key]??(key==="transport"?transport:key==="speed"?"standard":"");if(key==="reasoningEffort"&&value&&!Array.from(input.options).some(o=>o.value===value))input.insertAdjacentHTML('beforeend',`<option value="${escape(value)}">${escape(value)}</option>`);input.value=value;}}renderModelOptions(id);}
    if (rendered && previous !== JSON.stringify(collect(stored).localAgents)) invalidateCheck();
    rendered = true;
    refresh(true);
  }
  window.LocalAgentPanel={render,collect,refresh};
})();
