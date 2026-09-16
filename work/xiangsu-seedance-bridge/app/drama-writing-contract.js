"use strict";

/**
 * One source of truth shared by script generation, local validation and the
 * optional blueprint reviewer. Keep the historic/custom prompt library intact;
 * runtime compilers append this contract so generation and review cannot drift.
 */

const { NO_TOTAL_DEADLINE_MS } = require("./production-liveness");
const { stagingAuthoringContractEn } = require("./drama-staging-contract");

const DRAMA_WRITING_CONTRACT_VERSION = "2026.09.12-commerce-editorial-v19";
const DIALOGUE_FIRST_ACTION_CONTRACT_VERSION = "2026.09.04-dialogue-action-performance-v3";
const TOPIC_TO_ASSETS_SLA_MS = 15 * 60_000;
// Kept as an exported compatibility name. It is a no-deadline policy, not a
// timer. The 15 minute value above remains an observability target only.
const TOPIC_REQUEST_TIMEOUT_MS = NO_TOTAL_DEADLINE_MS;

function clampDuration(value) {
  return Math.max(10, Math.min(15, Math.round(Number(value) || 12)));
}

function dialogueUnitBudget(durationSeconds = 10, options = {}) {
  const duration = clampDuration(durationSeconds);
  const solo = options.solo === true;
  const targetTurns = duration <= 7 ? 1 : 2;
  const minTurns = 1;
  const maxTurns = Number.POSITIVE_INFINITY;
  const minChars = Math.max(6, Math.round(Math.max(0,duration-3) * 5));
  const targetChars = Math.max(minChars, Math.round(Math.max(0,duration-1) * 5.5));
  const maxChars = Math.max(targetChars, Math.round(duration * 8));
  return { duration, minTurns, targetTurns, maxTurns, minChars, targetChars, maxChars };
}

function dialogueReferenceTargets(totalSeconds = 300) {
  const minutes = Math.max(Number(totalSeconds) || 0, 1) / 60;
  const short = totalSeconds <= 180;
  const medium = totalSeconds > 180 && totalSeconds <= 360;
  const turnsPerMinuteMin = short ? 9 : medium ? 6 : 5;
  const turnsPerMinutePreferred = short ? 11 : medium ? 8 : 6;
  const turnsPerMinuteMax = short ? 12 : medium ? 9 : 7;
  const spokenCharactersPerMinuteMin = short ? 160 : medium ? 110 : 80;
  return {
    turnsPerMinuteMin,
    turnsPerMinutePreferred,
    turnsPerMinuteMax,
    totalTurnsMin: Math.ceil(minutes * turnsPerMinuteMin),
    totalTurnsPreferred: Math.ceil(minutes * turnsPerMinutePreferred),
    spokenCharactersPerMinuteMin,
    totalSpokenCharactersMin: Math.ceil(minutes * spokenCharactersPerMinuteMin),
    dialogueUnitRatioMin: 0.8,
    dialogueUnitRatioMax: 0.9,
    twoTurnEligibleUnitRatioMin: 0.45,
    silentSubshotRatioMax: 0.6
  };
}

function dialogueUnitPrompt(durationSeconds = 10, options = {}) {
  const budget = dialogueUnitBudget(durationSeconds, options);
  const role = options.solo === true ? "单人短锤/对画外听者" : "双人攻防";
  return `${budget.duration}秒${role}：由编剧依据每句情绪语速、停顿、听者反应、动作和运镜共同决定完整句数与字数；末句必须自然说完并留下可见动作落点`;
}

