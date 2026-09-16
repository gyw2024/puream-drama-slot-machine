"use strict";

// Both workspaces share this controller. Local exports never take ownership
// of the global production UI, and project switches cannot redirect a result.
(function exposePostProductionPanel(global) {
  // Presentation adapter only: legacy dialogue arrays stay untouched in the
  // project store instead of being silently stringified as [object Object].
  function dramaDialogueText(value, characters = []) {
    if (Array.isArray(value)) return value.map(item => dramaDialogueText(item, characters)).filter(Boolean).join("\n");
    if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
    const text = value.text ?? value.spokenText;
    if (typeof text !== "string" || !text.trim()) return "";
    const token = String(value.speaker || value.speakerId || value.characterId || "");
    const speaker = characters.find(item => item.id === token || item.name === token)?.name || token;
    return speaker ? `${speaker}：${text}` : text;
  }
  const activeStatuses = new Set(["running", "pending", "queued", "cancelling", "canceling"]);
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "canceled", "interrupted"]);
  function safeMessage(error) {
    const message = String(error?.message || error || "").split(/\r?\n/)[0]
      .replace(/Error invoking remote method[^:]*:\s*/i, "")
      .replace(/(?:TypeError|ReferenceError|Error):\s*/g, "")
      .replace(/\b(?:sk-[\w-]{12,}|AIza[\w-]{20,})\b/g, "已隐藏凭据");
    if (/ENOSPC|磁盘空间/i.test(message)) return "磁盘可用空间不足。请更换草稿目录或释放空间后重试，原始素材未删除。";
    if (/EACCES|EPERM|权限/i.test(message)) return "无法写入所选目录。请填写一个可写的本地草稿目录后重试，原始素材未删除。";
    if (/cancel|abort|取消/i.test(message)) return "本地后期已取消，原始视频和已完成的草稿保留，可重新开始。";
    if (/[\u3400-\u9fff]/.test(message)) return message.slice(0, 500);
    return "本地后期未完成。请刷新状态、检查素材和草稿目录后重试；原始素材保留。";
  }
  function createPostProductionPanel(options) {
    const host = options.host;
    if (!host) return { render() {}, run() {}, isRunning() { return false; } };
    const prefix = String(host.id || "post-production").replace(/[^a-z0-9_-]/gi, "");
    const pending = new Map();
    const errors = new Map();
    const roots = new Map();
    const pollers = new Map();
    let shownProjectId = "";
    let cancelPending = false;
    host.classList.add("post-production-panel");
    host.innerHTML = `<div class="post-panel-heading"><div><span class="post-kicker">EDITABLE · LOCAL DRAFT</span><h3>剪映可编辑草稿</h3><p>视频、剧情音效和环境音分轨保存，默认不生成字幕轨。音效不烧录进粗剪视频，进入剪映后可分别修改。</p></div><span class="post-local-badge">本地处理 · 不生成新素材</span></div>
      <div class="post-task-state" role="status" aria-live="polite" data-post="status">请选择项目。</div>
      <div class="post-panel-actions"><button class="outline-button" type="button" data-post-action="stitchProject">生成无叠加音效粗剪</button><button class="primary-button" type="button" data-post-action="exportJianyingDraft">一键生成剪映草稿</button><button class="outline-button" type="button" data-post-action="cancelPostProduction" disabled>取消本地后期</button><button class="outline-button" type="button" data-post-action="refresh">刷新状态</button></div>
      <p class="post-panel-hint" data-post="hint">可先粗剪再导出，也可直接导出已有分镜；不会自动抽卡或扣费。</p>
      <details class="post-destination"><summary>草稿保存位置（留空自动检测）</summary><label for="${prefix}-root">本机剪映草稿根目录<input id="${prefix}-root" type="text" data-post="root" spellcheck="false" autocomplete="off" placeholder="留空自动检测；也可填写可写的本地目录"></label><p>项目目录始终保留一份完整草稿。未检测到剪映目录时仍可导出，不会中断制作。</p></details>
      <p class="post-panel-error" data-post="error" role="alert" hidden></p>
      <div class="post-draft-result" data-post="result" hidden><b data-post="result-title">草稿已生成</b><p data-post="counts"></p><p data-post="timing"></p><label for="${prefix}-path">项目内草稿目录<input id="${prefix}-path" data-post="path" type="text" readonly></label><p class="post-native-path" data-post="native-path"></p><div class="post-panel-actions"><button class="outline-button" type="button" data-post-action="copy">复制草稿路径</button><button class="outline-button" type="button" data-post-action="reveal">定位草稿目录</button></div><details data-post="warnings" hidden><summary data-post="warning-title">查看需要核对的项目</summary><ul data-post="warning-list"></ul></details></div>`;
    const find = name => host.querySelector(`[data-post="${name}"]`);
    const button = name => host.querySelector(`[data-post-action="${name}"]`);
    if (options.hideRoughCut) button("stitchProject").hidden = true;
    const getProject = () => options.getProject?.() || null;
    function isRunning(project = getProject()) {
      return Boolean(project?.id && (pending.has(project.id) || activeStatuses.has(project.postProductionTask?.status)));
    }
    function render() {
      const project = getProject();
      const id = project?.id || "";
      if (shownProjectId !== id) {
        if (shownProjectId) roots.set(shownProjectId, find("root").value);
        shownProjectId = id;
        find("root").value = roots.get(id) || "";
      }
      const task = project?.postProductionTask || {};
      const operation = pending.get(id);
      if (operation && terminalStatuses.has(task.status) && task.updatedAt !== operation.initialTaskUpdatedAt && new Date(task.updatedAt).getTime() >= operation.startedAt) pending.delete(id);
      const busy = isRunning(project);
      const hasShots = Boolean(project?.shots?.length);
      const count = project?.shots?.length || 0;
      const error = errors.get(id) || (task.status === "failed" ? safeMessage(task.message) : "");
      find("status").textContent = !id ? "请选择或新建项目后开始。" : busy
        ? (task.message || (operation?.method === "stitchProject" ? "正在整理粗剪视频" : "正在整理剪映草稿")) + "；可切换页面，任务在后台继续。"
        : task.status === "interrupted" ? "上次本地后期已中断，原始素材保留；可以重新开始。"
          : task.status === "cancelled" || task.status === "canceled" ? "本地后期已取消，原始素材保留；可以重新开始。"
          : task.status === "failed" ? "上次本地后期未完成；修正下方提示后可重试。"
            : task.status === "completed" ? (task.message || "本地后期已完成。")
              : hasShots ? `当前项目 ${count} 个分镜。导出时会检查所选视频文件。` : "尚无分镜；请先导入或创建分镜。";
      host.dataset.postState = busy ? "running" : error ? "failed" : task.status || "idle";
      button("stitchProject").disabled = !hasShots || busy;
      button("exportJianyingDraft").disabled = !hasShots || busy;
      button("cancelPostProduction").disabled = !busy || cancelPending;
      button("refresh").disabled = !id;
      find("error").hidden = !error;
      find("error").textContent = error;
      find("hint").textContent = project?.roughCutVideoPath && !project?.finalVideoStale
        ? "导出将优先使用与当前镜头版本一致的无叠加音效粗剪；独立音效、环境音与字幕保留在剪映轨道。"
        : "可直接导出已有分镜；如需继承片头净音，请先生成粗剪。缺少视频会列明镜号，不会自动抽卡。";
      const draft = project?.jianyingDraftExport;
      find("result").hidden = !draft?.draftPath;
      if (draft?.draftPath) {
        find("result-title").textContent = draft.stale ? "草稿已保存 · 镜头后来有修改，请重新导出最新版本" : "可编辑草稿已保存";
        const counts = draft.counts || {};
        find("counts").textContent = `${Number(counts.videos) || 0} 段视频 · ${Number(counts.audioTracks) || 0} 条独立音轨 · ${Number(counts.sfxCues) || 0} 个音效片段 · ${Number(counts.subtitles) || 0} 条字幕`;
        find("timing").textContent = /^(asr-)/.test(draft.subtitleTimingSource || "")
          ? "字幕使用文本核对通过的语音识别时间戳；首次打开剪映后仍请预览核对。"
          : draft.subtitleTimingSource === "none" ? "没有可用对白，未编造字幕；可在剪映内手动创建。" : "字幕按完整对白计划或估算排时，尚非成片语音实测；请在剪映内预览并校时。";
        find("path").value = draft.draftPath;
        find("native-path").textContent = draft.registered
          ? `已复制到剪映草稿目录：${draft.installedDraftPath || "已检测目录"}。请在剪映首页刷新后打开；未自动操作剪映界面。`
          : "未写入剪映默认目录，项目内完整草稿已保留；填写本机剪映草稿根目录后可再次导出。";
        const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
        find("warnings").hidden = !warnings.length;
        find("warning-title").textContent = `查看 ${warnings.length} 项核对说明`;
        const signature = JSON.stringify(warnings);
        if (find("warning-list").dataset.signature !== signature) {
          find("warning-list").replaceChildren(...warnings.map(value => { const li = document.createElement("li"); li.textContent = safeMessage(value); return li; }));
          find("warning-list").dataset.signature = signature;
        }
      }
      options.onState?.({ project, busy });
    }
    async function refresh(projectId) {
      await options.refresh?.(projectId);
      render();
    }
    function stopPolling(projectId, operation) {
      const current = pollers.get(projectId);
      if (!current || (operation && current.operation !== operation)) return;
      clearInterval(current.timer);
      pollers.delete(projectId);
    }
    function startPolling(projectId, operation) {
      stopPolling(projectId);
      const timer = setInterval(() => {
        if (pending.get(projectId) !== operation) return stopPolling(projectId, operation);
        refresh(projectId).catch(() => {
          // The action promise owns terminal error presentation. A transient
          // refresh failure must not hide an active local media operation.
        });
      }, 900);
      pollers.set(projectId, { operation, timer });
    }
    async function run(method) {
      const project = getProject();
      if (!project?.id) { options.notify?.("请先选择项目", "error"); return; }
      const id = project.id;
      if (isRunning(project)) { options.notify?.("当前项目已有本地后期任务，可取消或切换项目", "warning"); return; }
      const operation = { method, startedAt: Date.now(), initialTaskUpdatedAt: project.postProductionTask?.updatedAt };
      pending.set(id, operation);
      errors.delete(id);
      render();
      startPolling(id, operation);
      try {
        const args = method === "exportJianyingDraft" ? [id, { draftRoot: find("root").value.trim() || undefined }] : [id];
        const result = await options.invoke(method, ...args);
        if (result?.ok === false) throw new Error(result.message || "本地后期未完成，请刷新状态后重试。");
        options.notify?.(method === "exportJianyingDraft" ? "剪映草稿已保存，音效与字幕均可独立编辑" : "无叠加音效粗剪已完成", "success");
      } catch (error) {
        errors.set(id, safeMessage(error));
        options.notify?.(safeMessage(error), "error");
      } finally {
        stopPolling(id, operation);
        if (pending.get(id) === operation) pending.delete(id);
        try { await refresh(id); } catch { errors.set(id, "后期状态暂未刷新，请点击“刷新状态”；已有输出不受影响。"); }
        render();
      }
    }
    host.addEventListener("click", async event => {
      const target = event.target.closest("[data-post-action]");
      if (!target || target.disabled) return;
      const action = target.dataset.postAction;
      const project = getProject();
      if (action === "stitchProject" || action === "exportJianyingDraft") { await run(action); return; }
      try {
        if (action === "refresh") { errors.delete(project?.id); await refresh(project?.id); }
        else if (action === "cancelPostProduction") {
          cancelPending = true; render();
          const result = await options.invoke("cancelPostProduction", project.id);
          if (result?.ok === false) throw new Error(result.message);
          const cancellation = result?.result || result;
          if (cancellation?.cancelled === false || cancellation?.recovered === true) pending.delete(project.id);
          options.notify?.(cancellation?.message || "已请求取消，原始素材保留", "info");
          await refresh(project.id);
        } else if (action === "copy") {
          const path = project?.jianyingDraftExport?.installedDraftPath || project?.jianyingDraftExport?.draftPath;
          try { await navigator.clipboard.writeText(path); options.notify?.("草稿路径已复制", "success"); }
          catch { find("path").focus(); find("path").select(); options.notify?.("请按 Ctrl+C 复制已选中的草稿路径", "info"); }
        } else if (action === "reveal") await options.reveal?.(project?.jianyingDraftExport?.installedDraftPath || project?.jianyingDraftExport?.draftPath);
      } catch (error) { errors.set(project?.id, safeMessage(error)); options.notify?.(safeMessage(error), "error"); }
      finally { cancelPending = false; render(); }
    });
    render();
    return { render, run, isRunning };
  }
  global.createPostProductionPanel = createPostProductionPanel;
  global.dramaDialogueText = dramaDialogueText;
})(window);
