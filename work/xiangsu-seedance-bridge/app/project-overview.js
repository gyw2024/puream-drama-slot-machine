"use strict";

const { isActiveVideoJob } = require("./workbench-status");

function latestCandidate(project, entityType, entityId, stage) {
  const activeRevision = project.productionRevision || "";
  const revisionMatches = (project.candidates || [])
    .filter(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage)
    .filter(item => (item.productionRevision || "") === activeRevision)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const manualSelection = revisionMatches.find(item => item.selected === true && item.manualSelectionOverride === true && item.filePath);
  if (manualSelection) return manualSelection;
  const matches = revisionMatches.filter(item => item.stale !== true);
  return matches.find(item => item.selected) || matches[0] || null;
}

function latestCandidateIncludingStale(project, entityType, entityId, stage) {
  return latestCandidate(project, entityType, entityId, stage) || (() => {
    const activeRevision = project.productionRevision || "";
    const matches = (project.candidates || [])
      .filter(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage)
      .filter(item => (item.productionRevision || "") === activeRevision)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return matches.find(item => item.selected) || matches[0] || null;
  })();
}

function hasFile(candidate, settings = null, moduleName = "assets") {
  const qualityRequired = settings?.generation?.qualityGatesEnabled === true
    && settings?.generation?.qualityGateModules?.[moduleName] === true;
  const humanAccepted = candidate?.manualSelectionOverride === true
    || candidate?.qualityAudit?.accepted === true
    || candidate?.qualityAudit?.overridden === true
    || ["manual", "human_override", "advisory_continue"].includes(String(candidate?.qualityAudit?.mode || ""));
  return Boolean(candidate?.filePath) && (!qualityRequired || humanAccepted || candidate.qualityAudit?.ok !== false);
}

function characterIdentityCandidate(project, character, settings = null) {
  const stages = new Set(["character_sheet", "character_three_view", "character_intro"]);
  const activeRevision = project.productionRevision || "";
  const matches = (project.candidates || [])
    .filter(item => item.entityType === "character" && item.entityId === character.id && stages.has(item.stage))
    .filter(item => (item.productionRevision || "") === activeRevision && item.stale !== true && hasFile(item, settings, "assets"));
  const active = matches.find(item => item.id === character.activeIdentityCandidateId);
  if (active) return active;
  const byRecency = (left, right) => String(right.manualSelectedAt || right.updatedAt || right.createdAt || "")
    .localeCompare(String(left.manualSelectedAt || left.updatedAt || left.createdAt || ""));
  // character_intro is a private frontal voice/identity anchor. Keep the
  // reusable four-view board as the visible identity whenever one exists.
  return matches.filter(item => item.selected === true && item.manualSelectionOverride === true).sort(byRecency)[0]
    || latestCandidate(project, "character", character.id, "character_sheet")
    || latestCandidate(project, "character", character.id, "character_three_view")
    || latestCandidate(project, "character", character.id, "character_intro");
}

function stageCounts(project = {}, settings = null) {
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const characters = Array.isArray(project.characters) ? project.characters : [];
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const wardrobes = Array.isArray(project.assetLibraries?.wardrobes) ? project.assetLibraries.wardrobes : [];
  const props = Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [];
  const videoReady = shots.filter(shot => hasFile(latestCandidate(project, "shot", shot.id, "shot_video"), settings, "videos")).length;
  const mode = ["keyframe", "smart", "storyboard_sheet"].includes(project.generation?.mode) ? project.generation.mode : "continuation";
  const storyboardReady = shots.filter(shot => {
    if (mode === "storyboard_sheet") return hasFile(latestCandidate(project, "shot", shot.id, "storyboard_sheet"), settings, "storyboards");
    let stages = ["storyboard_start", "storyboard_end"];
    if (mode === "continuation" && Number(shot.number) > 1) stages = ["storyboard_end"];
    if (mode === "smart" && Number(shot.number) > 1) {
      const previous = shots.find(item => Number(item.number) === Number(shot.number) - 1);
      const prevKey = String(previous?.sceneId || "").trim() || (previous?.sceneName ? `name:${previous.sceneName}` : "");
      const curKey = String(shot.sceneId || "").trim() || (shot.sceneName ? `name:${shot.sceneName}` : "");
      if (previous && prevKey && curKey && prevKey === curKey) stages = ["storyboard_end"];
    }
    return stages.every(stage => hasFile(latestCandidate(project, "shot", shot.id, stage), settings, "storyboards"));
  }).length;
  const characterReady = characters.filter(character => hasFile(characterIdentityCandidate(project, character, settings), settings, "assets")).length;
  const sceneReady = scenes.filter(scene => hasFile(latestCandidate(project, "scene", scene.id, "scene_asset"), settings, "assets")).length;
  const wardrobeReady = wardrobes.filter(item => hasFile(latestCandidate(project, "library", item.id, "wardrobe_asset"), settings, "assets")).length;
  const propReady = props.filter(item => hasFile(latestCandidate(project, "library", item.id, "prop_asset"), settings, "assets")).length;
  return {
    characters: { ready: characterReady, total: characters.length },
    scenes: { ready: sceneReady, total: scenes.length },
    wardrobes: { ready: wardrobeReady, total: wardrobes.length },
    props: { ready: propReady, total: props.length },
    storyboards: { ready: storyboardReady, total: shots.length },
    videos: { ready: videoReady, total: shots.length },
    shots: shots.length,
    hasScript: Boolean(String(project.script?.raw || "").trim()),
    hasFinal: Boolean(project.finalVideoPath),
    costKnown: Number(project.costLedger?.summary?.totalKnownYuan || 0),
    costEstimated: Number(project.costLedger?.summary?.totalEstimatedYuan || 0),
    costUnpriced: Number(project.costLedger?.summary?.unpricedCount || 0),
    costPending: Number(project.costLedger?.summary?.pendingCount || 0)
  };
}

