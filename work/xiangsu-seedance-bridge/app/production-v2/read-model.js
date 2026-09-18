'use strict';
// Unified production-v2 read model supporting both contract mode and runtime view mode.

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

function unknown(value) { return value === undefined || value === null || value === '' ? 'unknown' : value; }
function notReady(value) { return value === undefined || value === null ? 'not_ready' : value; }

function buildProductionView(arg1 = {}, arg2 = [], arg3 = {}) {
  let project = {}, operations = [], readiness = null, artifacts = {}, streamSeq = 0, capabilities = {};

  if (arg1 && typeof arg1 === 'object' && ('readiness' in arg1 || 'streamSeq' in arg1)) {
    project = arg1.project || {};
    operations = Array.isArray(arg1.operations) ? arg1.operations : [];
    readiness = arg1.readiness;
    artifacts = arg1.artifacts || {};
    streamSeq = Number.isSafeInteger(arg1.streamSeq) ? arg1.streamSeq : 0;
  } else {
    project = arg1 || {};
    operations = Array.isArray(arg2) ? arg2 : [];
    capabilities = arg3 || {};
  }

  const shots = Array.isArray(project.shots) ? project.shots : [];
  const automation = project.automation || {};
  const running = automation.status === 'running' || operations.some(op => op.status === 'running');
  const localPostTask = project.postProductionTask || {};
  const postAudioMode = ['preview_and_draft', 'draft_only', 'none'].includes(String(project.postAudioMode))
    ? String(project.postAudioMode) : 'preview_and_draft';
  const videoReadyOf = shot => Boolean(shot && (shot.localVerified || shot.selectedVideoVerified));
  const videosReadyCount = shots.filter(videoReadyOf).length;
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

  let next;
  if (readiness) {
    const artifactCurrent = a => a?.state === 'valid' && a.current === true && typeof a.path === 'string' && a.path.length > 0;
    const clean = artifactCurrent(artifacts?.clean) ? artifacts.clean : null;
    const sfx = artifactCurrent(artifacts?.sfx) ? artifacts.sfx : null;
    const preferred = sfx || clean;
    const action = (id, title, enabled = true, reason = null) => ({ id, title, enabled, reason });
    if (operations.some(o => o.status === 'cancelling')) next = action('view_tasks', '正在停止任务', false);
    else if (operations.some(o => o.status === 'outcome_unknown')) next = action('reconcile', '确认上一次请求状态');
    else if (operations.some(o => ['queued', 'running'].includes(o.status))) next = action('view_tasks', operations.some(o => o.status === 'running') ? '查看运行中的任务' : '查看已排队任务');
    else if (readiness.localPostReady === true && !preferred) next = action('start_post', '开始净音粗剪');
    else if (preferred) next = action(sfx ? 'preview_sfx' : 'preview_clean', sfx ? '预览含音效成片' : '预览净音粗剪');
    else next = action('refresh_dependencies', '检查完成状态');
  } else {
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
    next = nextAction(state);
  }

  return {
    phase: stageSummary.post === 'ready' ? 'completed' : running ? 'producing' : 'ready_to_advance',
    stage: automation.stage || automation.operation || 'unknown',
    stageSummary,
    streamSeq,
    counts: {
      shots: shots.length,
      videosReady: videosReadyCount,
      missingAssets: typeof missingAssetsRaw === 'number' ? missingAssetsRaw : 'unknown',
      missingBoards: typeof project.missingBoardCount === 'number' ? project.missingBoardCount : 'unknown',
      assets: readiness?.requiredAssetsMissing ?? (typeof missingAssetsRaw === 'number' ? missingAssetsRaw : 0),
      images: readiness?.requiredImagesMissing ?? (typeof project.missingBoardCount === 'number' ? project.missingBoardCount : 0),
      videos: readiness?.requiredVideosMissing ?? (shots.length - videosReadyCount)
    },
    warnings: warnings > 0 ? [{ code: 'ROUGH_CUT_SOURCE_WARNINGS', count: warnings }] : (readiness?.warnings || []),
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
      finalVideoStale: Boolean(project.finalVideoStale),
      clean: artifacts?.clean || null,
      sfx: artifacts?.sfx || null
    }
  };
}

function reduceEvents(state, event) {
  if (!event || event.projectId !== state.projectId) return state;
  const seq = Number.isSafeInteger(event.seq) ? event.seq : (Number.isSafeInteger(event.streamSeq) ? event.streamSeq : NaN);
  if (!Number.isSafeInteger(seq) || seq < 1) throw Error('Invalid sequence');
  if (seq <= state.lastSeq) return state;
  if (seq !== state.lastSeq + 1) return { ...state, needsResync: true };
  const events = state.events ? [...state.events, event].slice(-300) : [];
  return { ...state, lastSeq: seq, streamSeq: seq, needsResync: false, events };
}

function reduceEvent(state, event) {
  if (!event || event.projectId !== state.projectId) return state;
  const seq = Number.isSafeInteger(event.streamSeq) ? event.streamSeq : (Number.isSafeInteger(event.seq) ? event.seq : NaN);
  if (!Number.isSafeInteger(seq) || seq < 1) throw Error('Invalid sequence');
  const lastSeq = Number.isSafeInteger(state.streamSeq) ? state.streamSeq : (Number(state.lastSeq) || 0);
  if (seq <= lastSeq) return state;
  if (seq !== lastSeq + 1) return { ...state, needsResync: true };
  return { ...state, streamSeq: seq, lastSeq: seq, needsResync: false, needsRefresh: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextAction, reduceEvents, reduceEvent, buildProductionView };
}
if (typeof window !== 'undefined') {
  window.ProductionView = { nextAction, reduceEvents, reduceEvent, buildProductionView };
}
