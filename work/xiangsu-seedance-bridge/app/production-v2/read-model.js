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

// T15 / §12.1: THE single production view. Both UIs consume this output for
// phase, stage summary, counts, blocking reasons and the next action — they no
// longer guess stages from their own private counters. Missing facts surface
// as 'unknown'/'not_ready', never as a fake 'completed'.
function unknown(value) { return value === undefined || value === null || value === '' ? 'unknown' : value; }
function notReady(value) { return value === undefined || value === null ? 'not_ready' : value; }

function buildProductionView(project = {}, operations = [], capabilities = {}) {
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const automation = project.automation || {};
  const running = automation.status === 'running' || operations.some(op => op.status === 'running');
  const localPostTask = project.postProductionTask || {};
  const postAudioMode = ['preview_and_draft', 'draft_only', 'none'].includes(String(project.postAudioMode))
    ? String(project.postAudioMode) : 'preview_and_draft';
  const videoReadyOf = shot => Boolean(shot && (shot.localVerified || shot.selectedVideoVerified));
  const videosReadyCount = shots.filter(videoReadyOf).length;
  // 视频齐全 must satisfy the §9 verification, not just remote success.
  const videosReady = shots.length > 0 && videosReadyCount === shots.length;
  const missingAssetsRaw = notReady(project.missingAssetCount);
  const stageSummary = {
    script: project.script?.raw ? 'ready' : (project.input ? 'not_ready' : 'unknown'),
    assets: project.missingAssetCount === undefined ? 'unknown' : (project.missingAssetCount > 0 ? 'not_ready' : 'ready'),
    boards: shots.length === 0 ? 'not_ready' : (project.missingBoardCount === undefined ? 'unknown' : (project.missingBoardCount > 0 ? 'not_ready' : 'ready')),
    videos: shots.length === 0 ? 'not_ready' : (videosReady ? 'ready' : `not_ready:${videosReadyCount}/${shots.length}`),
    post: project.roughCutVideoPath ? (project.postAudioState === 'partial_audio' ? 'partial_audio' : 'ready') : 'not_ready'
  };
  const blockedReasons = [];
  if (capabilities.accountBlocked) blockedReasons.push({ code: 'ACCOUNT_BLOCKED', message: 'Agent 账号待恢复' });
  if (automation.recoverableFailure) blockedReasons.push({ code: 'RECOVERABLE_FAILURE', message: automation.message || '上次任务待处理' });
  if (project.promptReview?.status === 'pending') blockedReasons.push({ code: 'REVIEW_PENDING', message: '提示词确认未完成' });
  const warnings = Array.isArray(project.roughCutSourceWarnings) ? project.roughCutSourceWarnings.length : 0;
  const state = {
    cancelPending: automation.status === 'cancelling',
    running,
    stage: automation.stage || automation.operation || 'unknown',
    localPostRunning: localPostTask.status === 'running',
    videosReady,
    shotCount: shots.length,
    finalCurrent: Boolean(project.finalVideoPath) && !project.finalVideoStale,
    postAudioMode,
    autoPost: Boolean(project.autoPostPolicy && project.autoPostPolicy !== 'manual'),
    needsAccount: Boolean(capabilities.accountBlocked),
    sourceReady: Boolean(project.input && (project.script?.raw || project.ideation?.topics?.length)),
    textComplete: Boolean(project.script?.raw) && shots.length > 0 ? true : Boolean(project.script?.raw),
    productionStarted: shots.length > 0,
    initialApproved: project.promptReview?.status === 'approved' || project.promptReview?.confirmedAt !== undefined,
    affectedItemsNeedApproval: Boolean(project.promptReview?.items?.some(item => item.status === 'pending' && item.touchedByAgent)),
    missingAssets: typeof missingAssetsRaw === 'number' ? missingAssetsRaw : 0,
    missingBoards: typeof project.missingBoardCount === 'number' ? project.missingBoardCount : 0,
    mode: String(project.generation?.mode || 'unknown')
  };
  const next = nextAction(state);
  return {
    phase: stageSummary.post === 'ready' ? 'completed' : running ? 'producing' : 'ready_to_advance',
    stage: state.stage,
    stageSummary,
    counts: {
      shots: shots.length,
      videosReady: videosReadyCount,
      missingAssets: typeof missingAssetsRaw === 'number' ? missingAssetsRaw : 'unknown',
      missingBoards: typeof project.missingBoardCount === 'number' ? project.missingBoardCount : 'unknown'
    },
    warnings: warnings > 0 ? [{ code: 'ROUGH_CUT_SOURCE_WARNINGS', count: warnings }] : [],
    blockedReasons,
    nextAction: next,
    review: {
      canAutoOpen: Boolean(project.promptReview?.mayAutoOpen) && !project.promptReview?.autoOpenConsumed
    },
    activeOperations: (Array.isArray(operations) ? operations : [])
      .filter(op => op && ['running', 'queued', 'paused'].includes(String(op.status)))
      .map(op => ({ id: unknown(op.id), type: unknown(op.type), status: op.status, stage: unknown(op.stage), message: op.message || '' })),
    artifacts: {
      roughCutVideoPath: project.roughCutVideoPath || null,
      sfxPreviewPath: project.postProductionMixResult?.sfxVideoPath || null,
      postAudioState: project.postAudioState || (project.roughCutVideoPath ? 'unknown' : 'not_ready'),
      finalVideoPath: project.finalVideoPath || null,
      finalVideoStale: Boolean(project.finalVideoStale)
    }
  };
}

function reduceEvents(state, event) {
  if (event.projectId !== state.projectId) return state;
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw Error('Invalid sequence');
  if (event.seq <= state.lastSeq) return state;
  if (event.seq !== state.lastSeq + 1) return { ...state, needsResync: true };
  return { ...state, lastSeq: event.seq, needsResync: false, events: [...(state.events || []), event].slice(-300) };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { nextAction, reduceEvents, buildProductionView };
else if (typeof window !== 'undefined') window.ProductionView = { nextAction, reduceEvents, buildProductionView };
