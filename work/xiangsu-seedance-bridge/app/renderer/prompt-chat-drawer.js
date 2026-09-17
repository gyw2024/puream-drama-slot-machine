// T09 / §6.1: single-item prompt chat drawer.
// One thread per item; the textarea selection defaults the scope to
// "仅所选文字"; proposals show on the right with explicit apply/discard;
// applying keeps the drawer open on the same thread; input drafts survive
// project refreshes within the session.
(function attachPromptChatDrawer(global) {
  "use strict";

  const drafts = new Map();      // itemId -> input draft
  const threads = new Map();     // itemId -> threadId
  const lastOpenProposals = new Map(); // itemId -> {threadId, proposalId}

  function api() { return global.dramaSlot?.promptChat || null; }

  function ensureDom() {
    let root = document.querySelector("#promptChatDrawer");
    if (root) return root;
    root = document.createElement("dialog");
    root.id = "promptChatDrawer";
    root.className = "prompt-chat-drawer";
    root.innerHTML = `
      <div class="prompt-chat-head">
        <div><b id="promptChatItemLabel"></b><span id="promptChatItemStage" class="prompt-chat-stage"></span></div>
        <button type="button" class="outline-button" id="promptChatClose">关闭</button>
      </div>
      <div class="prompt-chat-messages" id="promptChatMessages"></div>
      <div class="prompt-chat-scope">
        <label><input type="radio" name="promptChatScope" value="selection" id="promptChatScopeSelection"> 仅所选文字</label>
        <label><input type="radio" name="promptChatScope" value="whole" id="promptChatScopeWhole"> 整条提示词</label>
        <span id="promptChatScopeHint"></span>
      </div>
      <textarea id="promptChatInput" rows="3" placeholder="输入你的修改要求…"></textarea>
      <div class="prompt-chat-actions">
        <span id="promptChatMessage"></span>
        <button type="button" class="outline-button" id="promptChatSend">发送</button>
      </div>`;
    document.body.append(root);
    return root;
  }

  function setMessage(root, text, kind) {
    const node = root.querySelector("#promptChatMessage");
    node.textContent = text || "";
    node.dataset.kind = kind || "";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderMessages(root, state) {
    const box = root.querySelector("#promptChatMessages");
    const messages = state.messages || [];
    box.innerHTML = messages.map(message => {
      if (message.role === "user") return `<div class="chat-line chat-user">${escapeHtml(message.payload?.text || "")}</div>`;
      if (message.role === "system") return `<div class="chat-line chat-system">${escapeHtml(message.payload?.event || "")}</div>`;
      const payload = message.payload || {};
      if (payload.cancelled || payload.discarded) return `<div class="chat-line chat-system">已取消/放弃</div>`;
      let actions = "";
      if (payload.proposalId && !payload.applied) {
        actions = `<div class="chat-proposal-actions">
          <button type="button" class="outline-button" data-apply-proposal="${escapeHtml(payload.proposalId)}">应用此修改</button>
          <button type="button" class="outline-button" data-discard-proposal="${escapeHtml(payload.proposalId)}">放弃本次提案</button>
        </div>`;
      }
      if (payload.applied) actions = `<div class="chat-line chat-system">已应用 ✓</div>`;
      const replacement = typeof payload.replacementDisplay === "string" && payload.replacementDisplay
        ? `<pre class="chat-proposal-text">${escapeHtml(payload.replacementDisplay)}</pre>` : "";
      const reasons = Array.isArray(payload.dependencyFindings) && payload.dependencyFindings.length
        ? `<details class="chat-dependencies"><summary>依赖建议（${payload.dependencyFindings.length}）</summary><ul>${payload.dependencyFindings.map(f => `<li>${escapeHtml(f.targetId)}：${escapeHtml(f.reason)}</li>`).join("")}</ul></details>` : "";
      return `<div class="chat-line chat-assistant"><div>${escapeHtml(payload.assistantMessage || payload.text || "")}</div>${replacement}${reasons}${actions}</div>`;
    }).join("") || '<div class="chat-line chat-system">描述你想修改的内容，Agent 只会改动这一条提示词。</div>';
    box.querySelectorAll("[data-apply-proposal]").forEach(button => button.addEventListener("click", () => applyProposal(root, state, button.dataset.applyProposal)));
    box.querySelectorAll("[data-discard-proposal]").forEach(button => button.addEventListener("click", () => discardProposal(root, state, button.dataset.discardProposal)));
    box.scrollTop = box.scrollHeight;
  }

  function currentScope(root, state) {
    const textarea = state.textarea;
    if (!textarea || root.querySelector("#promptChatScopeWhole").checked) return { type: "wholeItem" };
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (start === end) return { type: "wholeItem" };
    return { type: "selection", startUtf16: start, endUtf16: end, selectedText: textarea.value.slice(start, end) };
  }

  function syncScopeUi(root, state) {
    const textarea = state.textarea;
    const hasSelection = Boolean(textarea && textarea.selectionEnd > textarea.selectionStart);
    root.querySelector("#promptChatScopeSelection").disabled = !hasSelection;
    if (!hasSelection) root.querySelector("#promptChatScopeWhole").checked = true;
    root.querySelector("#promptChatScopeHint").textContent = hasSelection
      ? `已选中 ${textarea.selectionEnd - textarea.selectionStart} 个字符`
      : "未选中文字：将以整条提示词为范围";
  }

  async function refresh(root, state) {
    const result = await api().getThread(state.projectId, state.threadId);
    if (!result?.ok) throw new Error(result?.message || "读取会话失败");
    Object.assign(state, { messages: result.messages });
    renderMessages(root, state);
  }

  async function send(root, state) {
    const input = root.querySelector("#promptChatInput");
    const instruction = input.value.trim();
    if (!instruction) { setMessage(root, "请先输入修改要求。", "error"); return; }
    setMessage(root, "Agent 正在按本条范围生成提案…", "busy");
    try {
      const clientTurnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await api().sendTurn(state.projectId, state.threadId, clientTurnId, currentScope(root, state), instruction);
      if (!result?.ok) throw new Error(result?.message || "本轮失败");
      drafts.delete(state.itemId);
      input.value = "";
      await refresh(root, state);
      setMessage(root, "提案已生成；应用前不会改动项目内容。");
    } catch (error) {
      setMessage(root, error.message || "本轮失败，草稿已保留。", "error");
    }
  }

  async function applyProposal(root, state, proposalId) {
    setMessage(root, "正在应用提案…", "busy");
    try {
      const result = await api().applyProposal(state.projectId, state.threadId, proposalId, null, null);
      if (!result?.ok) throw new Error(result?.message || "应用失败");
      lastOpenProposals.delete(state.itemId);
      await refresh(root, state);
      setMessage(root, "已应用：本条进入待确认状态，其他条目不受影响。");
      if (typeof state.onApplied === "function") await state.onApplied(result.project);
    } catch (error) {
      setMessage(root, error.message || "应用失败；提案已保留。", "error");
      await refresh(root, state).catch(() => {});
    }
  }

  async function discardProposal(root, state, proposalId) {
    try { await api().discardProposal(state.projectId, state.threadId, proposalId); } catch {}
    lastOpenProposals.delete(state.itemId);
    await refresh(root, state);
    setMessage(root, "已放弃本次提案。");
  }

  async function open({ projectId, item, textarea, onApplied }) {
    if (!api()) throw new Error("当前环境未接入单条聊天 API。");
    const root = ensureDom();
    const state = { projectId, itemId: item.id, label: item.label || item.id, textarea: textarea || null, messages: [], onApplied };
    root.querySelector("#promptChatItemLabel").textContent = state.label;
    root.querySelector("#promptChatItemStage").textContent = item.stage || "";
    const input = root.querySelector("#promptChatInput");
    input.value = drafts.get(state.itemId) || "";
    input.oninput = () => drafts.set(state.itemId, input.value);
    if (!threads.has(state.itemId)) {
      const created = await api().createThread(projectId, state.itemId);
      if (!created?.ok) throw new Error(created?.message || "创建会话失败");
      threads.set(state.itemId, created.threadId);
    }
    state.threadId = threads.get(state.itemId);
    syncScopeUi(root, state);
    if (textarea) {
      ["select", "keyup", "mouseup"].forEach(event => textarea.addEventListener(event, () => { if (root.open) syncScopeUi(root, state); }));
    }
    await refresh(root, state);
    setMessage(root, "");
    if (!root.open) root.showModal();
    const sendButton = root.querySelector("#promptChatSend");
    sendButton.onclick = () => send(root, state);
    root.querySelector("#promptChatClose").onclick = () => root.close();
    root.onclose = () => { drafts.set(state.itemId, input.value); };
    return root;
  }

  global.PromptChatDrawer = { open };
})(window);
