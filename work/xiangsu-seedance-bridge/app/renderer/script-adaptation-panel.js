"use strict";
window.createScriptAdaptationPanel=function({getProject,getSettings,importFile,generate,apply,onApplied,notify}){
  const dialog=document.createElement("dialog");dialog.className="script-adaptation-dialog";dialog.setAttribute("aria-labelledby","adaptTitle");
  dialog.innerHTML=`<header><div><small>REFERENCE SCRIPT ADAPTATION</small><h2 id="adaptTitle">仿写剧本 · 保留故事内核</h2></div><button type="button" data-adapt="close" aria-label="关闭改写面板">关闭</button></header>
  <p>上传完整剧本，改写人物、职业、场景与表层故事情节，保留故事内核、因果反转、结局和同一个带货产品。先预览，再另存新项目。</p>
  <p data-adapt="provider" class="adapt-provider"></p>
  <div class="adapt-grid"><label>参考原稿<textarea data-adapt="source" rows="12" placeholder="上传 TXT / Markdown，或粘贴完整剧本"></textarea></label><label>替换要求（可选）<textarea data-adapt="instructions" rows="12" placeholder="例如：外卖员改为快递员；车内救小孩改为马路救摔倒老人；换人物姓名和地点。若影响后文关系或证据，请列出待确认项。"></textarea></label></div>
  <div class="adapt-actions"><button type="button" data-adapt="upload">上传参考剧本</button><button type="button" data-adapt="current">使用当前剧本</button><button type="button" data-adapt="generate" class="primary-button">开始仿写</button></div>
  <p data-adapt="status" role="status" aria-live="polite">尚未提交。本步骤生成改写稿，内容审核集中在最终提示词确认页，不生成图片或视频。</p>
  <section data-adapt="result" hidden><h3>改写预览</h3><label>完整改稿<textarea data-adapt="draft" rows="16" readonly></textarea></label><details open><summary>替换清单与审核结果</summary><pre data-adapt="report"></pre></details><label class="adapt-ack" hidden><input type="checkbox" data-adapt="ack">我已查看待确认项，仍要保存此版本</label><button type="button" data-adapt="apply" class="primary-button">确认改稿 · 另存为新项目</button></section>`;
  document.body.append(dialog);
  const el=name=>dialog.querySelector(`[data-adapt="${name}"]`);let busy=false,draft=null,sourceProjectId="";
  const names={api:"软件文本 API",codex:"Codex",antigravity:"Antigravity",workbuddy:"WorkBuddy","deepseek-harness":"DeepSeek Harness",grokbuild:"Grok Build"};
  const message=s=>el("status").textContent=s;
  const setBusy=value=>{busy=value;for(const name of ["generate","upload","current","apply"])el(name).disabled=value;el("source").readOnly=value;el("instructions").readOnly=value;};
  el("close").onclick=()=>dialog.close();
  el("source").oninput=el("instructions").oninput=()=>{draft=null;el("result").hidden=true;};
  el("upload").onclick=async()=>{try{const r=await importFile();if(r?.canceled)return;if(!r?.ok)throw Error(r?.message||"读取文件失败，请重试。");el("source").value=r.text||"";el("source").oninput();message(`已读取 ${r.fileName||"参考剧本"}，尚未提交。`);}catch(e){message(e.message);}};
  el("current").onclick=()=>{el("source").value=getProject()?.script?.raw||"";el("source").oninput();message(el("source").value?"已复制当前剧本，原项目未改变。":"当前项目还没有剧本，请上传或粘贴。");};
  el("generate").onclick=async()=>{
    if(busy)return;if(!el("source").value.trim())return message("请先上传或粘贴完整剧本。");
    if(!getProject()?.id)return message("请先选择或新建一个项目，改写记录会保存在项目目录。");
    sourceProjectId=getProject().id;draft=null;el("result").hidden=true;setBusy(true);const started=Date.now();
    const timer=setInterval(()=>message(`正在保留故事内核并生成完整改写稿 · 已运行 ${Math.floor((Date.now()-started)/1000)} 秒。可关闭面板，任务继续；详细阶段见生产任务。`),1000);
    message("正在提交给所选写作 Agent…");
    try{const r=await generate(sourceProjectId,el("source").value,el("instructions").value);if(!r?.ok)throw Error(r?.message||"改写暂未完成，原稿已保留，请重试。");draft=r.draft;el("draft").value=draft.text;
      el("report").textContent=JSON.stringify({内核:draft.contract.kernel,替换表:draft.contract.replacements,剧情节点:draft.contract.beats,商品锁定:draft.contract.productLocks,待确认:draft.contract.warnings,机器覆盖检查:draft.audit.machine,Agent对照审核:draft.audit.semantic},null,2);
      el("result").hidden=false;el("ack").checked=false;el("ack").parentElement.hidden=Boolean((draft.audit.ok||draft.audit.status==='deferred')&&!draft.contract.warnings?.length);
      message(draft.audit.status==='deferred'?'改写稿已完成；内容审核将在全部提示词完成后的确认页自动进行。':draft.audit.ok&&!draft.contract.warnings?.length?"改写及对照审核已完成，请预览；模型审核不等于人工验收。":"改稿已保留，有待确认项，请先查看审核结果。");
    }catch(e){message(e.message||"改写暂未完成，原稿与分段记录已保留。");}finally{clearInterval(timer);setBusy(false);}
  };
  el("apply").onclick=async()=>{if(!draft||busy)return;if(!el("ack").parentElement.hidden&&!el("ack").checked)return message("请先查看待确认项，并勾选确认后再保存。");setBusy(true);try{const r=await apply(sourceProjectId,draft.id,el("ack").checked);if(!r?.ok)throw Error(r?.message||"保存失败，改稿仍在项目目录。");await onApplied(r.project);dialog.close();notify("改稿已另存新项目，原剧本与已有视频未改变。");}catch(e){message(e.message);}finally{setBusy(false);}};
  return {open(){const s=getSettings()?.localAgents||{},review=s.stages?.review;el("provider").textContent=`写作：${names[s.text]||"软件文本 API"} ｜ 审核：${names[review&&review!=="inherit"?review:s.text]||"软件文本 API"} ｜ 使用所选服务的账号额度`;if(!dialog.open)dialog.showModal();}};
};
