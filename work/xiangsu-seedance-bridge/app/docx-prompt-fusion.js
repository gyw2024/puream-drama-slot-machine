"use strict";

/**
 * Curated, additive rules distilled from the two DOCX prompt references supplied
 * for TASK-20260808-PROMPT-DOCX-FUSION-001.
 *
 * These rules deliberately stay separate from the existing K3 prompt library:
 * - existing prompt text and user overrides remain byte-for-byte intact;
 * - each stage receives only rules it can execute;
 * - conflicting source advice (fixed 15s units, no BGM, 8K, fourth-wall CTA,
 *   similarity-evasion claims) is intentionally excluded.
 */

const DOCX_PROMPT_FUSION_VERSION = "2026.08-docx-fusion-v3-all-modes-sfx-only";

const STAGE_TO_KEY = Object.freeze({
  topic_ideation: "docxFusionTopicIdeation",
  story_bible: "docxFusionStoryBible",
  shot_plan: "docxFusionShotPlan",
  units: "docxFusionUnits",
  blueprint_review: "docxFusionBlueprintReview",
  semantic_review: "docxFusionSemanticReview",
  script_analysis: "docxFusionScriptAnalysis"
});

function defaultDocxPromptFusionTemplates() {
  return {
    docxFusionTopicIdeation: require('./generation-template-defaults').defaults()["docxFusionTopicIdeation"],

    docxFusionStoryBible: require('./generation-template-defaults').defaults()["docxFusionStoryBible"],

    docxFusionShotPlan: require('./generation-template-defaults').defaults()["docxFusionShotPlan"],

    docxFusionUnits: require('./generation-template-defaults').defaults()["docxFusionUnits"],

    docxFusionBlueprintReview: `【DOCX增量·蓝图阶段终审】
【阶段优先级】本段是蓝图阶段合同，优先于基础 scriptSemanticReview 中面向正式制作稿的要求。shots 尚为空时，禁止因为缺少 performance、emotion 细节、实际 dialogue、subshots、imagePrompt、videoPrompt、soundCueSheet，或尚未渲染的 BGM、ducking、bed/SFX 与成片声音效果判失败（正式制作稿阶段仍禁止写BGM）。蓝图阶段只审 shotPlan 已有的 dialogueGoal、compositionPlan、audioPlan、stateBefore、stateAfter 等计划字段，不得要求尚未生成的制作稿字段。
逐项给出具体计划镜号：任意15–30秒窗口是否至少有一次风险/信息/阻碍/证据/关系变化；任意约60秒是否形成不可逆阶段结果；主反转是否有前置线索、触发、现实代价和后续回收；相邻 shotPlan 的 mainlineBeat/visualBeat 是否重复；scene 是否对应已定义场景且空间连续；已有的 dialogueGoal、compositionPlan、audioPlan、stateBefore/stateAfter 是否能支持下一阶段制作。`,

    docxFusionSemanticReview: `【DOCX增量·正式制作稿终审】
逐项审查并给出具体镜号：
- 任意15–30秒窗口是否至少有一次风险/信息/阻碍/证据/关系变化；任意约60秒是否有不可逆阶段结果。仅重复争吵或提高音量不算升级。
- 主反转是否有前置线索、触发、可见反应、现实代价和后续回收；不得用突然身份揭露替代因果。
- 角色是否具有可辨认且参与剧情的外形、口头节奏、习惯动作、职业手势或随身物；是否出现同人多名、多人同名或无功能人物。
- 每个分镜是否有具体场景、时间、景别、构图/运镜、动作、对白归属、听者反应、声音、首尾状态、转场和连续性；subshots 是否完整覆盖本镜时长。
- 若存在用户原稿改编，检查功能骨架与价值是否保留、具体表达是否重新创作；若无原稿，不得臆测来源或套用固定模板。`,

    docxFusionScriptAnalysis: require('./generation-template-defaults').defaults()["docxFusionScriptAnalysis"]
  };
}

function docxPromptFusionKey(stage) {
  return STAGE_TO_KEY[String(stage || "").trim()] || "";
}

function docxPromptFusionFor(prompts, stage) {
  const key = docxPromptFusionKey(stage);
  if (!key) return "";
  if (prompts && Object.prototype.hasOwnProperty.call(prompts, key)) {
    return String(prompts[key] || "").trim();
  }
  return String(defaultDocxPromptFusionTemplates()[key] || "").trim();
}

function appendDocxPromptFusion(base, prompts, stage) {
  const original = String(base ?? "");
  const addition = docxPromptFusionFor(prompts, stage);
  if (!addition || original.includes(addition)) return original;
  return original ? `${original}\n\n${addition}` : addition;
}

module.exports = {
  DOCX_PROMPT_FUSION_VERSION,
  STAGE_TO_KEY,
  appendDocxPromptFusion,
  defaultDocxPromptFusionTemplates,
  docxPromptFusionFor,
  docxPromptFusionKey
};
