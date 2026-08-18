"use strict";

(function registerWorkbenchStatus(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DramaSlotStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const ACTIVE_JOB_STATUSES = new Set([
    "queued", "pending", "submitted", "running", "processing", "uploading", "waiting", "remote_pending", "download_pending"
  ]);

  const VIDEO_JOB_TYPES = new Set(["character_video", "shot_video"]);

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

function isPhantomVideoJob(job) {
  if (!job || !VIDEO_JOB_TYPES.has(job.type || job.jobType)) return false;
  const status = String(job.status || "").toLowerCase();
  if (!ACTIVE_JOB_STATUSES.has(status)) return false;
  if (job.taskId) return false;
  // Local placeholder with no upstream id: after 90s nobody is submitting.
  return videoJobAgeMs(job) > 90_000;
}

function isActiveVideoJob(job) {
  if (!job || !VIDEO_JOB_TYPES.has(job.type || job.jobType)) return false;
  const status = String(job.status || "").toLowerCase();
  if (!ACTIVE_JOB_STATUSES.has(status)) return false;
  if (isPhantomVideoJob(job)) return false;
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
    return latestVideoJobs(project).filter(isActiveVideoJob);
  }

  function videoJobProgress(job) {
    const status = String(job?.status || "").toLowerCase();
    if (status === "completed") {
      return { determinate: true, value: 100, label: "100%", source: "terminal" };
    }
    const numeric = Number(job?.progress);
    const trusted = job?.progressDeterminate === true
      || ["xiangsu", "upstream", "remote-api", "transfer"].includes(String(job?.progressSource || "").toLowerCase());
    if (trusted && Number.isFinite(numeric)) {
      const value = Math.max(0, Math.min(100, numeric));
      return { determinate: true, value, label: `${Math.round(value)}%`, source: job.progressSource || "upstream" };
    }
    return { determinate: false, value: null, label: "实时同步中", source: job?.progressSource || "status-only" };
  }

  function videoJobProvider(job) {
    // Character-video stage may run 纯梦 Grok/Gemini on a Hailuo/Seedance project.
    if (job?.providerKind === "puream-grok") return "纯梦 Grok 云端";
    if (job?.providerKind === "puream-gemini") return "纯梦 Gemini 云端";
    if (job?.providerKind === "puream-hailuo-h3" || job?.videoEngine === "hailuo-h3") return "纯梦云端算力";
    if (job?.providerKind === "puream-seedance") return "Seedance 云端";
    return "像塑";
  }

  function videoJobStage(job) {
    const status = String(job?.status || "").toLowerCase();
    const provider = videoJobProvider(job);
    if (status === "uploading") return "正在上传参考素材";
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

  function shotVideoCandidate(project, shot, settings = null) {
    const activeRevision = project?.productionRevision || "";
    const matches = (project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
      && (item.productionRevision || "") === activeRevision
      && candidateQualityAccepted(item, settings)
    );
    return matches.find(item => item.selected) || newest(matches);
  }

  function failedShotVideoCandidate(project, shot, settings = null) {
    if (!qualityGatesEnabled(settings)) return null;
    const activeRevision = project?.productionRevision || "";
    return newest((project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
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
    const activeJob = isActiveVideoJob(job) ? job : null;
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
    if (isActiveVideoJob(job)) {
      return {
        key: "generating",
        label: progress.determinate ? `生成中 ${progress.label}` : videoJobStage(job),
        candidate: null,
        job,
        activeJob: job,
        progress,
        detail: job?.message || "视频生成任务正在运行"
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

  return {
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