function inferNextStage(project = {}, counts = stageCounts(project)) {
  if (!counts.hasScript || !counts.shots) return "script";
  if (counts.characters.ready < counts.characters.total || counts.scenes.ready < counts.scenes.total || counts.wardrobes.ready < counts.wardrobes.total || counts.props.ready < counts.props.total) return "assets";
  if (counts.storyboards.ready < counts.storyboards.total) return "shots";
  if (counts.videos.ready < counts.videos.total) return "videos";
  return "final";
}

function automationLabel(project = {}) {
  const status = project.automation?.status || "";
  return ({
    running: "运行中",
    pausing: "暂停中",
    stopping: "停止中",
    paused_user: "已暂停",
    paused_account: "等切号",
    interrupted: "已中断",
    completed: "空闲",
    idle: "空闲",
    failed: "可恢复断点",
    cancelled: "已取消"
  })[status] || (status || "空闲");
}

function automationTone(status = "") {
  const value = String(status || "");
  if (["failed", "interrupted", "paused_user", "paused_account", "pausing", "stopping", "cancelled"].includes(value)) return "warn";
  if (["running"].includes(value)) return "active";
  return "idle";
}

function summarizeProjectOverview(project = {}, settings = null) {
  const counts = stageCounts(project, settings);
  const nextStage = inferNextStage(project, counts);
  const jobs = Array.isArray(project.jobs) ? project.jobs : [];
  const activeJobs = jobs.filter(job => {
    const status = String(job.status || "").toLowerCase();
    if (!["queued", "pending", "submitted", "running", "processing", "uploading", "waiting", "remote_pending", "download_pending"].includes(status)) return false;
    if (["shot_video", "character_video"].includes(job.type || job.jobType)) return isActiveVideoJob(job);
    return true;
  }).length;
  return {
    id: project.id,
    title: project.title || "未命名项目",
    status: project.status || "draft",
    currentStage: project.currentStage || "script",
    nextStage,
    updatedAt: project.updatedAt || project.createdAt || null,
    automation: {
      status: project.automation?.status || "",
      label: automationLabel(project),
      tone: automationTone(project.automation?.status || ""),
      operation: project.automation?.operation || "",
      stage: project.automation?.stage || "",
      message: project.automation?.message || "",
      active: typeof project.runtime?.active === "boolean"
        ? project.runtime.active
        : ["running", "pausing", "stopping"].includes(project.automation?.status)
    },
    counts,
    activeJobs,
    progressPercent: (() => {
      const assetTotal = counts.characters.total + counts.scenes.total + counts.wardrobes.total + counts.props.total;
      const assetReady = counts.characters.ready + counts.scenes.ready + counts.wardrobes.ready + counts.props.ready;
      if (!counts.hasScript) return 0;
      if (!counts.shots) return 10;
      const scriptPart = 8;
      const assetPart = assetTotal ? Math.round((assetReady / assetTotal) * 22) : 12;
      const boardPart = counts.shots ? Math.round((counts.storyboards.ready / counts.shots) * 20) : 0;
      const videoPart = counts.shots ? Math.round((counts.videos.ready / counts.shots) * 30) : 0;
      const finalPart = counts.hasFinal ? 20 : 0;
      return Math.min(100, scriptPart + assetPart + boardPart + videoPart + finalPart);
    })()
  };
}

function listProjectsOverview(projects = [], settings = null) {
  return (Array.isArray(projects) ? projects : [])
    .map(project => summarizeProjectOverview(project, settings))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

module.exports = {
  automationLabel,
  automationTone,
  inferNextStage,
  listProjectsOverview,
  stageCounts,
  summarizeProjectOverview
};
