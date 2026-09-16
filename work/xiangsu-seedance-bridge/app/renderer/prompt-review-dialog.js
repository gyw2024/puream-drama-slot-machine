(function attachPromptReviewDialog(global) {
  "use strict";

  const groupLabels = Object.freeze({
    characters: "人物",
    scenes: "场景",
    objects: "物品 / 商品",
    storyboards: "分镜图",
    videos: "分镜视频"
  });
  const knownGroups = new Set(Object.keys(groupLabels));
  const groupOrder = Object.freeze({ characters: 0, scenes: 1, objects: 2, storyboards: 3, videos: 4 });
  const stageOrder = Object.freeze({
    character_sheet: 0,
    character_three_view: 1,
    character_intro: 2,
    character_video: 3,
    scene_asset: 0,
    prop_asset: 0,
    wardrobe_asset: 1,
    product_asset: 2,
    storyboard_sheet: 0,
    storyboard_start: 1,
    storyboard_end: 2,
    shot_video: 0
  });
  const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  function createPromptReviewDialog(options) {
    const root = document.querySelector("#promptReviewDialog");
    if (!root) return { sync() {}, open() {}, close() {}, isOpen: () => false };
    const list = root.querySelector("#promptReviewList");
    const message = root.querySelector("#promptReviewDialogMessage");
    const statusArea=document.createElement('div');
    statusArea.className='prompt-review-status-area';
    message.before(statusArea);statusArea.append(message);
    const drafts = new Map();
    const draftBases = new Map();
    let project = null;
    let filter = "all";
    let autoOpenedKey = "";
    let boundProjectKey = "";
    let submitting = false;
    let renderedSignature = "";

    const reviewKey = value => `${value?.id || ""}:${value?.promptReview?.version || ""}:${value?.promptReview?.productionRevision || ""}:${value?.promptReview?.generatedAt || ""}:${value?.promptReview?.sourceFingerprint || ""}`;
    const numericOrder = item => {
      const tokens = [item?.entityId, item?.label, item?.id].map(value => String(value || ""));
      for (const token of tokens) {
        const shot = token.match(/(?:^|\b|镜头\s*)(?:S|SC|C)?\s*0*(\d{1,6})(?:\b|\D)/i);
        if (shot) return Number(shot[1]);
      }
      return Number.MAX_SAFE_INTEGER;
    };
    const orderedItems = value => (Array.isArray(value) ? value : [])
      .map((item, sourceIndex) => ({ item, sourceIndex }))
      .sort((left, right) => {
        const leftGroup = groupOrder[groupFor(left.item)] ?? 99;
        const rightGroup = groupOrder[groupFor(right.item)] ?? 99;
        if (leftGroup !== rightGroup) return leftGroup - rightGroup;
        const entityDifference = numericOrder(left.item) - numericOrder(right.item);
        if (entityDifference) return entityDifference;
        const stageDifference = (stageOrder[left.item?.stage] ?? 99) - (stageOrder[right.item?.stage] ?? 99);
        if (stageDifference) return stageDifference;
        return String(left.item?.label || left.item?.id || "").localeCompare(String(right.item?.label || right.item?.id || ""), "zh-CN", { numeric: true })
          || left.sourceIndex - right.sourceIndex;
      })
      .map(entry => entry.item);
    const activeItems = () => orderedItems(project?.promptReview?.items);
    const editorBusy = () => ['reviewing','editing'].includes(project?.promptReview?.editor?.status);
    const conflicted = item => drafts.has(item.id) && draftBases.has(item.id) && draftBases.get(item.id)!==storedDisplayPrompt(item);
    const storedDisplayPrompt = item => String(item?.displayPrompt || item?.prompt || "");
    const promptFor = item => drafts.has(item.id) ? drafts.get(item.id) : storedDisplayPrompt(item);
    const groupFor = item => knownGroups.has(item?.group) ? item.group : "objects";
    const setMessage = (text, tone = "") => {
      message.textContent = String(text || "");
      message.className = `prompt-review-message${tone === "error" ? " is-error" : tone === "busy" ? " is-busy" : ""}`;
    };
    function count(group) {
      return activeItems().filter(item => groupFor(item) === group).length;
    }

    function applyFilter() {
      const query = String(root.querySelector("#promptReviewSearch")?.value || "").trim().toLowerCase();
      list.querySelectorAll(".prompt-review-item").forEach(card => {
        const groupMatch = filter === "all" || card.dataset.group === filter;
        const queryMatch = !query || String(card.dataset.search || "").includes(query);
        card.hidden = !(groupMatch && queryMatch);
      });
      root.querySelectorAll("[data-prompt-review-filter]").forEach(button => {
        button.classList.toggle("is-active", button.dataset.promptReviewFilter === filter);
      });
    }

    function render() {
      const review = project?.promptReview || {};
      // Background project updates must not destroy editors, selection or scroll.
      const signature = JSON.stringify([project?.id, review, submitting, [...drafts]]);
      if (signature === renderedSignature) return;
      renderedSignature = signature;
      const editor=review.editor||{};
      if(editor.status){
        setMessage(editor.message||'提示词已保存');
        message.dataset.pendingNotice='true';
      } else if (review.status === "pending") {
        setMessage("提示词仍在准备，当前内容已保留；全部完成后可选择 AI 审核校正。");
        message.dataset.pendingNotice = "true";
      } else if (message.dataset.pendingNotice === "true") {
        setMessage("");
        delete message.dataset.pendingNotice;
      }
      const previousScroll = list.scrollTop;
      const editorState = new Map([...list.querySelectorAll(".prompt-review-text")].map(node => [node.dataset.promptReviewText, { scroll: node.scrollTop, start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node }]));
      const items = activeItems();
      const hasDirtyDrafts = items.some(item => drafts.has(item.id) && drafts.get(item.id) !== storedDisplayPrompt(item));
      const confirmed = items.filter(item => window.ReviewReceiptState.confirmed(item) && (!drafts.has(item.id) || drafts.get(item.id) === storedDisplayPrompt(item))).length;
      root.querySelector("#promptReviewConfirmedCount").textContent = `${confirmed} / ${items.length}`;
      for (const group of knownGroups) {
        const node = root.querySelector(`[data-prompt-review-count="${group}"]`);
        if (node) node.textContent = String(items.filter(item => groupFor(item) === group).length);
      }
      root.querySelector("#promptReviewFooterStatus").textContent = window.ReviewReceiptState.approved(review) && !hasDirtyDrafts
        ? `已确认全部 ${items.length} 项提示词`
        : `已确认 ${confirmed} 项，尚有 ${Math.max(0, items.length - confirmed)} 项待确认`;
      root.querySelector("#confirmAllPrompts").disabled = submitting || editorBusy() || review.status === "pending" || (window.ReviewReceiptState.approved(review) && !hasDirtyDrafts) || !items.length || items.some(conflicted);
      let sourceNotes = root.querySelector('[data-source-review-advisories]');
      if (!sourceNotes) { sourceNotes = document.createElement('p'); sourceNotes.dataset.sourceReviewAdvisories = 'true'; sourceNotes.className = 'settings-note'; sourceNotes.setAttribute('role', 'status'); statusArea.append(sourceNotes); }
      const notes = (review.sourceAdvisories || []).map(note => typeof note === 'string' ? note : note.message || note.evidence || '').filter(Boolean);
      sourceNotes.textContent = notes.length ? `Agent 源稿审查记录：${notes.join('；')}` : '';
      sourceNotes.hidden = !notes.length;
      let editorActions=root.querySelector('[data-editor-actions]');
      if(!editorActions){editorActions=document.createElement('div');editorActions.dataset.editorActions='true';editorActions.className='settings-note';statusArea.append(editorActions);}
      const proposal=review.proposal,changes=proposal?.changes||[];
      const pending=(proposal?.editor?.unresolved||editor.unresolved||[]).map(row=>[row.reason,row.neededEvidence].filter(Boolean).join('：'));
      editorActions.innerHTML=`<p>AI 审核校正为可选操作；先查看建议，再决定是否应用，原内容不会自动覆盖。</p>${pending.length?`<p role="status">${pending.map(escapeHtml).join('；')}</p>`:''}<div class="card-actions"><button type="button" class="outline-button" data-continue-prompt-editor ${submitting||editorBusy()||review.status==='pending'||hasDirtyDrafts?'disabled':''}>${proposal?'重新 AI 审核校正':'AI 审核校正'}</button>${proposal?.status==='ready'?`<button type="button" class="primary-button" data-apply-prompt-proposal ${submitting||editorBusy()||hasDirtyDrafts?'disabled':''}>${changes.length?'一键应用全部修改':'采用审核结论'}</button>`:''}</div>${hasDirtyDrafts?'<p>有未保存编辑，请先保存并确认对应条目，再审核或应用建议。</p>':''}${proposal?.status==='applied'?'<p role="status">修改已应用，请查看当前提示词并确认。</p>':''}${changes.length?`<details open><summary>${changes.length} 处修改建议 · 修改前后与原因</summary>${changes.map(c=>`<div><b>${escapeHtml(c.owner?.itemId?(items.find(i=>i.id===c.owner.itemId)?.label||'提示词'):'源执行稿与关联信息')}</b><p>修改原因：${escapeHtml((c.reasons||[]).join('；'))}</p><pre style="max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere">修改前：${escapeHtml(typeof c.before==='string'?c.before:JSON.stringify(c.before))}\n\n修改后：${escapeHtml(typeof c.after==='string'?c.after:JSON.stringify(c.after))}</pre></div>`).join('')}</details>`:''}`;
      const renderedItems = items.map((item, index) => {
        const displayPrompt = promptFor(item);
        const executionPrompt = String(item.prompt || "");
        const group = groupFor(item);
        const isEnglish = item.executionLanguage === "en" || item.language === "en";
        const isConfirmed = window.ReviewReceiptState.confirmed(item);
        const conflict=conflicted(item);
        const dirty = drafts.has(item.id) && displayPrompt !== storedDisplayPrompt(item);
        const search = `${item.label || ""} ${item.stage || ""} ${displayPrompt} ${executionPrompt}`.toLowerCase();
        const languageBadge = isEnglish
          ? '<span class="prompt-review-language is-english">英文执行 · 当前编辑中文译文</span>'
          : '<span class="prompt-review-language">中文执行稿</span>';
        const executionPreview = isEnglish
          ? `<details class="prompt-review-execution" data-execution-length="${executionPrompt.length}"><summary>查看${dirty ? "修改前的" : "当前"}完整英文执行稿（${executionPrompt.length} 字）</summary><pre>${escapeHtml(executionPrompt)}</pre></details>`
          : "";
        const agentAuditNote = item.agentAudit ? `<p class="settings-note" tabindex="0" aria-label="Agent 审核意见">Agent 审核（${escapeHtml(item.agentAudit.source)}）：${escapeHtml(dirty ? "提示词已修改，原审核结论不再代表当前内容" : window.ReviewReceiptState.label(item.agentAudit))}</p>` : "";
        const actionHint = isEnglish
          ? (dirty
            ? `中文已修改；确认时会重新编译为完整英文执行稿。中文 ${displayPrompt.length} 字 / 当前执行稿 ${executionPrompt.length} 字，均完整显示、不截断。`
            : `编辑中文即可；系统会在确认时同步更新英文执行稿。中文 ${displayPrompt.length} 字 / 执行稿 ${executionPrompt.length} 字，均完整显示、不截断。`)
          : `这里就是实际执行稿，共 ${displayPrompt.length} 字，完整显示；完整文本不会省略或截断。`;
        const confirmLabel = conflict ? "保留我的编辑并审核" : isEnglish
          ? (isConfirmed && !dirty ? "重新确认中英文本条" : "保存中文并重编译英文")
          : (isConfirmed && !dirty ? "重新确认本条" : "保存并确认本条");
        const html = `<article class="prompt-review-item group-${group}${isConfirmed ? " is-confirmed" : ""}${dirty ? " is-dirty" : ""}" data-item-id="${escapeHtml(item.id)}" data-group="${group}" data-order="${index + 1}" data-search="${escapeHtml(search)}">
          <div class="prompt-review-item-head"><div class="prompt-review-item-title"><span class="prompt-review-group-kicker">${escapeHtml(groupLabels[group])}</span><b>${index + 1}. ${escapeHtml(item.label || item.id)}</b><span>${escapeHtml(item.stage || "")}</span></div><i class="prompt-review-item-state">${dirty ? "已修改 · 待确认" : isConfirmed ? "已确认" : "待确认"}</i></div>
          ${languageBadge}
          ${agentAuditNote}
          ${conflict?`<details open class="settings-note"><summary>Agent 已更新此条，您的未保存编辑仍保留</summary><pre style="max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(storedDisplayPrompt(item))}</pre><button type="button" class="outline-button" data-use-agent-edit="${escapeHtml(item.id)}">采用 Agent 修改</button></details>`:''}
          ${item.editOrigin==='agent'?'<p class="settings-note">Agent 已定点修改，请确认当前版本。</p>':''}<label class="prompt-review-editor-label"><span>${isEnglish ? `完整中文查看与编辑稿（${displayPrompt.length} 字）` : `完整提示词（${displayPrompt.length} 字）`}</span><textarea class="prompt-review-text" data-prompt-review-text="${escapeHtml(item.id)}" data-display-length="${displayPrompt.length}" aria-label="${escapeHtml(item.label || item.id)}${isEnglish ? "完整中文译文" : "完整提示词"}" spellcheck="false" ${editorBusy()?'readonly aria-readonly="true"':''}>${escapeHtml(displayPrompt)}</textarea></label>
          ${executionPreview}
          <div class="prompt-review-item-actions"><span>${escapeHtml(actionHint)}</span><button type="button" class="outline-button" data-confirm-prompt-item="${escapeHtml(item.id)}" ${submitting || editorBusy() || review.status === "pending" ? "disabled" : ""}>${confirmLabel}</button></div>
        </article>`;
        return html;
      });
      if (!renderedItems.length) {
        list.innerHTML = '<div class="empty-hint">当前项目还没有可审阅的提示词。</div>';
      } else {
        // One flat DOM list preserves the authored sequence. CSS Grid owns
        // column placement, so visual reading order can never diverge from
        // keyboard, screen-reader or confirmation order.
        list.innerHTML = renderedItems.join("");
      }
      applyFilter();
      list.scrollTop = previousScroll;
      list.querySelectorAll(".prompt-review-text").forEach(node => {
        const saved = editorState.get(node.dataset.promptReviewText);
        if (!saved) return;
        if (saved.focused) { node.focus({ preventScroll: true }); node.setSelectionRange(saved.start, saved.end); }
        node.scrollTop = saved.scroll;
      });
    }

    async function completeIfApproved(nextProject) {
      if (!window.ReviewReceiptState.approved(nextProject?.promptReview)) return;
      drafts.clear();draftBases.clear();
      setMessage("全部提示词已保存并确认；英文条目已经由中文编辑稿重新编译，后续生成只使用本次确认的执行稿。");
      if (typeof options.onApproved === "function") await options.onApproved(nextProject);
    }

    async function confirmItem(itemId) {
      if (submitting || editorBusy() || !project || project.promptReview?.status==='pending') return;
      const textarea = list.querySelector(`[data-prompt-review-text="${CSS.escape(itemId)}"]`);
      const prompt = String(textarea?.value || "").trim();
      if (!prompt) {
        setMessage("提示词不能为空，请补充完整后再确认这一条。", "error");
        textarea?.focus();
        return;
      }
      const item = activeItems().find(entry => entry.id === itemId);
      submitting = true;
      render();
      setMessage(item?.executionLanguage === "en" ? "正在把中文编辑稿重新编译为英文执行稿…" : "正在保存并确认本条完整提示词…", "busy");
      try {
        const result = await options.confirmItem(project.id, itemId, prompt);
        if (!result?.ok) throw Object.assign(new Error(result?.message || "确认失败"), { code: result?.code || "PROMPT_REVIEW_CONFIRM_FAILED" });
        project = result.project;
        if(project.promptReview?.manualEditConflict){options.setProject?.(project);setMessage('文档已更新，您的编辑仍保留，请查看差异后再次保存。');return;}
        drafts.delete(itemId);draftBases.delete(itemId);
        if (typeof options.setProject === "function") options.setProject(project);
        const savedItem=activeItems().find(entry=>entry.id===itemId);
        setMessage(window.ReviewReceiptState.confirmed(savedItem) ? `“${savedItem?.label || "该提示词"}”已保存并确认。` : `已保存；${window.ReviewReceiptState.label(savedItem?.agentAudit)}。`);
        await completeIfApproved(project);
      } catch (error) {
        setMessage(error.message || "确认失败，系统会保留当前编辑内容。", "error");
        if (typeof options.notify === "function") options.notify(error.message || "确认失败", "error");
      } finally {
        submitting = false;
        render();
      }
    }

    async function confirmAll() {
      if (submitting || editorBusy() || !project || project.promptReview?.status === "pending") return;
      if(activeItems().some(conflicted)){setMessage('请先逐条选择保留您的编辑或采用 Agent 修改，再确认全部。');return;}
      const entries = activeItems().map(item => ({ id: item.id, prompt: promptFor(item).trim() }));
      const empty = entries.find(entry => !entry.prompt);
      if (empty) {
        filter = "all";
        render();
        setMessage("存在空白提示词，请补充完整后再一键确认。", "error");
        list.querySelector(`[data-prompt-review-text="${CSS.escape(empty.id)}"]`)?.focus();
        return;
      }
      submitting = true;
      render();
      setMessage(`正在保存全部 ${entries.length} 项提示词，并重新编译发生修改的英文执行稿…`, "busy");
      try {
        const result = await options.confirmAll(project.id, entries);
        if (!result?.ok) throw Object.assign(new Error(result?.message || "确认失败"), { code: result?.code || "PROMPT_REVIEW_CONFIRM_FAILED" });
        project = result.project;
        if(project.promptReview?.manualEditConflict){options.setProject?.(project);setMessage('文档已更新，您的编辑仍保留，请查看差异后再次保存。');return;}
        drafts.clear();draftBases.clear();
        if (typeof options.setProject === "function") options.setProject(project);
        await completeIfApproved(project);
      } catch (error) {
        setMessage(error.message || "确认失败，系统会保留全部编辑内容。", "error");
        if (typeof options.notify === "function") options.notify(error.message || "确认失败", "error");
      } finally {
        submitting = false;
        render();
      }
    }

    function open() {
      if (!project?.promptReview?.items?.length) return;
      render();
      if (!root.open) {
        root.showModal();
        root.scrollTop = 0;
        list.scrollTop = 0;
        window.scrollTo(0, 0);
      }
      root.querySelector("#promptReviewSearch")?.focus();
    }

    function close() {
      if (root.open) root.close();
      if (project?.promptReview?.status !== "approved") {
        const persistentButton = document.querySelector("#pendingPromptReviewButton");
        if (persistentButton && !persistentButton.hidden) persistentButton.focus();
      }
    }

    root.addEventListener("input", event => {
      const textarea = event.target.closest("[data-prompt-review-text]");
      if (textarea) {
        const id=textarea.dataset.promptReviewText;if(!draftBases.has(id)){const item=activeItems().find(i=>i.id===id);draftBases.set(id,storedDisplayPrompt(item));}
        drafts.set(id, textarea.value);
        const dirtyNow=[...drafts].some(([key,value])=>value!==storedDisplayPrompt(activeItems().find(i=>i.id===key)||{}));
        root.querySelectorAll('[data-continue-prompt-editor],[data-apply-prompt-proposal]').forEach(button=>{button.disabled=dirtyNow||submitting||editorBusy()||project?.promptReview?.status==='pending';});
        root.querySelector("#confirmAllPrompts").disabled = submitting || editorBusy() || project?.promptReview?.status === "pending";
        const items = activeItems();
        const confirmed = items.filter(item => window.ReviewReceiptState.confirmed(item) && (!drafts.has(item.id) || drafts.get(item.id) === storedDisplayPrompt(item))).length;
        root.querySelector("#promptReviewConfirmedCount").textContent = `${confirmed} / ${items.length}`;
        root.querySelector("#promptReviewFooterStatus").textContent = `已确认 ${confirmed} 项，尚有 ${items.length - confirmed} 项待确认`;
        const card = textarea.closest(".prompt-review-item");
        card?.classList.add("is-dirty");
        const state = card?.querySelector(".prompt-review-item-state");
        if (state) state.textContent = "已修改 · 待确认";
        const hint = card?.querySelector(".prompt-review-item-actions span");
        if (hint && card.querySelector(".prompt-review-language.is-english")) {
          const executionLength = Number(card.querySelector(".prompt-review-execution")?.dataset.executionLength || 0);
          hint.textContent = `中文已修改；确认时会重新编译为完整英文执行稿。中文 ${textarea.value.length} 字 / 当前执行稿 ${executionLength} 字，均完整显示、不截断。`;
        } else if (hint) {
          hint.textContent = `这里就是实际执行稿，共 ${textarea.value.length} 字，完整显示；完整文本不会省略或截断。`;
        }
        return;
      }
      if (event.target.id === "promptReviewSearch") applyFilter();
    });
    root.addEventListener("click", event => {
      if(event.target.closest('[data-apply-prompt-proposal]')){
        if(submitting||editorBusy()||!options.applyProposal)return;
        if([...drafts].some(([id,text])=>text!==storedDisplayPrompt((project.promptReview.items||[]).find(i=>i.id===id)||{}))){setMessage('请先保存当前编辑，再应用建议。');return;}
        submitting=true;render();
        Promise.resolve(options.applyProposal(project.id)).then(result=>{if(result?.ok===false)throw Error(result.message||'建议尚未应用');const next=result?.project||result?.result?.project;if(next){if(next.promptReview?.proposal?.status==="applied"){drafts.clear();draftBases.clear();}project=next;options.setProject?.(next);}}).catch(error=>setMessage(error.message||'原内容保持不变')).finally(()=>{submitting=false;render();});return;
      }
      const useAgent=event.target.closest('[data-use-agent-edit]');
      if(useAgent){drafts.delete(useAgent.dataset.useAgentEdit);draftBases.delete(useAgent.dataset.useAgentEdit);renderedSignature='';render();return;}
      if(event.target.closest('[data-continue-prompt-editor]')){
        if(submitting||editorBusy()||!options.review)return;
        if([...drafts].some(([id,text])=>text!==storedDisplayPrompt((project.promptReview.items||[]).find(i=>i.id===id)||{}))){setMessage('请先保存当前编辑，再审核。');return;}
        submitting=true;render();setMessage('AI 正在审核并准备修改建议，原内容保持不变…');
        Promise.resolve(options.review(project.id)).then(result=>{const next=result?.project||result?.result?.project;if(next){project=next;options.setProject?.(next);}else setMessage(result?.message||'审核请求已接收');}).catch(error=>setMessage(error.message||'当前内容已保存，稍后可继续')).finally(()=>{submitting=false;render();});return;
      }

      const filterButton = event.target.closest("[data-prompt-review-filter]");
      if (filterButton) {
        filter = filterButton.dataset.promptReviewFilter || "all";
        applyFilter();
        root.scrollTop = 0;
        list.scrollTop = 0;
        window.scrollTo(0, 0);
        requestAnimationFrame(() => window.scrollTo(0, 0));
        return;
      }
      const itemButton = event.target.closest("[data-confirm-prompt-item]");
      if (itemButton) confirmItem(itemButton.dataset.confirmPromptItem);
    });
    root.querySelector("#confirmAllPrompts")?.addEventListener("click", confirmAll);
    root.querySelector("#closePromptReviewDialog")?.addEventListener("click", close);
    root.querySelector("#cancelPromptReview")?.addEventListener("click", close);
    root.addEventListener("cancel", event => { event.preventDefault(); close(); });
    return {
      sync(nextProject, { autoOpen = true } = {}) {
        const nextBoundKey = `${nextProject?.id || ""}:${nextProject?.promptReview?.version || ""}:${nextProject?.promptReview?.productionRevision || ""}`;
        if (nextBoundKey !== boundProjectKey) {
          drafts.clear();draftBases.clear();
          boundProjectKey = nextBoundKey;
          filter = "all";
          const search = root.querySelector("#promptReviewSearch");
          if (search) search.value = "";
        }
        project = nextProject || null;
        // Pending evidence remains readable; it is not an approval.
        const key = reviewKey(project);
        if (root.open) render();
        if (autoOpen
          && window.ReviewReceiptState.needsConfirmation(project?.promptReview)
          && key !== autoOpenedKey) {
          autoOpenedKey = key;
          // A project switch before this microtask must not open another draft.
          queueMicrotask(() => { if (reviewKey(project) === key && window.ReviewReceiptState.needsConfirmation(project?.promptReview)) open(); });
        }
      },
      open,
      close,
      isOpen: () => root.open
    };
  }

  global.createPromptReviewDialog = createPromptReviewDialog;
})(window);
