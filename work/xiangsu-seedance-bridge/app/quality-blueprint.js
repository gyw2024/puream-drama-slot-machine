"use strict";

const SEMANTIC_SCORE_FIELDS = Object.freeze([
  "clarity",
  "storyCore",
  "causality",
  "escalation",
  "reversalStructure",
  "tragedyCraft",
  "faceSlapCraft",
  "dialogue",
  "emotionalDelivery",
  "productIntegration",
  "soundDesign",
  "visualVariety"
]);

const DEFAULT_BLUEPRINT_AUDIT_CHECKS = Object.freeze({
  productionStructure: false,
  ...Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, false]))
});

const BLUEPRINT_AUDIT_LABELS = Object.freeze({
  productionStructure: "制作结构与时长合同",
  clarity: "观众理解与信息清晰",
  storyCore: "故事核心与人物动机",
  causality: "因果承接与状态变化",
  escalation: "冲突加压与节奏升级",
  reversalStructure: "伏笔、证据与主反转",
  tragedyCraft: "悲剧情绪与代价",
  faceSlapCraft: "打脸清算与回收",
  dialogue: "对白密度与说话人准确",
  emotionalDelivery: "语气、表情与表演",
  productIntegration: "商品出现与带货因果",
  soundDesign: "环境声、音效与声音计划",
  visualVariety: "构图、动作与画面差异"
});

function normalizeBlueprintAuditChecks(value = {}) {
  return Object.fromEntries(Object.keys(DEFAULT_BLUEPRINT_AUDIT_CHECKS).map(key => [key, value?.[key] === true]));
}

function blueprintAuditChecks(settings = {}) {
  return normalizeBlueprintAuditChecks(settings?.generation?.blueprintAuditChecks || {});
}

function enabledSemanticScoreFields(settings = {}) {
  const checks = blueprintAuditChecks(settings);
  return SEMANTIC_SCORE_FIELDS.filter(field => checks[field] === true);
}

module.exports = {
  BLUEPRINT_AUDIT_LABELS,
  DEFAULT_BLUEPRINT_AUDIT_CHECKS,
  SEMANTIC_SCORE_FIELDS,
  blueprintAuditChecks,
  enabledSemanticScoreFields,
  normalizeBlueprintAuditChecks
};