function dialogueFirstActionContractZh() {
  return require('./commerce-editorial-contract').POLICY+'\n'+require('./shot-performance-contract').DIRECTIVE+`\n【对白、动作与表演共同推进合同·${DIALOGUE_FIRST_ACTION_CONTRACT_VERSION}】
1. 每个最终生成单元默认10–15秒，由Agent安排完整对白窗口与必要动作、反应和运镜，物理允许时同步执行；不得把对白算满整镜，也不得靠拖慢语速填时长。
2. 每句完整绑定唯一说话人、明确听者、说话目的、语气、音量、音高、语速、停顿、关键词重音、情绪起点→触发→峰值→余震，以及同步眉眼、下颌、泪线和身体状态变化。冲突句禁止平声念稿或只写 angry/sad/firm 等空泛词。
3. 每个10–15秒单元必须是一条因果动作链并按剧情安排必要的可见表演拍点，不固定数量：开场状态/入场或触发、对白中的有动机动作、听者闭口反应、对白造成的可见结果/离场或交接。动作必须改变信息、权力、物件或人物关系，不得添加无意义忙碌、机械手势或重复动作。
4. 同场景先建立稳定站位账本，再编写每镜：每人固定screenSide、depth、facingCharacterId和eyeline；按实际听者、工作和动作明确脸、眼睛与上身朝向；允许有依据的群体交流或购买引导看镜头。人物换边必须拍出穿越动作或明确轴线重建，绝不按镜号奇偶交替左右。
5. 每次切镜必须由说话人交接、视线、关键动作、物证/商品细节、听者反应、入退场或声音桥触发；单元内可连续拍摄或有动机地改变景别/机位，不固定次数。切后仍回到同一180度轴线，不能跳轴、错朝向或让人物凭空出现。
6. 时间线必须从0.00秒覆盖到结束，连续无人声不得超过3秒；起音干净、末句完整，0.30/0.35秒是建议预留而非硬阈值。所有秒数都由对白、表演、反应、动作和镜头占满，禁止站桩发呆。
7. 每镜动作可与对白同步，任一连续无人说话间隔不超过3秒，按实际需要安排动作与反应；入场、接触、跪下和结果由Agent逐段判断实际时间是否足够。dialogueTurns、actionBeats、subshots、审核译文与最终提交提示词共用同一份已计算时间轴；对白变更后禁止沿用旧动作时间。每拍标注speakingCharacterIds和silentCharacterIds，不能要求正在说话的人同时闭口。切镜边界不得穿过一句对白。普通对话5–6字/秒、争吵至少8字/秒，放不下先延长到15秒以内，仍放不下按完整句拆分；不得只改提示词秒数而不改请求duration。`;
}

function dialogueFirstActionContractEn(){return require('./production-content-requirements').INSTRUCTION+' One actual timeline schedules complete dialogue, source actions, camera choices and request duration. Preserve current shot words once, explicit speaker/listener, source blocking, stable voice identity and source-bound original product references. Physically compatible actions and reactions may overlap dialogue; prerequisites must precede consequences.';}

function sharedDramaWritingContract(totalSeconds=300){
 return require('./production-content-requirements').INSTRUCTION+'\n'+dialogueFirstActionContractZh()+'\n【分工】源剧本先写完整对白、身份、语气、情绪、动作、场景和前后因果。导演 Agent 再确定每镜精确时间轴、站位朝向、视线、发声所有权、物件状态与可选切镜，数值测量仅作证据。程序不按固定句数、拍点数或特定英文句式裁决创作。用户确认前分别完成源稿、逐镜执行与全片实际对白链审核，任何一项通过不能代替其他项。';
}

function theoreticalTopicToAssetsUpperBoundMs() { return null; } // Observability target only; no Agent execution deadline.

module.exports = {
  DIALOGUE_FIRST_ACTION_CONTRACT_VERSION,
  DRAMA_WRITING_CONTRACT_VERSION,
  TOPIC_REQUEST_TIMEOUT_MS,
  TOPIC_TO_ASSETS_SLA_MS,
  dialogueReferenceTargets,
  dialogueUnitBudget,
  dialogueUnitPrompt,
  dialogueFirstActionContractEn,
  dialogueFirstActionContractZh,
  sharedDramaWritingContract,
  theoreticalTopicToAssetsUpperBoundMs
};
