'use strict';
(()=>{
 const panel=document.querySelector('#agentActivityPanel');if(!panel)return;
 panel.tabIndex=0;panel.setAttribute('aria-label','软件与 Agent 实时运行详情');
 const view=window.AgentActivityView,scope=location.pathname.includes('simple-mode')?'simple':'workbench';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={workbuddy:'WorkBuddy',codex:'Codex',antigravity:'Antigravity','deepseek-harness':'DeepSeek Harness',grokbuild:'Grok Build'};
 let timer,stopped=false,jobs=[],failure=false,lastList=0;
 const main=document.querySelector('main.main-stage,main.workspace');
 const strip=document.createElement('section');strip.id='productionActivitySummary';strip.setAttribute('aria-label','当前制作步骤');strip.hidden=true;main?.prepend(strip);
 function place(){if(scope==='simple')return;const queue=document.querySelector('#automationQueuePanel');if(window.matchMedia('(max-width: 1180px)').matches){if(main&&panel.parentElement!==main)strip.after(panel);}else if(queue&&panel.parentElement!==queue.parentElement)queue.after(panel);}
 place();window.addEventListener('resize',place);
 function render(){
  const id=document.querySelector('#projectSelect')?.value,project=window.runActivityProject;
  if(!project||project.id!==id){panel.hidden=true;strip.hidden=true;return;}
  const visible=view.select(jobs,id),s=view.summary(project,jobs);strip.hidden=false;panel.hidden=false;
  const headline=failure?'状态同步暂时中断':s.state;
  strip.innerHTML=`<div class="run-step-heading"><span>${esc(headline)}</span><strong>${esc(s.title)}</strong>${s.activeJobs.length>1?`<b>${s.activeJobs.length} 项同时运行</b>`:''}</div><p>${esc(s.saved)}</p><p><b>后续：</b>${esc(s.next)}</p>${failure?'<p>下方为上次读取的状态；正在重新连接，不会重新提交生成。</p>':''}`;
  const auto=project.automation||{};
  const note=view.message(s.message);const reason=note?`<p class="agent-activity-wait">${esc(note)}</p>`:'';
  const software=`<section class="agent-activity-card"><div class="agent-activity-title"><strong>软件当前步骤</strong><span>${esc(headline)}</span></div><h3>${esc(s.title)}</h3><p>${esc(s.work.purpose)}</p>${reason}<p><b>已保存：</b>${esc(s.saved)}</p><p><b>后续：</b>${esc(s.next)}</p>${!s.work.known?`<small>步骤标识：${esc(s.work.key||'尚未启动')}</small>`:''}</section>`;
  const cards=visible.map(job=>{
   const p=view.present(job),w=view.describe(job.operation,project),part=job.deliveryProgress||{};
   const delivery=[Number.isFinite(part.savedShots)?`已保存 ${part.savedShots} 镜`:null,Number.isFinite(part.savedParts)?`已保存 ${part.savedParts} 段`:null,part.savedFiles?.length?`已保存 ${part.savedFiles.length} 个结果文件`:null].filter(Boolean).join(' · ');
   // Two separate phase lines. "Agent 已结束" and "App 仍在补交" must never be
   // collapsed back into one spinner, or a finished Agent looks like it is still
   // thinking while the application keeps resubmitting the same result.
   const deliveryLine=p.delivering
     ?`<p class="agent-activity-wait"><b>Agent 本次调用已结束</b>；应用仍在补交同一任务的 MCP 结果（第 ${p.deliveryAttempts||1}/${p.deliveryMaxAttempts} 次），已有草稿保留。项目尚未完成。</p>`
     :p.exhausted
      ?`<p class="agent-activity-wait"><b>补交已达上限（${p.deliveryAttempts}/${p.deliveryMaxAttempts} 次），本阶段判定失败</b>；已保存的草稿与分片全部保留，可查看原因后从断点继续。</p>${p.deliveryReason?`<p class="agent-activity-wait">MCP 拒绝原因：${esc(p.deliveryReason)}</p>`:''}`
      :p.agentEnded&&!p.ended
       ?`<p><b>Agent 本次调用已结束</b>${p.agentEndedAt?`（${esc(new Date(p.agentEndedAt).toLocaleTimeString('zh-CN'))}）`:''}；应用正在核对并保存结果。</p>`
       :'';
   return `<section class="agent-activity-card" data-phase="${esc(p.phase)}" data-delivery="${esc(p.exhausted?'exhausted':p.delivering?'delivering':p.agentEnded?'agent-ended':'')}"><div class="agent-activity-title"><strong>${esc(w.label)}</strong><span>${esc(failure?'等待同步':p.label)}</span></div><p>${esc(w.purpose)}</p><p class="agent-activity-model">${esc(names[job.agentId]||job.agentId)} · ${esc(job.reportedModel||job.execution?.model||'当前模型')}</p><div class="agent-activity-metrics"><span>本次任务已用 <b>${Math.floor(p.elapsed/60)}分${p.elapsed%60}秒</b></span></div>${deliveryLine}<p>${p.characters?`本次调用收到 ${p.characters.toLocaleString()} 字符（不代表全项目字数）`:'本次调用尚未收到结果文本；上方已保存内容不受影响。'}</p>${delivery?`<p>${esc(delivery)}</p>`:''}${p.detail?`<p class="agent-activity-wait">${esc(p.detail)}</p>`:''}${(p.ended||p.delivering)&&job.message?`<p>${esc(job.message)}</p>`:''}<small>${p.ended?'本次 Agent 调用已结束，项目是否完成以上方状态为准':p.delivering?'Agent 阶段已结束，应用补交阶段的进度见上方。':p.seconds===null?'等待首个状态信号':`最近活动：${p.seconds} 秒前`} · 每 2 秒刷新</small><small>任务 ${esc(job.id)}${!w.known?` · 步骤 ${esc(job.operation)}`:''}</small></section>`;
  }).join('');
  const media=s.media.map(j=>`<section class="agent-activity-card"><div class="agent-activity-title"><strong>${esc(j.label)} ${esc(j.entity||'')}</strong><span>${esc(j.progress)}</span></div>${j.message?`<p>${esc(j.message)}</p>`:''}<small>媒体任务 ${esc(j.id)}</small></section>`).join('');
  panel.innerHTML=software+cards+media;
 }
 async function syncProjectList(){
  if(scope!=='workbench'||Date.now()-lastList<10000)return;lastList=Date.now();
  const response=await window.dramaSlot.workbench.listProjects();if(!response?.ok)return;
  const select=document.querySelector('#projectSelect'),selected=select?.value;if(!select||document.activeElement===select)return;
  const items=response.projects||[];if(!items.some(p=>p.id===selected))return;
  const signature=items.map(p=>`${p.id}:${p.title}:${p.status}`).join('|');if(select.dataset.runListSignature===signature)return;
  select.replaceChildren(...items.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.title;o.disabled=p.status==='corrupted';return o;}));select.value=selected;select.dataset.runListSignature=signature;
 }
 async function refresh(){const id=document.querySelector('#projectSelect')?.value;try{const response=await window.dramaSlot.localAgents.call('jobs',scope);if(!response?.ok)throw Error('status unavailable');if(id!==document.querySelector('#projectSelect')?.value)return;jobs=response.jobs||[];failure=false;render();await syncProjectList().catch(()=>{});}catch{if(id===document.querySelector('#projectSelect')?.value){failure=true;render();}}finally{if(!stopped)timer=setTimeout(refresh,2000);}}
 document.querySelector('#projectSelect')?.addEventListener('change',()=>{panel.hidden=true;strip.hidden=true;});
 window.addEventListener('run-activity-project',render);
 window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);},{once:true});refresh();
})();
