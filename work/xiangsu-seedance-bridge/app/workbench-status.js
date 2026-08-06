"use strict";

(function registerWorkbenchStatus(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DramaSlotStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const ACTIVE_JOB_STATUSES = new Set([
    "queued", "pending", "submitted", "running", "processing", "uploading", "waiting"
  ]);

  const VIDEO_JOB_TYPES = new Set(["character_video", "shot_video"]);

  function newest(items) {
    return items.slice().sort((a, b) => {
      const aTime = String(a.updatedAt || a.createdAt || "");
      const bTime = String(b.updatedAt || b.createdAt || "");
      return bTime.localeCompare(aTime);
    })[0] || null;
  }

  function isActiveVideoJob(job) {
    return Boolean(job && VIDEO_JOB_TYPES.has(job.type) && ACTIVE_JOB_STATUSES.has(String(job.status || "").toLowerCase()));
  }

  function latestVideoJobs(project) {
    const latest = new Map();
    const activeRevision = project?.productionRevision || "";
    for (const job of project?.jobs || []) {
      if (!VIDEO_JOB_TYPES.has(job?.type)) continue;
      if ((job.productionRevision || "") !== activeRevision) continue;
      const key = `${job.type}:${job.entityType || ""}:${job.entityId || job.id || ""}`;
      const previous = latest.get(key);
      if (!previous || newest([previous, job]) === job) latest.set(key, job);
    }
    return [...latest.values()].sort((a, b) => {
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
    if (job?.providerKind === "puream-hailuo-h3" || job?.videoEngine === "hailuo-h3") return "海螺 H3 云端";
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

  function shotVideoCandidate(project, shot) {
    const activeRevision = project?.productionRevision || "";
    const matches = (project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
      && (item.productionRevision || "") === activeRevision
      && item.qualityAudit?.ok === true
    );
    return matches.find(item => item.selected) || newest(matches);
  }

  function failedShotVideoCandidate(project, shot) {
    const activeRevision = project?.productionRevision || "";
    return newest((project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
      && (item.productionRevision || "") === activeRevision
      && item.qualityAudit?.ok === false
    ));
  }

  function unverifiedShotVideoCandidate(project, shot) {
    const activeRevision = project?.productionRevision || "";
    return newest((project?.candidates || []).filter(item =>
      item.entityType === "shot"
      && item.entityId === shot?.id
      && item.stage === "shot_video"
      && item.filePath
      && (item.productionRevision || "") === activeRevision
      && item.qualityAudit?.ok !== true
      && item.qualityAudit?.ok !== false
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

  function shotVideoState(project, shot) {
    const candidate = shotVideoCandidate(project, shot);
    const failedCandidate = failedShotVideoCandidate(project, shot);
    const unverifiedCandidate = unverifiedShotVideoCandidate(project, shot);
    const job = shotVideoJob(project, shot);
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
        detail: (failedCandidate.qualityAudit?.failures || []).map(item => item.message).join("；") || "音画质检未通过，必须重抽"
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
        detail: "该视频尚未完成声音、重复画面和首帧资产串线质检，暂不能进入成片"
      };
    }

    const status = String(job?.status || "").toLowerCase();
    const progress = videoJobProgress(job);
    if (ACTIVE_JOB_STATUSES.has(status)) {
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
    if (status === "failed" || status === "error") {
      return {
        key: "failed",
        label: "生成失败",
        candidate: null,
        job,
        activeJob: null,
        progress,
        detail: job?.message || "视频生成失败，可返回分镜视频重试"
      };
    }
    return { key: "missing", label: "缺视频", candidate: null, job, activeJob: null, progress: videoJobProgress(null), detail: "该镜头尚无可用视频" };
  }

  function summarizeShotVideos(project) {
    const states = (project?.shots || []).map(shot => ({ shot, ...shotVideoState(project, shot) }));
    const summary = {
      total: states.length,
      ready: 0,
      generating: 0,
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
    isActiveVideoJob,
    latestVideoJobs,
    activeVideoJobs,
    videoJobProgress,
    videoJobProvider,
    videoJobStage,
    shotVideoCandidate,
    failedShotVideoCandidate,
    unverifiedShotVideoCandidate,
    shotVideoJob,
    shotVideoState,
    summarizeShotVideos
  };
});
