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
    docxFusionTopicIdeation: `【DOCX增量·爆款选题去同质化】
每个选题必须先给一个可拍、可见、正在发生的现实危机，再给核心关系、现实损失、已铺垫的决定性人物/承诺/物件/事实和最终善恶清算；不能只换姓名、职业或道具。先选rescue_repaid、kindness_misjudged、sacrifice_repaid、evidence_reversal之一；前三类只需一条清楚可见的证明链，只有evidence_reversal才设计两证据互证和红鲱鱼。
10个选题的冲突机制必须不同，至少覆盖风险升级、资源被夺、证据被抢、站队撕裂、关系翻转等不同动力。商品不是开场钩子，选题离开商品也必须成立。
中老年共鸣来自养老、亲情、财产、邻里、尊严、再婚或代际责任等真实处境，但禁止把职业、年龄或贫穷写成刻板笑料。每题说明前8秒钩子、最大爆点、主反转为何成立、观众最后得到哪口气。`,

    docxFusionStoryBible: `【DOCX增量·剧情劲爆度与原创表达】
每15–30秒必须改变风险、信息、行动、证据或关系；每60秒形成一次不可逆结果。爆点走完“铺垫→触发→可见反应→现实后果→后续回收”，观众随时能复述目标与阻碍。角色的脸/体态、口头节奏、习惯动作或随身物必须参与剧情。场景与节拍密度服从运行时动态数值，每场有独占任务和有动机切换，单一场景不超过全片一半（用户明确固定场景除外）。不得捏造商品功效、价格或承诺。改编时保留因果和人物功能，但重新创作具体事件、空间、动作、道具与台词；原创模式不得假设来源。`,

    docxFusionShotPlan: `【DOCX增量·场景与分镜规划完整度】
严格区分“物理场景”和“剧情阶段”：同地点升级时，shotPlan 的 scene 仍绑定同一场景并锁门窗、光线、站位与轴线；换场必须有动作理由。每镜用独占visualBeat走完“承接→触发→反应→状态后果”；scenePresenceCharacterIds只管场内存在，visibleCharacterIds只管当前画面且每镜visible严格0–2人，至少一半单人镜。填写focus/counterpart、shotFunction、sceneObjective、transitionReason、emotionArc、performanceBeats、productShotType；无状态变化的相邻镜重写。`,

    docxFusionUnits: `【DOCX增量·可执行分镜与音画提示词·全模式参考片水位】
一个5–15秒生成单元固定恰好3个subshot/edit beat并连续覆盖全时长（时长禁止等分）；整镜只用蓝图锁定的0–2名visibleCharacterIds，scenePresence旁观者不得补进画面、对白或音色。每句绑定说话人、听者、可见动作、语气重音、身体朝向和同步反应；单句优先4–10字，句句新信息。
visualBeat/compositionPlan/startFrame/endFrame/subshots写清身份服装、空间时段、景别职责、站位视线、动作和道具首尾态；emotionArc与performanceBeats落实脸部肌肉、重心、声线和听者反应。三段action/faceAction/bodyAction必须肉眼不同。subshots/dialogueTurns/soundCueSheet写准0秒起态、逐段动作、运镜、准确说话人和音色绑定、口型、连续底噪、同步SFX、尾态与连续锚点；禁止写BGM/underscore；海螺 non_diegetic_music 固定 N/A。
转场只由台词、动作、视线、声音、入场或物件触发；尾帧保留微动作，禁止定格。首尾帧/延续/逐秒合图仅改时间锚策略，口播·切镜·表演·SFX水位同一合同。商品段动态拆成无脸整体/细节、真实使用、客观结果、受益者单人反应/剧情决定，禁止多人围货和固定疼痛/饥饿/试戴模板。`,

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

    docxFusionScriptAnalysis: `【DOCX增量·原稿拆解与受控补强】
【与基础拆解提示词的关系】本段补充且不取消基础 scriptAnalysis 已允许的导演逻辑修复、标注补设和死句重写权限。必须保留原稿的核心立意、因果主线、人物关系、关键事件顺序、冲突结果与结局；调整只能限于基础模板允许的逻辑修复、标注为「补设」的缺项补齐和不改变事实/意图/结果的死句重写，新增内容不得伪装成原稿事实。
原稿未明确换场时默认延续当前物理空间；同一地点发生新的冲突阶段，只更新 mainlineStage/beat，shots[].scene 必须继续使用同一个 scenes[].name。
把所有说话人、被点名且有剧情功能的人、承担可见动作的人纳入人物表；人物表、shots[].characters 和对白说话人必须始终使用同一个角色名称，避免同人多名或多人同名，系统随后按名称建立稳定ID。
场景名具体到可拍空间，保守推断门窗家具、机位和光线并把不确定项标明；不得把商品介绍擅自推断成直播间。
原句可演时优先保留；必须重写死句时，每句对白仍要绑定短小、外显、可表演的动作/神态/语气和听者反应，并保持原句事实、意图和结果不变。禁止把内心活动或作者解释伪装成画面。分镜拆解仍须完整输出时长、景别、动作、对白、声音、首尾状态、转场与连续性。`
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
  if (!addition) return original;
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
