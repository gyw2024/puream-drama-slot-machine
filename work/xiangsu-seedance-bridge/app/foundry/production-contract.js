"use strict";

const { fingerprint } = require("./canonical");
const { ERROR_KINDS, FoundryError } = require("./errors");

const CONTRACT_VERSION = "foundry.production-contract.v1";
const SCRIPT_HANDLING = new Set(["respect", "optimize", "recreate"]);
const COMMERCE_MODES = new Set(["none", "natural", "explicit"]);
const PRIORITY_PROFILES = new Set(["speed", "balanced", "quality"]);

function normalizeScriptHandling(value, project = {}) {
  const requested = String(value || "").trim().toLowerCase();
  if (SCRIPT_HANDLING.has(requested)) return requested;
  return project?.productionPlan?.inputMode === "manual" ? "respect" : "optimize";
}

function normalizeCommerceMode(value, project = {}) {
  const requested = String(value || "").trim().toLowerCase();
  if (COMMERCE_MODES.has(requested)) return requested;
  return String(project?.product?.name || "").trim() ? "natural" : "none";
}

function normalizePriorityProfile(value) {
  const requested = String(value || "").trim().toLowerCase();
  return PRIORITY_PROFILES.has(requested) ? requested : "balanced";
}

function contractPayload(project = {}, settings = {}) {
  const plan = project.productionPlan || {};
  const generation = project.generation || {};
  const scriptHandling = normalizeScriptHandling(plan.scriptHandling, project);
  const commerceMode = normalizeCommerceMode(plan.commerceMode, project);
  const priorityProfile = normalizePriorityProfile(plan.priorityProfile);
  const productName = String(project.product?.name || "").trim();
  return {
    version: CONTRACT_VERSION,
    intent: {
      scriptHandling,
      commerceMode: productName ? commerceMode : "none",
      priorityProfile,
      executionMode: plan.executionMode === "full" ? "full" : "step",
      inputMode: plan.inputMode === "manual" ? "manual" : "ai",
      scriptFormat: String(plan.scriptFormat || "production"),
      videoMode: String(generation.mode || settings.generation?.mode || "continuation"),
      videoProviderKind: String(generation.videoProviderKind || settings.videoProvider?.kind || "")
    },
    facts: {
      title: String(project.title || "").trim(),
      productName,
      productSellingPoints: String(project.product?.sellingPoints || project.product?.description || "").trim(),
      targetDurationSeconds: Math.max(1, Math.round(Number(generation.targetDurationSeconds) || 300)),
      aspectRatio: String(generation.aspectRatio || settings.generation?.aspectRatio || "9:16"),
      commerceShotCount: productName && commerceMode !== "none" ? Math.max(1, Math.round(Number(plan.commerceShotCount) || 3)) : 0
    },
    authority: [
      "user_facts_and_absolute_bans",
      "uploaded_source_evidence",
      "project_mode_contract",
      "story_and_identity_continuity",
      "provider_capability",
      "quality_profile",
      "model_suggestion"
    ],
    policies: {
      subtitles: { allowed: false, hard: true, includes: ["字幕", "caption", "title_card", "name_tag", "price_text", "watermark"] },
      backgroundMusic: { allowed: false, hard: true, includes: ["BGM", "music_bed", "soundtrack"] },
      generatedScreenText: { allowed: false, hard: true, exception: "legible_text_explicitly_required_by_story_fact" },
      characterIntroductionInFinal: { allowed: false, hard: true },
      sourceMetadataInFinal: { allowed: false, hard: true, includes: ["character_bio", "story_synopsis", "production_note"] },
      audio: { allowed: ["spoken_dialogue", "synchronous_action_sound", "location_ambience"], forbidden: ["background_music", "narration_unless_user_scripted"] },
      characterSheet: {
        layout: "fixed_four_view",
        views: ["front_full", "left_profile", "right_profile", "back_full"],
        background: { uniform: true, fixedColor: "#E9E9E9", gradient: false, texture: false, smoke: false, vignette: false },
        composition: { fullBodyAllViews: true, equalScale: true, noPortraitInset: true, noCollageDecoration: true, noText: true }
      },
      sceneAsset: { layout: "fixed_four_view", noPeople: true, noText: true, preserveArchitecture: true },
      formalFallback: { localMechanicalStory: "diagnostic_only", mayEnterPaidGeneration: false, mayBeLabeledComplete: false }
    },
    quality: {
      minimumFormalLevel: 2,
      targetLevel: 3,
      canaryPolicy: priorityProfile === "speed" ? "minimum_safe" : priorityProfile === "quality" ? "risk_first_extended" : "risk_first",
      creativeRepair: scriptHandling === "respect" ? "structure_only_preserve_facts" : scriptHandling === "recreate" ? "rebuild_with_fact_lock" : "scoped_improvement"
    }
  };
}

