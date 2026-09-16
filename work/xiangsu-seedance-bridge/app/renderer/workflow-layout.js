(function(root) {
  'use strict';
  function createWorkflowLayout({document, storage, getProject, onEntryChange = () => {}}) {
    const choices = new Map();
    const valid = value => ['original', 'upload', 'adapt'].includes(value);
    const key = id => 'puream:script-entry:v1:' + id;
    function entry(project = getProject()) {
      const id = project?.id;
      if (!id) return 'original';
      if (!choices.has(id)) {
        let saved;
        try { saved = storage.getItem(key(id)); } catch {}
        choices.set(id, valid(saved) ? saved : project.productionPlan?.inputMode === 'manual' ? 'upload' : 'original');
      }
      return choices.get(id);
    }
    function sync(project = getProject()) {
      const mode = entry(project), original = mode === 'original';
      document.querySelectorAll('button[data-script-entry]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scriptEntry === mode)));
      document.querySelector('#originalScriptActions').hidden = !original;
      document.querySelector('#scriptImportActions').hidden = original;
      document.querySelector('#importScriptFile').hidden = mode !== 'upload';
      document.querySelector('#openScriptImitation').hidden = mode !== 'adapt';
      document.querySelector('#scriptImportTitle').textContent = mode === 'adapt' ? '按参考稿改写剧本' : '上传已有剧本';
      document.querySelector('#scriptImportHelp').textContent = mode === 'adapt'
        ? '打开改写窗口，上传参考稿并填写改写要求；先查看改写结果，再决定是否采用。'
        : '选择剧本文件后保留原稿，由 Agent 整理、提取资产并拆镜；也可在下方直接粘贴剧本。';
      document.querySelector('[data-panel="script"]').dataset.scriptEntry = mode;
      return mode;
    }
    function choose(mode) {
      const project = getProject();
      if (!valid(mode) || !project?.id) return;
      choices.set(project.id, mode);
      try { storage.setItem(key(project.id), mode); } catch {}
      sync(project); onEntryChange(mode);
    }
    document.querySelectorAll('button[data-script-entry]').forEach(button => button.addEventListener('click', () => choose(button.dataset.scriptEntry)));
    // Move original controls instead of cloning: preserve one ID, one handler,
    // and keyboard order matching the visual workflow.
    function actionBefore(buttonId, anchorId, label) {
      const button = document.getElementById(buttonId), anchor = document.getElementById(anchorId);
      if (!button || !anchor) return;
      const row = document.createElement('div');
      row.className = 'workflow-generation-actions';
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', label);
      anchor.before(row); row.append(button);
    }
    actionBefore('generateAllAssets', 'assetBatchProgress', '确认提示词后生成资产');
    actionBefore('generateAllStoryboards', 'shotList', '按当前模式生成分镜图');
    actionBefore('generateAllVideos', 'jobStrip', '生成分镜视频');
    const final = document.querySelector('[data-panel="final"]');
    const timeline = final?.querySelector('.timeline-panel');
    const imports = final?.querySelector('.manual-entry-bar');
    const actions = final?.querySelector('.stage-head .head-actions');
    if (timeline && imports && actions) {
      imports.after(timeline); actions.classList.add('workflow-generation-actions');
      timeline.after(actions); final.append(document.getElementById('workbenchPostProduction'));
    }
    const settings = document.querySelector('[data-panel="settings"]');
    const settingsActions = settings?.querySelector('.stage-head .head-actions');
    if (settingsActions) {
      const footer = document.createElement('div'); footer.className = 'workflow-stage-footer panel-card';
      footer.setAttribute('aria-label', '设置完成后的操作');
      footer.append(settingsActions); settings.append(footer);
    }
    return {entry, sync, choose};
  }
  if (typeof module === 'object' && module.exports) module.exports = {createWorkflowLayout};
  else root.createWorkflowLayout = createWorkflowLayout;
})(typeof window === 'object' ? window : globalThis);

