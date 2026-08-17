"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fingerprint } = require("./canonical");

function candidateTimestamp(candidate = {}) {
  const parsed = Date.parse(candidate.updatedAt || candidate.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function bindingKey(candidate = {}) {
  return `${String(candidate.entityType || "unknown")}:${String(candidate.entityId || "")}:${String(candidate.stage || "")}`;
}

function fileIdentity(candidate = {}) {
  const filePath = String(candidate.filePath || "").trim();
  if (!filePath) return { path: "", exists: false, size: 0, mtimeMs: 0, contentHash: String(candidate.sha256 || candidate.fileSha256 || "") };
  try {
    const stat = fs.statSync(filePath);
    return { path: path.resolve(filePath), exists: stat.isFile(), size: stat.size, mtimeMs: Math.round(stat.mtimeMs), contentHash: String(candidate.sha256 || candidate.fileSha256 || "") };
  } catch {
    return { path: path.resolve(filePath), exists: false, size: 0, mtimeMs: 0, contentHash: String(candidate.sha256 || candidate.fileSha256 || "") };
  }
}

function downstreamRoles(stage = "") {
  if (stage === "character_intro") return { allowed: ["identity_reference", "voice_source"], forbidden: ["story_scene", "final_video", "opening_intro"] };
  if (["character_sheet", "character_three_view"].includes(stage)) return { allowed: ["identity_reference", "storyboard_reference", "video_reference"], forbidden: ["final_video_direct_insert", "opening_intro"] };
  if (stage === "scene_asset") return { allowed: ["storyboard_reference", "video_reference"], forbidden: ["final_video_direct_insert"] };
  if (stage.startsWith("storyboard_")) return { allowed: ["video_reference"], forbidden: ["final_video_direct_insert"] };
  if (stage === "shot_video") return { allowed: ["final_video"], forbidden: [] };
  return { allowed: ["reference"], forbidden: [] };
}

function buildPassport(project, candidate, activeCandidateId, contract = {}) {
  const file = fileIdentity(candidate);
  const key = bindingKey(candidate);
  const stage = String(candidate.stage || "");
  const active = String(candidate.id || "") === String(activeCandidateId || "");
  const productionRevision = String(project.productionRevision || "");
  const revisionMatch = !candidate.productionRevision || !productionRevision || String(candidate.productionRevision) === productionRevision;
  // 与工作流侧 qualityAccepted 语义对齐：仅显式的人工选择豁免
  // （manualSelectionOverride）可以越过质检；「来源是手动导入」本身不是豁免，
  // 否则手动导入但质检失败的资产在护照里 eligible、在工作流里被拦，两道门禁打架。
  const qualityAccepted = candidate.qualityAudit?.ok === true || candidate.qualityAudit?.accepted === true || candidate.manualSelectionOverride === true;
  const backgroundVerified = !["character_sheet", "character_three_view"].includes(stage)
    || candidate.qualityAudit?.uniformBackground === true
    || candidate.qualityAudit?.backgroundColor === contract.policies?.characterSheet?.background?.fixedColor;
  let status = "eligible";
  const issues = [];
  if (!file.exists && !/^https?:\/\//i.test(String(candidate.remoteUrl || candidate.fileUrl || ""))) { status = "missing"; issues.push("asset_file_missing"); }
  if (candidate.stale === true || candidate.staleByDependency === true || !revisionMatch) { status = "stale"; issues.push("dependency_or_revision_stale"); }
  if (candidate.qualityAudit?.ok === false && !qualityAccepted) { status = "rejected"; issues.push("quality_rejected"); }
  if (!backgroundVerified && status === "eligible") { status = "review_required"; issues.push("uniform_background_not_verified"); }
  const dependencyPayload = {
    productionRevision,
    referenceManifest: candidate.referenceManifest || null,
    sourceAsset: candidate.sourceAsset || null,
    promptFingerprint: candidate.promptFingerprint || fingerprint(String(candidate.prompt || "")),
    contractFingerprint: String(contract.fingerprint || "")
  };
  const assetPayload = { key, file, remoteUrl: String(candidate.remoteUrl || candidate.fileUrl || ""), upstreamHash: String(candidate.sha256 || candidate.fileSha256 || ""), stage };
  return {
    version: "foundry.asset-passport.v1",
    passportId: `passport_${fingerprint({ projectId: project.id, candidateId: candidate.id }).slice(0, 32)}`,
    projectId: String(project.id || ""),
    candidateId: String(candidate.id || ""),
    bindingKey: key,
    kind: String(candidate.entityType || "unknown"),
    entityId: String(candidate.entityId || ""),
    stage,
    source: String(candidate.source || "unknown"),
    assetFingerprint: fingerprint(assetPayload),
    dependencyFingerprint: fingerprint(dependencyPayload),
    file,
    active: active && ["eligible", "review_required"].includes(status),
    selected: candidate.selected === true,
    status,
    issues,
    downstream: downstreamRoles(stage),
    quality: {
      accepted: qualityAccepted,
      uniformBackgroundVerified: backgroundVerified,
      fixedBackgroundColor: ["character_sheet", "character_three_view"].includes(stage) ? contract.policies?.characterSheet?.background?.fixedColor || "#E9E9E9" : ""
    },
    createdAt: String(candidate.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString()
  };
}

function buildAssetPassports(project = {}, contract = {}) {
  const candidates = Array.isArray(project.candidates) ? project.candidates : [];
  const groups = new Map();
  for (const candidate of candidates) {
    const key = bindingKey(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const activeIds = new Map();
  for (const [key, items] of groups) {
    const currentRevision = items.filter(item => !item.productionRevision || !project.productionRevision || item.productionRevision === project.productionRevision);
    const selected = currentRevision.filter(item => item.selected === true && item.stale !== true).sort((left, right) => candidateTimestamp(right) - candidateTimestamp(left));
    const fallback = currentRevision.filter(item => item.filePath && item.stale !== true).sort((left, right) => candidateTimestamp(right) - candidateTimestamp(left));
    activeIds.set(key, String((selected[0] || fallback[0])?.id || ""));
  }
  const passports = candidates.map(candidate => buildPassport(project, candidate, activeIds.get(bindingKey(candidate)), contract));
  const bindings = {};
  for (const passport of passports.filter(item => item.active)) bindings[passport.bindingKey] = passport.passportId;
  return { passports, bindings };
}

function applyAssetPassports(project = {}, contract = {}) {
  const result = buildAssetPassports(project, contract);
  project.foundry = {
    ...(project.foundry || {}),
    assetRegistry: {
      version: 1,
      updatedAt: new Date().toISOString(),
      activeBindings: result.bindings,
      passportCount: result.passports.length,
      activeCount: Object.keys(result.bindings).length,
      reviewRequiredCount: result.passports.filter(item => item.status === "review_required").length
    }
  };
  return result;
}

function assetPromptPolicy(stage, contract = {}) {
  if (["character_sheet", "character_three_view"].includes(String(stage))) {
    const background = contract.policies?.characterSheet?.background?.fixedColor || "#E9E9E9";
    return `固定人物四视图合板：只有正面全身、左侧全身、右侧全身、背面全身四个等比例视图；整张图唯一统一背景色 ${background}；无肖像大头、无烟雾、无渐变、无地面场景、无装饰、无文字、无道具堆叠。`;
  }
  if (stage === "scene_asset") return "固定场景四视图：同一地点、统一建筑和摆设、无人物、无文字，四个视角不得画成四个不同场景。";
  return "";
}

module.exports = { applyAssetPassports, assetPromptPolicy, bindingKey, buildAssetPassports, buildPassport };
