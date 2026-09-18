"use strict";

const { fingerprint } = require("./canonical");
const { ERROR_KINDS, FoundryError } = require("./errors");

const CONTRACT_VERSION = "foundry.production-contract.v1";
const SCRIPT_HANDLING = new Set(["respect", "optimize", "recreate"]);
const COMMERCE_MODES = new Set(["none", "natural", "explicit"]);
const PRIORITY_PROFILES = new Set(["speed", "balanced", "quality"]);

// 意图字段的归一。
//
// GPT 裁决 §2.2 第 1 条：UI 写入非法枚举必须报错，不能把用户拼错的值
// 悄悄降级成某个默认值（否则用户以为选了 recreate，实际存成 optimize）。
// 因此这里区分两种情形：
//   · 字段缺失 / 空 / null / undefined  → 旧项目兼容推断，合法
//   · 字段有值但不在枚举内              → INVALID_INTENT_ENUM，明确报错
function isMissing(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function invalidIntent(field, value, allowed) {
  return new FoundryError(
    `${field} 取值非法：${JSON.stringify(String(value))}；允许值 ${[...allowed].join("/")}`,
    {
      code: "INVALID_INTENT_ENUM",
      kind: ERROR_KINDS.USER_ACTION_REQUIRED,
      userAction: "reselect_intent",
      details: { field, received: String(value), allowed: [...allowed] }
    }
  );
}

function normalizeScriptHandling(value, project = {}) {
  if (isMissing(value)) {
    return project?.productionPlan?.inputMode === "manual" ? "respect" : "optimize";
  }
  const requested = String(value).trim().toLowerCase();
  if (SCRIPT_HANDLING.has(requested)) return requested;
  throw invalidIntent("scriptHandling", value, SCRIPT_HANDLING);
}

function normalizeCommerceMode(value, project = {}) {
  // 显式选择的口播/带货意图必须保留：它在商品资料录入之前就已确定，
  // 若在此处按商品是否已存在重新推断，会把 explicit/natural 抹成 none，
  // 从而绕过 topic/script 阶段的商品准入闸门。
  if (isMissing(value)) return require('../renderer/commerce-input-mode')(project);
  const requested = String(value).trim().toLowerCase();
  if (COMMERCE_MODES.has(requested)) return requested;
  throw invalidIntent("commerceMode", value, COMMERCE_MODES);
}

function normalizePriorityProfile(value) {
  if (isMissing(value)) return "balanced";
  const requested = String(value).trim().toLowerCase();
  if (PRIORITY_PROFILES.has(requested)) return requested;
  throw invalidIntent("priorityProfile", value, PRIORITY_PROFILES);
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
      // The selected commerce intent must survive before product intake.  Product
      // readiness is enforced by the topic/script stages; rewriting the intent
      // to `none` here used to bypass that intake gate after every Foundry save.
      commerceMode,
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

function contractPromptBlock(contract = {}, stage = "") {
  assertAbsolutePolicies(contract);
  if(["character_intro","character_sheet","character_three_view","scene_asset","prop_asset","wardrobe_asset"].includes(stage)){
    const layout=stage==="scene_asset"?"一张16:9的2×2无人场景四视图，只展示同一个物理空间的四个角度，不加入人物资产板。":stage==="character_intro"?"只展示一位人物的一张单视角身份照片，不拼贴、不生成四视图，固定纯色 #E9E9E9 背景。":stage.startsWith("character_")?"只展示同一人物的既定多视图身份参考板，固定纯色 #E9E9E9 背景，不引入第二身份或剧情表演。":stage==="wardrobe_asset"?"只由绑定的同一人物以中性姿态展示指定服装，保持其脸、年龄与体型；允许必要正背面视图，不加入其他人物、家具或剧情动作。":"只展示当前物品资产，不加入真人、手或剧情场景。";
    return `【V2分阶段资产合同 ${contract.fingerprint||""}】${layout}禁止额外字幕、标题、姓名条、价格字和水印。原商品包装不改字、不重绘。剧本因果、对白、音效与最终视频规则不作为这张静态资产的画面内容。`;
  }
  const handling = { respect: "尊重原稿：锁定事实、关系、事件顺序、对白与结局，只做制作结构化", optimize: "优化原稿：不改核心事实与结局，允许定点优化对白、节奏和因果", recreate: "重新创作：保留用户确认的事实锁，其余可重建" }[contract.intent?.scriptHandling] || "尊重原稿";
  const commerce = { none: "无带货：不得出现商品导购、价格或购买引导", natural: "自然植入：商品只能因角色的真实任务与剧情因果出现", explicit: "明确带货：允许角色口头讲解用户提供的事实，但不允许字幕、价格字或虚构功效" }[contract.intent?.commerceMode] || "无带货";
  return [
    `【V2生产合同 ${contract.fingerprint || ""}】`,
    handling,
    commerce,
    "绝对禁令：成片不得出现任何字幕、标题、姓名条、价格字、水印、背景音乐、人物介绍、人物小传或故事简介。",
    "只允许：剧中角色对白、与画面同步的动作声和场景环境声。",
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
