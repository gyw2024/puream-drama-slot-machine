"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { promptReviewSourceFingerprint } = require("../app/workbench-workflow");

const root = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const projectId = process.env.JIUBAO_PROJECT_ID || "project_mti9zisf_dfd6e095";
const projectFile = process.env.JIUBAO_PROJECT_FILE || `${root}/projects/${projectId}/project.json`;
const project = JSON.parse(fs.readFileSync(projectFile, "utf8"));
const libraryDocument = JSON.parse(fs.readFileSync(`${root}/reusable-asset-library/index.json`, "utf8"));
const library = Array.isArray(libraryDocument) ? libraryDocument : (libraryDocument.assets || []);
const sha256 = filePath => filePath && fs.existsSync(filePath)
  ? crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase()
  : "";
const relevantCandidates = (project.candidates || [])
  .filter(item => item.selected === true && item.stale !== true)
  .filter(item => ["character_intro", "character_sheet", "character_three_view", "character_voice", "scene_asset", "prop_asset", "wardrobe_asset"].includes(item.stage))
  .map(item => ({
    id: item.id,
    entityType: item.entityType,
    entityId: item.entityId,
    stage: item.stage,
    reusableAssetId: item.reusableAssetId || "",
    voiceLibraryId: item.voiceLibraryId || "",
    filePath: item.filePath || "",
    sha256: sha256(item.filePath),
    imageTaskId: item.imageTaskId || "",
    remoteUrl: item.remoteUrl || ""
  }));
const sourceCandidateIds = new Set(relevantCandidates.map(item => item.id));
const projectLibraryEntries = library
  .filter(item => item.source?.projectId === projectId || sourceCandidateIds.has(item.source?.candidateId))
  .map(item => ({
    id: item.id,
    kind: item.kind,
    stage: item.stage,
    label: item.label,
    gender: item.gender || "",
    ageBand: item.ageBand || "",
    castingTier: item.castingTier || "",
    roleType: item.roleType || "",
    assetRequired: item.assetRequired !== false,
    tags: item.tags || [],
    sha256: String(item.sha256 || "").toUpperCase(),
    filePath: item.filePath || "",
    sourceEntityId: item.source?.entityId || "",
    sourceCandidateId: item.source?.candidateId || ""
  }));
const voice = relevantCandidates.find(item => item.entityId === "C10" && item.stage === "character_voice") || null;

process.stdout.write(`${JSON.stringify({
  projectId,
  projectFile,
  productionRevision: project.productionRevision,
  promptReview: {
    status: project.promptReview?.status || "",
    staleAt: project.promptReview?.staleAt || "",
    staleReason: project.promptReview?.staleReason || "",
    sourceFingerprint: project.promptReview?.sourceFingerprint || "",
    currentSourceFingerprint: promptReviewSourceFingerprint(project),
    settingsFingerprint: project.promptReview?.settingsFingerprint || "",
    itemCount: project.promptReview?.items?.length || 0,
    confirmed: (project.promptReview?.items || []).filter(item => item.status === "confirmed").length
  },
  selectedAssetCandidates: relevantCandidates,
  projectLibraryEntries,
  c10Voice: voice,
  videoJobs: (project.jobs || []).filter(job => job.type === "shot_video").map(job => ({
    id: job.id,
    entityId: job.entityId,
    status: job.status,
    taskId: job.taskId || "",
    submissionAttemptCount: Number(job.submissionAttemptCount) || 0
  }))
}, null, 2)}\n`);
