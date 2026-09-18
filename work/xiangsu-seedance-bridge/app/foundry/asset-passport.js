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
  if (stageRegistry.requiresUniformCharacterBackground(stage)) return { allowed: ["identity_reference", "storyboard_reference", "video_reference"], forbidden: ["final_video_direct_insert", "opening_intro"] };
  if (stage === "scene_asset") return { allowed: ["storyboard_reference", "video_reference"], forbidden: ["final_video_direct_insert"] };
  if (stage.startsWith("storyboard_")) return { allowed: ["video_reference"], forbidden: ["final_video_direct_insert"] };
  if (stage === "shot_video") return { allowed: ["final_video"], forbidden: [] };
  return { allowed: ["reference"], forbidden: [] };
}

// 已知合法的资产阶段。缺 stage 或 stage 不在集合内时，不能自动签发可生产护照：
// 否则 `includes("")` 为 false 会让背景校验被静默跳过，
// 把「白背景验证不适用」误判成「所有质量验证通过」（GPT 裁决 §2.1）。
//
// §9.4：名单不得在此手抄。唯一权威是 app/asset-stage-registry.js，
// 否则新增合法 stage 时只有本模块忘了更新。
const stageRegistry = require('../asset-stage-registry');
const KNOWN_ASSET_STAGES = stageRegistry.ALL_ASSET_STAGES;
const requiresUniformCharacterBackground = stageRegistry.requiresUniformCharacterBackground;

function isKnownStage(stage = "") {
  return stageRegistry.isKnownAssetStage(stage);
}

function buildPassport(project, candidate, activeCandidateId, contract = {}) {
  const file = fileIdentity(candidate);
  const key = bindingKey(candidate);
  const active = String(candidate.id || "") === String(activeCandidateId || "");
  const productionRevision = String(project.productionRevision || "");
  const isHumanConfirmed = candidate.selected === true || candidate.manualSelectionOverride === true;
  const revisionMatch = !candidate.productionRevision || !productionRevision || String(candidate.productionRevision) === productionRevision || isHumanConfirmed;
  // 与工作流侧 qualityAccepted 语义对齐：仅显式的人工选择豁免
  // （manualSelectionOverride）可以越过质检；「来源是手动导入」本身不是豁免，
  // 否则手动导入但质检失败的资产在护照里 eligible、在工作流里被拦，两道门禁打架。
  const qualityAccepted = candidate.qualityAudit?.ok === true || candidate.qualityAudit?.accepted === true || candidate.manualSelectionOverride === true;
  const stage = String(candidate.stage || "");
  const stageKnown = isKnownStage(stage);
  const needsUniformBackground = stageRegistry.requiresUniformCharacterBackground(stage);
  // §9.4：三态，不得把「背景规则不适用」和「候选所有质量要求已通过」混成一件事。
  //   true  = 适用于本阶段且已验证通过
  //   false = 适用于本阶段但未验证通过
  //   null  = 本阶段不适用该规则（既不是通过，也不是失败）
  // 注意：不得用 `candidate.backgroundColor === contract.color` 这种写法，
  // 因为合同缺失时两侧都是 undefined，会误判成「已验证通过」。
  const contractBackgroundColor = String(contract.policies?.characterSheet?.background?.fixedColor || "");
  const backgroundVerified = !needsUniformBackground
    ? null
    : candidate.qualityAudit?.uniformBackground === true
      || (contractBackgroundColor !== "" && candidate.qualityAudit?.backgroundColor === contractBackgroundColor);
  let status = "eligible";
  const issues = [];
  if (!stageKnown) { status = "needs_validation"; issues.push("unknown_asset_stage"); }
  if (!file.exists && !/^https?:\/\//i.test(String(candidate.remoteUrl || candidate.fileUrl || ""))) { status = stageKnown ? "missing" : status; if (!issues.includes("asset_file_missing")) issues.push("asset_file_missing"); }
  if (candidate.stale === true || candidate.staleByDependency === true || !revisionMatch) { status = stageKnown ? "stale" : status; if (!issues.includes("dependency_or_revision_stale")) issues.push("dependency_or_revision_stale"); }
  if (candidate.qualityAudit?.ok === false && !qualityAccepted) { status = stageKnown ? "rejected" : status; if (!issues.includes("quality_rejected")) issues.push("quality_rejected"); }
  if (backgroundVerified === false && status === "eligible") { status = "review_required"; issues.push("uniform_background_not_verified"); }
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
      fixedBackgroundColor: needsUniformBackground ? contract.policies?.characterSheet?.background?.fixedColor || "#E9E9E9" : ""
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
    const currentRevision = items.filter(item => !item.productionRevision || !project.productionRevision || item.productionRevision === project.productionRevision || item.selected === true || item.manualSelectionOverride === true);
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
  if (requiresUniformCharacterBackground(String(stage))) {
    const background = contract.policies?.characterSheet?.background?.fixedColor || "#E9E9E9";
    return `固定人物四视图合板：只有正面全身、左侧全身、右侧全身、背面全身四个等比例视图；整张图唯一统一背景色 ${background}；无肖像大头、无烟雾、无渐变、无地面场景、无装饰、无文字、无道具堆叠。`;
  }
  if (stage === "scene_asset") return "固定场景四视图：同一地点、统一建筑和摆设、无人物、无文字，四个视角不得画成四个不同场景。";
  return "";
}

module.exports = { applyAssetPassports, assetPromptPolicy, bindingKey, buildAssetPassports, buildPassport };
