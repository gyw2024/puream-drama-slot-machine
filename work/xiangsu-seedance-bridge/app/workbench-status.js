"use strict";

(function registerWorkbenchStatus(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DramaSlotStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const ACTIVE_JOB_STATUSES = new Set([
    "queued", "pending", "submitting", "submitted", "running", "processing", "uploading", "waiting", "remote_pending", "download_pending"
  ]);

  const VIDEO_JOB_TYPES = new Set(["character_video", "shot_video"]);
  // Submission itself may legitimately spend twenty minutes uploading and
  // waiting for an upstream task id. An anonymous placeholder gets the full
  // production floor; a job with the stable request fingerprint/idempotency
  // identity gets an additional recovery margin. A currently active operation
  // is never aged out here: its controller is the authoritative liveness
  // signal, and the old 90-second heuristic could otherwise race a valid
  // twenty-minute submit call.
  const VIDEO_SUBMISSION_PHANTOM_AFTER_MS = 20 * 60 * 1000;
  const VIDEO_IDENTIFIED_SUBMISSION_PHANTOM_AFTER_MS = 30 * 60 * 1000;

  function newest(items) {
    return items.slice().sort((a, b) => {
      const aTime = String(a.updatedAt || a.createdAt || "");
      const bTime = String(b.updatedAt || b.createdAt || "");
      return bTime.localeCompare(aTime);
    })[0] || null;
  }

function videoJobAgeMs(job) {
  const updatedAt = Date.parse(job?.updatedAt || job?.createdAt || "");
  return Number.isFinite(updatedAt) ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
}

function hasStableSubmissionIdentity(job) {
  return Boolean(String(job?.submissionFingerprint || "").trim()
    && String(job?.clientRequestId || "").trim());
}

function upstreamSubmissionState(job) {
  if (!job || typeof job !== "object") return "";
  if (job.taskId || job.providerTaskId) return "created";
  const explicit = String(job.upstreamSubmissionState || "").trim().toLowerCase();
  if (["not_started", "preparing", "submitting", "not_created", "unknown", "created"].includes(explicit)) return explicit;
  const code = String(job.errorCode || "").trim().toUpperCase();
  if (["VIDEO_SUBMISSION_RESPONSE_UNKNOWN", "VIDEO_SUBMISSION_RECOVERY_REQUIRED"].includes(code)
    || job.remoteSubmissionUnknown === true) return "unknown";
  if (job.noRemoteTaskCreated === true) return "not_created";
  return "";
}

function hasCreatedUpstreamTask(job) {
  return upstreamSubmissionState(job) === "created";
}

function canResumeStableSubmission(job) {
  return !hasCreatedUpstreamTask(job) && hasStableSubmissionIdentity(job);
}

function hasActiveOperation(context) {
  return context?.activeOperation === true || context?.runtime?.activeOperation === true;
}

function isPhantomVideoJob(job, context = null) {
  if (!job || !VIDEO_JOB_TYPES.has(job.type || job.jobType)) return false;
  const status = String(job.status || "").toLowerCase();
  if (!ACTIVE_JOB_STATUSES.has(status)) return false;
  if (job.taskId) return false;
  if (hasActiveOperation(context)) return false;
  const phantomAfterMs = hasStableSubmissionIdentity(job)
    ? VIDEO_IDENTIFIED_SUBMISSION_PHANTOM_AFTER_MS
    : VIDEO_SUBMISSION_PHANTOM_AFTER_MS;
  return videoJobAgeMs(job) > phantomAfterMs;
}

function isActiveVideoJob(job, context = null) {
  if (!job || !VIDEO_JOB_TYPES.has(job.type || job.jobType)) return false;
  const status = String(job.status || "").toLowerCase();
  if (!ACTIVE_JOB_STATUSES.has(status)) return false;
  if (isPhantomVideoJob(job, context)) return false;
  const ageMs = videoJobAgeMs(job);
  // remote_pending older than two hours with nobody polling is a ghost lock.
  if (["remote_pending", "download_pending"].includes(status) && ageMs > 2 * 60 * 60 * 1000) return false;
  return true;
}

  function latestVideoJobs(project) {
    const activeRevision = project?.productionRevision || "";
    return (project?.jobs || []).filter(job =>
      VIDEO_JOB_TYPES.has(job?.type)
      && (job.productionRevision || "") === activeRevision
    ).sort((a, b) => {
      const aTime = String(a.updatedAt || a.createdAt || "");
      const bTime = String(b.updatedAt || b.createdAt || "");
      return bTime.localeCompare(aTime);
    });
  }

  function activeVideoJobs(project) {
    return latestVideoJobs(project).filter(job => isActiveVideoJob(job, project));
  }

  function videoJobProgress(job) {
    const status = String(job?.status || "").toLowerCase();
    if (status === "completed") {
      return { determinate: true, value: 100, label: "100%", source: "terminal" };
    }
    const numeric = Number(job?.progress);
    const trusted = job?.progressDeterminate === true
      || ["upstream", "remote-api", "transfer", "puream-upstream"].includes(String(job?.progressSource || "").toLowerCase());
    if (trusted && Number.isFinite(numeric)) {
      const value = Math.max(0, Math.min(100, numeric));
      return { determinate: true, value, label: `${Math.round(value)}%`, source: job.progressSource || "upstream" };
    }
    if (!hasCreatedUpstreamTask(job)) {
      if (upstreamSubmissionState(job) === "not_created" && !ACTIVE_JOB_STATUSES.has(status)) {
        return { determinate: false, value: null, label: "未创建上游任务", source: "terminal-local" };
      }
      if (upstreamSubmissionState(job) === "unknown" && !ACTIVE_JOB_STATUSES.has(status)) {
        return { determinate: false, value: null, label: "提交结果待恢复（尚无 taskId）", source: "terminal-local" };
      }
      if (status === "uploading") {
        return { determinate: false, value: null, label: "参考素材上传中（尚无 taskId）", source: job?.progressSource || "local-upload" };
      }
      return { determinate: false, value: null, label: "正在创建上游任务（尚无 taskId）", source: job?.progressSource || "local-submit" };
    }
    return { determinate: false, value: null, label: "实时同步中", source: job?.progressSource || "status-only" };
  }

  function videoJobProvider(job) {
    void job;
    return "H3 云端算力";
  }

  function videoJobStage(job) {
    const status = String(job?.status || "").toLowerCase();
    const provider = videoJobProvider(job);
    if (!hasCreatedUpstreamTask(job)) {
      if (status === "uploading") return "本地正在上传参考素材";
      if (status === "submitting") return "正在向上游创建任务";
      if (["queued", "pending", "submitted", "waiting", "remote_pending"].includes(status)) return "尚未取得上游 taskId";
    }
    if (["queued", "pending", "submitted", "waiting"].includes(status)) return `${provider}排队中`;
    if (["running", "processing"].includes(status)) return `${provider}生成中`;
    if (status === "completed") return "生成完成";
    if (["failed", "error"].includes(status)) return "生成失败";
    if (status === "discarded") return "任务已丢弃";
    return job?.message || status || "等待任务状态";
  }

  function qualityGatesEnabled(settings) {
    return settings?.generation?.qualityGatesEnabled === true
      && settings?.generation?.qualityGateModules?.videos === true;
  }

  function candidateQualityAccepted(item, settings = null) {
    if (!item?.filePath) return false;
    if (!qualityGatesEnabled(settings)) return true;
    return item.manualSelectionOverride === true
      || item.qualityAudit?.ok === true
      || item.qualityAudit?.accepted === true
      || item.qualityAudit?.overridden === true
      || ["manual", "human_override", "advisory_continue"].includes(String(item.qualityAudit?.mode || ""));
  }

  function completeShotVideoCandidate(item) {
    return item?.stage === "shot_video"
      && item.internalGenerationBlock !== true
      && item.recoveredInternalBlock !== true
      && item.incompleteShotVideo !== true;
  }

  function shotVideoCandidate(project, shot, settings = null) {
    const activeRevision = project?.productionRevision || "";
    const matches = (project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
      && completeShotVideoCandidate(item)
      && (item.productionRevision || "") === activeRevision
      && candidateQualityAccepted(item, settings)
    );
    const manualSelection = matches.find(item => item.selected === true && item.manualSelectionOverride === true);
    if (manualSelection) return manualSelection;
    const current = matches.filter(item => item.stale !== true);
    const selected = current.find(item => item.selected === true);
    if (selected) return selected;
    const recoverableHistorical = matches.find(item => item.stale === true
      && item.staleCauseCode !== "technical_integrity"
      && !/技术完整性|空白帧|纯色边栏|错误转场|画布泄漏/.test(String(item.staleReason || "")));
    return newest(current) || recoverableHistorical || null;
  }

  function failedShotVideoCandidate(project, shot, settings = null) {
    if (!qualityGatesEnabled(settings)) return null;
    const activeRevision = project?.productionRevision || "";
    return newest((project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
      && completeShotVideoCandidate(item)
      && (item.productionRevision || "") === activeRevision
      && item.qualityAudit?.ok === false
      && !candidateQualityAccepted(item, settings)
    ));
  }

  function unverifiedShotVideoCandidate(project, shot, settings = null) {
    if (!qualityGatesEnabled(settings)) return null;
    const activeRevision = project?.productionRevision || "";
    return newest((project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
      && completeShotVideoCandidate(item)
      && (item.productionRevision || "") === activeRevision
      && item.qualityAudit?.ok !== true
      && item.qualityAudit?.ok !== false
      && !candidateQualityAccepted(item, settings)
    ));
  }

  function shotVideoJob(project, shot) {
    const activeRevision = project?.productionRevision || "";
    return newest((project?.jobs || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.type === "shot_video"
      && (item.productionRevision || "") === activeRevision
    ));
  }

  function recoveredShotVideoBlocks(project, shot) {
    const activeRevision = project?.productionRevision || "";
    return (project?.jobs || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.type === "shot_video"
      && (item.productionRevision || "") === activeRevision
      && (item.internalGenerationBlock === true || item.internalTake === true)
      && String(item.status || "").toLowerCase() === "completed"
      && Boolean(item.internalGenerationBlockFilePath || item.internalTakeFilePath)
    ).sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));
  }

  function shotVideoState(project, shot, settings = null) {
    const candidate = shotVideoCandidate(project, shot, settings);
    const failedCandidate = failedShotVideoCandidate(project, shot, settings);
    const unverifiedCandidate = unverifiedShotVideoCandidate(project, shot, settings);
    const job = shotVideoJob(project, shot);
    const recoveredBlocks = recoveredShotVideoBlocks(project, shot);
    const activeJob = isActiveVideoJob(job, project) ? job : null;
    if (candidate) {
      return {
        key: "ready",
        label: activeJob ? "已就绪 · 正在重抽" : "已就绪",
        candidate,
        job,
        activeJob,
        progress: activeJob ? videoJobProgress(activeJob) : videoJobProgress({ status: "completed" }),
        detail: activeJob ? (activeJob.message || videoJobStage(activeJob)) : "分镜视频已生成"
      };
    }

    if (failedCandidate) {
      return {
        key: "failed",
        label: "质检失败",
        candidate: failedCandidate,
        job,
        activeJob,
        progress: activeJob ? videoJobProgress(activeJob) : videoJobProgress({ status: "completed" }),
        detail: (failedCandidate.qualityAudit?.failures || []).map(item => item.message).join("；") || "音画质检有提醒，可 AI 修复或人工选中原资产"
      };
    }

    if (unverifiedCandidate) {
      return {
        key: "failed",
        label: "待质检",
        candidate: unverifiedCandidate,
        job,
        activeJob,
        progress: activeJob ? videoJobProgress(activeJob) : videoJobProgress({ status: "completed" }),
        detail: "该视频尚有质检提醒，可 AI 修复或人工选中原资产继续"
      };
    }

    if (recoveredBlocks.length) {
      const rejectedCount = recoveredBlocks.filter(item => item.localQualityRejected === true).length;
      return {
        key: "partial",
        label: `已取回 ${recoveredBlocks.length} 段`,
        candidate: null,
        job,
        activeJob: null,
        recoveredBlocks,
        progress: videoJobProgress({ status: "completed" }),
        detail: `上游源片段已经保存在本机${rejectedCount ? `，其中 ${rejectedCount} 段保留为失败历史` : ""}；继续任务时只补齐缺失片段并本地合成，不会重复提交已完成 taskId`
      };
    }

    const status = String(job?.status || "").toLowerCase();
    const progress = videoJobProgress(job);
    if (isActiveVideoJob(job, project)) {
      const upstreamCreated = hasCreatedUpstreamTask(job);
      return {
        key: upstreamCreated ? "generating" : "submitting",
        label: upstreamCreated && progress.determinate ? `生成中 ${progress.label}` : videoJobStage(job),
        candidate: null,
        job,
        activeJob: job,
        progress,
        detail: job?.message || (upstreamCreated ? "视频生成任务正在运行" : "当前只在准备或提交请求，尚未进入上游生成队列")
      };
    }
    if (["paused", "cancelled"].includes(status) && canResumeStableSubmission(job)) {
      const unknown = upstreamSubmissionState(job) === "unknown";
      return {
        key: "missing",
        label: unknown ? "原提交待恢复" : "已暂停，可继续",
        candidate: null,
        job,
        activeJob: null,
        progress,
        detail: unknown
          ? "继续时只复用原幂等键找回同一任务，不会重复生成"
          : "尚未创建上游任务且未扣费；继续时沿用原分镜与原请求"
      };
    }
    if (status === "failed" && upstreamSubmissionState(job) === "unknown" && canResumeStableSubmission(job)) {
      return {
        key: "missing",
        label: "原提交待恢复",
        candidate: null,
        job,
        activeJob: null,
        progress,
        detail: "当前不占用队列；继续时只复用原幂等键找回同一任务，不会重复生成"
      };
    }
    if (status === "failed" && upstreamSubmissionState(job) === "not_created" && canResumeStableSubmission(job)) {
      return {
        key: "missing",
        label: "已暂停，可继续",
        candidate: null,
        job,
        activeJob: null,
        progress,
        detail: "尚未创建上游任务且未扣费；继续时沿用原分镜、原提示词与原请求身份"
      };
    }
    if (status === "failed" || status === "error" || (ACTIVE_JOB_STATUSES.has(status) && !job?.taskId)) {
      return {
        key: "failed",
        label: status === "failed" || status === "error" ? "生成失败" : "未真正提交",
        candidate: null,
        job,
        activeJob: null,
        progress,
        detail: job?.message || (job?.taskId ? "视频生成失败，可返回分镜视频重试" : "本地显示进行中，但没有上游任务 ID；请重新抽卡")
      };
    }
    return { key: "missing", label: "缺视频", candidate: null, job, activeJob: null, progress: videoJobProgress(null), detail: "该镜头尚无可用视频" };
  }

  function summarizeShotVideos(project, settings = null) {
    const states = (project?.shots || []).map(shot => ({ shot, ...shotVideoState(project, shot, settings) }));
    const summary = {
      total: states.length,
      ready: 0,
      generating: 0,
      partial: 0,
      failed: 0,
      missing: 0,
      states
    };
    for (const item of states) {
      summary[item.key] += 1;
      if (item.key !== "generating" && item.activeJob) summary.generating += 1;
    }
    summary.remaining = summary.total - summary.ready;
    summary.allReady = summary.total > 0 && summary.ready === summary.total;
    return summary;
  }

  function hasCurrentFinal(project) {
    return Boolean(project?.finalVideoPath) && project.finalVideoStale !== true
      && project.runtime?.finalVideoAvailable !== false;
  }

  function projectDisplayStatus(project) {
    return project?.status === "completed" && !hasCurrentFinal(project)
      ? "final_pending" : project?.status || "draft";
  }

  function scriptWorkflowScope(automation = {}) {
    const operation = String(automation.operation || ""), stage = String(automation.stage || "");
    const operations = ["analyze_script", "idea_script", "idea_to_full_pipeline", "full_pipeline", "script_adaptation"];
    return {
      scriptOperation: operations.includes(operation) || (operation === "pipeline_from_stage" && automation.targetId === "script"),
      inScriptStage: ["script", "adaptive_script_", "uploaded_script_", "shot_screenplay_"].some(prefix => stage.startsWith(prefix)) || operations.includes(stage)
    };
  }

  function automationDisplayState(project, automation = project?.automation || {}) {
    if (automation.status !== "completed" || hasCurrentFinal(project)) return automation;
    return { ...automation, status: "final_pending", stage: "stitch",
      message: project?.finalVideoStale ? "成片已过期，请用当前分镜重新粗剪。" : "尚无可用成片，请完成智能粗剪。" };
  }

  return {
    scriptWorkflowScope,
    hasCurrentFinal,
    projectDisplayStatus,
    automationDisplayState,
    VIDEO_SUBMISSION_PHANTOM_AFTER_MS,
    VIDEO_IDENTIFIED_SUBMISSION_PHANTOM_AFTER_MS,
    hasStableSubmissionIdentity,
    upstreamSubmissionState,
    hasCreatedUpstreamTask,
    canResumeStableSubmission,
    newest,
    videoJobAgeMs,
    isPhantomVideoJob,
    isActiveVideoJob,
    latestVideoJobs,
    activeVideoJobs,
    videoJobProgress,
    videoJobProvider,
    videoJobStage,
    candidateQualityAccepted,
    shotVideoCandidate,
    failedShotVideoCandidate,
    unverifiedShotVideoCandidate,
    shotVideoJob,
    recoveredShotVideoBlocks,
    shotVideoState,
    summarizeShotVideos
  };
});
