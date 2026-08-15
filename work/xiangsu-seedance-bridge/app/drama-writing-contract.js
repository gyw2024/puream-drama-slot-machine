"use strict";

/**
 * One source of truth shared by script generation, local validation and the
 * optional blueprint reviewer. Keep the historic/custom prompt library intact;
 * runtime compilers append this contract so generation and review cannot drift.
 */

const DRAMA_WRITING_CONTRACT_VERSION = "2026.08.15-continuity-block-v4";
const TOPIC_TO_ASSETS_SLA_MS = 15 * 60_000;
const TOPIC_REQUEST_TIMEOUT_MS = 45_000;

function clampDuration(value) {
  return Math.max(5, Math.min(15, Math.round(Number(value) || 10)));
}

function dialogueUnitBudget(durationSeconds = 10, options = {}) {
  const duration = clampDuration(durationSeconds);
  if (options.silent === true || options.productPackshot === true) {
    return { duration, minTurns: 0, targetTurns: 0, maxTurns: 0, minChars: 0, targetChars: 0, maxChars: 0 };
  }
  const solo = options.solo === true;
  const targetTurns = solo
    ? (duration <= 7 ? 1 : duration <= 12 ? 2 : 3)
    : (duration <= 7 ? 2 : duration <= 12 ? 4 : 5);
  const minTurns = Math.max(1, targetTurns - 1);
  const maxTurns = Math.min(solo ? 3 : 6, targetTurns + 1);
  const minChars = Math.max(targetTurns * 3, Math.round(duration * (solo ? 1.2 : 2.0)));
  const targetChars = Math.max(minChars, Math.round(duration * (solo ? 1.7 : 2.8)));
  const maxChars = Math.max(targetChars, Math.round(duration * (solo ? 2.5 : 3.6)));
  return { duration, minTurns, targetTurns, maxTurns, minChars, targetChars, maxChars };
}

function dialogueReferenceTargets(totalSeconds = 300) {
  const minutes = Math.max(Number(totalSeconds) || 0, 1) / 60;
  return {
    turnsPerMinuteMin: 12,
    turnsPerMinutePreferred: 15,
    turnsPerMinuteMax: 18,
    totalTurnsMin: Math.ceil(minutes * 12),
    totalTurnsPreferred: Math.ceil(minutes * 15),
    spokenCharactersPerMinuteMin: 120,
    totalSpokenCharactersMin: Math.ceil(minutes * 120),
    twoTurnEligibleUnitRatioMin: 0.7,
    silentSubshotRatioMax: 0.55
  };
}

function dialogueUnitPrompt(durationSeconds = 10, options = {}) {
  const budget = dialogueUnitBudget(durationSeconds, options);
  if (!budget.targetTurns) return `${budget.duration}秒无对白商品干净镜，只用动作、环境底噪和同步特效声推进`;
  const role = options.solo === true ? "单人短锤/对画外听者" : "双人攻防";
  return `${budget.duration}秒${role}：${budget.minTurns}-${budget.maxTurns}句，优选${budget.targetTurns}句；${budget.minChars}-${budget.maxChars}个可说汉字，优选约${budget.targetChars}字`;
}

function sharedDramaWritingContract(totalSeconds = 300) {
  const targets = dialogueReferenceTargets(totalSeconds);
  return `【写作与蓝图审核共享合同·${DRAMA_WRITING_CONTRACT_VERSION}·冲突时以此为准】
1. 全剧对白按真实表演容量验收：每分钟至少${targets.turnsPerMinuteMin}轮、优选约${targets.turnsPerMinutePreferred}轮，每分钟至少${targets.spokenCharactersPerMinuteMin}个可说汉字；不得把每一个镜头都强塞成固定6句或8句。
2. 有人且适合说话的镜头中，至少${Math.round(targets.twoTurnEligibleUnitRatioMin * 100)}%含两句以上有效推进；一个5–15秒连续剧情单元最多2名说话人，问答因果连续时优先在同一Sxx内说完，不为换说话人机械拆散剧情。单人动作短锤允许1–3句；商品整体/细节干净镜允许零对白。
3. 每句必须完整、口语化且只出现一次，逐句绑定speakerId、listenerIds与onScreen；当前说话人开口，画面里的其他人闭口并给同步反应。语气、表情、身体动作、音量、语速、重音和气口必须由当下事件与人物目的推导，禁止对镜念稿、同义复读和解释观众已经看见的动作。
4. Sxx是剧情连续块，不等于固定机位。顶层cameraOwnerId/mouthOwnerId只描述开场机位；真正所有权由dialogueTurns逐句决定。说话人变化必须形成明确时间边界并硬切到新说话人机位，嘴型同步换主；3个subshots可承载起句、反打、峰值、反应或动作结果，后续导演Agent再把它们编译为原子机位段，并优先合并为一个H3连续视频任务。
5. 对白、动作和切镜共同留足表演时间；有人子镜允许安静反应或动作落点，全片有人子镜无对白比例上限${Math.round(targets.silentSubshotRatioMax * 100)}%。生成提示、蓝图审核与本地硬审计必须使用同一数值；旧提示中的“每S唯一说话人、换人必须下一S、三个subshots固定同一机位”及每镜固定6句/8句等冲突要求一律失效。`;
}

function theoreticalTopicToAssetsUpperBoundMs(unitCount, options = {}) {
  const count = Math.max(1, Math.floor(Number(unitCount) || 1));
  const segmentUnits = Math.max(1, Math.floor(Number(options.segmentUnits) || 5));
  const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 2));
  const requestTimeoutMs = Math.max(1_000, Number(options.requestTimeoutMs) || 60_000);
  const topicTimeoutMs = Math.max(1_000, Number(options.topicTimeoutMs) || TOPIC_REQUEST_TIMEOUT_MS);
  const segmentCount = Math.ceil(count / segmentUnits);
  return topicTimeoutMs + requestTimeoutMs * (1 + Math.ceil(segmentCount / concurrency));
}

module.exports = {
  DRAMA_WRITING_CONTRACT_VERSION,
  TOPIC_REQUEST_TIMEOUT_MS,
  TOPIC_TO_ASSETS_SLA_MS,
  dialogueReferenceTargets,
  dialogueUnitBudget,
  dialogueUnitPrompt,
  sharedDramaWritingContract,
  theoreticalTopicToAssetsUpperBoundMs
};
