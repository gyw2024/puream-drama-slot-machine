'use strict';
// production-v2 read model — appendix B reference-code/read-model.cjs.
// One next-action decision consumed by workbench AND simple mode. reduceEvents
// assumes a PROJECT-LOCAL continuous seq stream; never feed a filtered global
// audit sequence into it.
function nextAction(s) {
  const action = (id, title, stage, enabled = true) => ({ id, title, stage, enabled });
  if (s.cancelPending) return action('wait_cancel', '正在停止并保存断点', s.stage, false);
  if (s.running) return action('view_progress', '查看真实进度', s.stage, true);
  if (s.localPostRunning) return action('view_post', '查看粗剪进度', 'post', true);
  if (s.videosReady && s.shotCount > 0) {
    if (s.finalCurrent) return action('preview_final', s.postAudioMode === 'none' || s.postAudioMode === 'draft_only' ? '预览净音粗剪' : '预览含音效成片', 'post');
    return action(s.autoPost ? 'view_post_queue' : 'start_post', s.autoPost ? '粗剪已排队' : '生成粗剪与音效', 'post');
  }
  if (s.needsAccount) return action('open_account', '恢复 Agent 账户', 'settings');
  if (!s.sourceReady) return action('prepare_source', '输入资料并准备完整文本', 'script');
  if (!s.textComplete) return action('resume_text', '继续未完成文本', 'script');
  if (!s.productionStarted && !s.initialApproved) return action('open_initial_review', '确认完整提示词', 'script');
  if (s.affectedItemsNeedApproval) return action('review_changed_items', '检查刚修改的条目', 'assets');
  if (s.missingAssets > 0) return action('prepare_assets', `补齐 ${s.missingAssets} 项资产`, 'assets');
  if (s.mode !== 'asset_direct' && s.mode !== 'production_package' && s.missingBoards > 0) return action('prepare_boards', '补齐分镜图', 'shots');
  if (s.shotCount > 0) return action('generate_videos', '生成缺失分镜视频', 'videos');
  return action('open_story', '检查分镜结构', 'script');
}
function reduceEvents(state, event) {
  if (event.projectId !== state.projectId) return state;
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw Error('Invalid sequence');
  if (event.seq <= state.lastSeq) return state;
  if (event.seq !== state.lastSeq + 1) return { ...state, needsResync: true };
  return { ...state, lastSeq: event.seq, needsResync: false, events: [...(state.events || []), event].slice(-300) };
}
module.exports = { nextAction, reduceEvents };