function compileProductionContract(project = {}, settings = {}, options = {}) {
  const payload = contractPayload(project, settings);
  const contractFingerprint = fingerprint(payload);
  const prior = project?.foundry?.contract;
  return {
    ...payload,
    fingerprint: contractFingerprint,
    compiledAt: prior?.fingerprint === contractFingerprint && prior?.compiledAt
      ? prior.compiledAt
      : String(options.now || new Date().toISOString()),
    source: String(options.source || "project")
  };
}

function applyProductionContract(project = {}, settings = {}, options = {}) {
  const contract = compileProductionContract(project, settings, options);
  project.productionPlan = {
    ...(project.productionPlan || {}),
    scriptHandling: contract.intent.scriptHandling,
    commerceMode: contract.intent.commerceMode,
    priorityProfile: contract.intent.priorityProfile
  };
  project.foundry = {
    ...(project.foundry || {}),
    version: 2,
    contract
  };
  return contract;
}

function assertAbsolutePolicies(contract = {}) {
  const failures = [];
  if (contract.policies?.subtitles?.allowed !== false) failures.push("subtitles");
  if (contract.policies?.backgroundMusic?.allowed !== false) failures.push("background_music");
  if (contract.policies?.characterIntroductionInFinal?.allowed !== false) failures.push("character_intro");
  if (contract.policies?.characterSheet?.background?.uniform !== true || !contract.policies?.characterSheet?.background?.fixedColor) failures.push("character_sheet_background");
  if (failures.length) {
    throw new FoundryError(`生产合同绝对禁令被篡改：${failures.join("、")}`, {
      code: "FOUNDRY_ABSOLUTE_POLICY_VIOLATION",
      kind: ERROR_KINDS.CONTRACT_VIOLATION,
      details: { failures }
    });
  }
  return true;
}

function contractPromptBlock(contract = {}) {
  assertAbsolutePolicies(contract);
  const handling = { respect: "尊重原稿：锁定事实、关系、事件顺序、对白与结局，只做制作结构化", optimize: "优化原稿：不改核心事实与结局，允许定点优化对白、节奏和因果", recreate: "重新创作：保留用户确认的事实锁，其余可重建" }[contract.intent?.scriptHandling] || "尊重原稿";
  const commerce = { none: "无带货：不得出现商品导购、价格或购买引导", natural: "自然植入：商品只能因角色的真实任务与剧情因果出现", explicit: "明确带货：允许角色口头讲解用户提供的事实，但不允许字幕、价格字或虚构功效" }[contract.intent?.commerceMode] || "无带货";
  return [
    `【V2生产合同 ${contract.fingerprint || ""}】`,
    handling,
    commerce,
    "绝对禁令：成片不得出现任何字幕、标题、姓名条、价格字、水印、背景音乐、人物介绍、人物小传或故事简介。",
    "只允许：剧中角色对白、与画面同步的动作声和场景环境声。",
    "人物四视图必须是固定 #E9E9E9 纯色背景、四个等比例全身、无肖像插图、无烟雾渐变、无装饰、无文字。",
    `正式出片最低质量等级 L${contract.quality?.minimumFormalLevel || 2}；低质量本地机械补位只能做诊断，不得进入付费生成。`
  ].join("\n");
}

module.exports = {
  COMMERCE_MODES,
  CONTRACT_VERSION,
  PRIORITY_PROFILES,
  SCRIPT_HANDLING,
  applyProductionContract,
  assertAbsolutePolicies,
  compileProductionContract,
  contractPromptBlock,
  normalizeCommerceMode,
  normalizePriorityProfile,
  normalizeScriptHandling
};
