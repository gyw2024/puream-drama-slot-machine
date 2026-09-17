"use strict";

const crypto = require("node:crypto");
const { storyDensityTargets } = require("./script-craft");
const { dialogueUnitBudget, dialogueUnitPrompt } = require("./drama-writing-contract");
const { planAtomicDialogueSubshots } = require("./dialogue-shot-planner");
const { estimateActedSpeechSeconds } = require("./drama-timing");

const STAGES = Object.freeze([
  "hook", "hook",
  "pressure", "pressure", "pressure", "pressure", "pressure", "pressure",
  "cost_kindness",
  "pressure", "pressure", "pressure", "pressure", "pressure",
  "cost_kindness",
  "evidence", "evidence", "evidence", "evidence", "evidence", "evidence",
  "main_reversal",
  "payoff", "payoff", "payoff", "payoff",
  "payoff", "payoff", "payoff",
  "ending"
]);

const FALLBACK_LINES = Object.freeze([
  "你把话说清！",
  "别再拿话骗我。",
  "我已经看见了。",
  "这次没有退路。",
  "你现在就回答。",
  "说完我们再走。"
]);

function compact(value, fallback = "", limit = 90) {
  const text = String(value || fallback || "").replace(/\s+/g, " ").trim();
  return text.slice(0, limit);
}

// Narrative fields are not labels. Blind `slice()` can turn a perfectly valid
// model sentence into a dangling action (for example, "接受并坐到"), which is
// then propagated into every downstream prompt. Keep ordinary responses whole;
// only bound pathological fields, and then cut on a real sentence boundary.
function completeNarrative(value, fallback = "", hardLimit = 720) {
  const primary = String(value || "").replace(/\s+/g, " ").trim();
  const backup = String(fallback || "").replace(/\s+/g, " ").trim();
  const text = primary || backup;
  if (!text || text.length <= hardLimit) return text;
  const head = text.slice(0, hardLimit);
  let boundary = -1;
  for (const mark of ["。", "！", "？", "!", "?", "；", ";"]) boundary = Math.max(boundary, head.lastIndexOf(mark));
  if (boundary >= Math.min(40, Math.floor(hardLimit * 0.35))) return head.slice(0, boundary + 1).trim();
  return backup && backup !== text ? backup : text;
}

function sourceArray(value) {
  return Array.isArray(value) ? value : [];
}

// Semantic schedule responses occasionally use a human-readable speaker label
// (sometimes followed by acting notes) even though the wire contract requires
// a numeric character id. Normalize only an unambiguous repeated label; never
// rewrite the spoken text itself and reject anonymous/composite labels.
function normalizeDirectFastSemanticSpeakerUnits(units, state = new Map()) {
  const source = sourceArray(units);
  const map = state instanceof Map ? state : new Map();
  const usedIds = new Set([...map.values()].map(value => Number(value)).filter(value => Number.isInteger(value) && value >= 1 && value <= 5));
  for (const unit of source) for (const line of sourceArray(unit?.dialogueLines)) {
    const numeric = Number(Array.isArray(line) ? line[0] : NaN);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 5) usedIds.add(numeric);
  }
  let nextId = 1;
  const out = source.map(unit => ({ ...unit,
    dialogueLines: sourceArray(unit?.dialogueLines).map(line => {
      if (!Array.isArray(line) || line.length < 2) return line;
      const raw = String(line[0] ?? "").trim();
      if (/^[1-5]$/.test(raw)) {
        const numeric = Number(raw);
        map.set(`\u0000id:${numeric}`, numeric);
        return [numeric, ...line.slice(1)];
      }
      const label = raw.split(/[（(]/, 1)[0].trim();
      if (!label || /^(?:旁白|画外音|未知|不明|角色|说话人|多人)$/u.test(label)
        || /[、,，/&和及与]/u.test(label) || label.length > 12) {
        throw Object.assign(new Error(`semantic speaker label is ambiguous: ${raw}`), { code: "SCRIPT_SEMANTIC_SPEAKER_INVALID", speaker: raw });
      }
      if (!map.has(label)) {
        while (usedIds.has(nextId) && nextId <= 5) nextId += 1;
        if (nextId > 5) throw Object.assign(new Error(`semantic speaker count exceeds five: ${label}`), { code: "SCRIPT_SEMANTIC_SPEAKER_INVALID", speaker: label });
        map.set(label, nextId++);
        usedIds.add(map.get(label));
      }
      return [map.get(label), ...line.slice(1)];
    })
  }));
  return { units: out, speakerMap: map };
}

function spokenLength(value) {
  return String(value || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").length;
}

function safeSentence(value, fallback, maxChars = 10) {
  const body = compact(value, fallback, 30).replace(/[，。！？!?；;：:…]+$/g, "");
  if (!body) return "";
  const firstClause = body.split(/[，；;：:]/)[0].trim();
  if (spokenLength(firstClause) <= Math.max(2, maxChars)) return `${firstClause}。`;
  return `${compact(fallback, "这句话我会说完整", Math.max(2, maxChars))}。`;
}

function authoredSpeech(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return /[。！？!?…]$/.test(text) ? text : `${text}。`;
}

function openingSentenceFromSource(value) {
  const text = compact(value, "", 30).replace(/[，。！？!?；;：:…]+$/g, "");
  const chars = [...text];
  const hasPunch = /凭什么|还敢|住手|滚|你也配|谁让|别碰|放开|跪下/.test(text);
  if (chars.length >= 6 && hasPunch) return `${chars.slice(0, 12).join("")}！`;
  return "住手！你凭什么这么做？";
}

function fitDialogueLines(source, opening = false, duration = 10, options = {}) {
  const seconds = Math.max(10, Math.min(15, Number(duration) || 12));
  const budget = dialogueUnitBudget(seconds, options);
  const targetTurns = budget.targetTurns;
  const maximumCharacters = budget.maxChars;
  if (!targetTurns) return [];
  let lines = sourceArray(source).map(item => Array.isArray(item) ? item : [item?.s, item?.x || item?.text])
    .map(([speaker, text]) => ({ speaker: Math.max(1, Number(speaker) || 1), text: safeSentence(text, "请把话说完整", 18) }))
    .filter(item => spokenLength(item.text) >= 2)
    .slice(0, targetTurns);
  while (lines.length < targetTurns) {
    const fallback = FALLBACK_LINES[lines.length % FALLBACK_LINES.length];
    const fallbackSpeaker = options.solo === true
      ? (lines[0]?.speaker || 1)
      : (lines.length % 2 ? 2 : 1);
    lines.push({ speaker: fallbackSpeaker, text: safeSentence(fallback, fallback, 10) });
  }
  if (opening) lines[0].text = openingSentenceFromSource(lines[0]?.text);
  let total = lines.reduce((sum, item) => sum + spokenLength(item.text), 0);
  if (total > maximumCharacters) {
    const budget = maximumCharacters;
    let remaining = budget;
    lines = lines.map((item, index) => {
      const slots = lines.length - index;
      const minimumRemaining = Math.max(0, slots - 1) * 5;
      const desired = spokenLength(item.text);
      const allowance = Math.max(10, Math.min(desired, remaining - minimumRemaining));
      const punctuation = index === 0 && opening ? "！" : "。";
      const original = item.text.replace(/[，。！？!?；;：:…]/g, "");
      const text = spokenLength(original) <= allowance ? original : safeSentence(FALLBACK_LINES[index % FALLBACK_LINES.length], "请把话说完整", allowance).replace(/[。！？!?]$/g, "");
      remaining -= spokenLength(text);
      return { ...item, text: `${text}${punctuation}` };
    });
  }
  return lines;
}

function directFastResponseSchema() {
  return {
    c: [{ n: "姓名", a: "年龄段", r: "身份与关系", d: "外貌体态" }],
    sc: [{ n: "场景名", d: "空间与剧情任务" }],
    s: [{
       i: 1,
       t: "镜头标题",
       actionEn: "Concrete English physical action and visible result",
       framingEn: "English framing for the beat",
       cameraEn: "Executable English camera instruction",
       stateBeforeEn: "English physical state at the start",
       stateAfterEn: "English physical state at the end",
       soundEn: "English continuous diegetic ambience and synchronized physical SFX",
      a: "唯一可见动作与结果",
      bf: "开始状态",
      af: "结束后的不可逆状态",
      em: "起始情绪→触发→峰值→余震",
      f: 1,
      v: [1, 2],
      d: [[1, "完整口语台词", "压着火气，重音落在关键事实，句尾留气口", "下颌绷紧，手指扣住道具", "听者闭口，眼神躲开并后退半步", 2, 2.8, 0.6], [2, "回应台词", "先防御后松动，尾音发虚", "肩膀收紧，视线短暂回避", "前一说话人闭口，盯住对方等待回应", 1, 2.4, 0.8]],
      visualReserveSeconds: 3,
      durationRationale: "对白按当前情绪自然说完，并给运镜、听者反应和末句动作落点留足时间"
    }]
  };
}

function directFastSemanticScheduleSchema() {
  return {
    u: [{
      i: 1,
       duration: 12,
       visualReserveSeconds: 3.2,
       durationRationale: "两句压抑对话需要自然气口，开场移动建立关系，末句后转入手部特写",
       actionEn: "Concrete English physical action and visible result",
       stateBeforeEn: "English physical state at the start",
       stateAfterEn: "English physical state at the end",
       framingEn: "English framing for this beat",
       cameraEn: "Executable English camera instruction",
       soundEn: "English continuous diegetic ambience and synchronized physical SFX",
      beat: "本镜唯一新增事实或动作结果",
      before: "承接上一镜状态",
      after: "不可逆新状态",
      visibleCharacterNumbers: [1, 2],
      dialogueLines: [
        [1, "完整台词。", "压着怒气快速质问，重音落在关键事实，句尾收住等待回答", 2, 2.6, 0.6],
        [2, "完整回应。", "先慌乱防御再放慢语速，尾音发虚，最后一个词落轻", 1, 3.1, 0.8]
      ],
      cutAfter: "末句说完，听者反应0.6秒后在动作落点切镜",
      dialogueContinuesToNext: false
    }]
  };
}

function directFastSemanticSchedulePrompt({ topic, product, totalSeconds, durationMin = 10, durationMax = 15 }) {
  const minimumCount = Math.ceil(totalSeconds / durationMax);
  const maximumCount = Math.floor(totalSeconds / durationMin);
  return [
    "For every unit also return actionEn, framingEn, cameraEn, stateBeforeEn, stateAfterEn, and soundEn as concise faithful English execution mirrors. Do not invent or alter plot, dialogue, speaker, or physical causality; preserve these fields unchanged in any continuation or repair.",
    `先为一部${totalSeconds}秒写实竖屏短剧做语义切镜。镜数只能由剧情决定，可在${minimumCount}-${maximumCount}镜之间，禁止用总秒数除以10预设镜数。`,
    `题材：${JSON.stringify(topic)}`,
    `商品：${product.name}；只使用事实：${product.sellingPoints || product.description || "用户未提供额外卖点"}。商品动作和台词不得承诺治愈、止痛、立刻见效或任何未提供的绝对结果。`,
    `只输出JSON根对象u。每项i从1连续；duration为${durationMin}-${durationMax}整数，全部duration之和精确等于${totalSeconds}。`,
    "先按完整对白回合、动作结果、场景任务、人物进出和情绪落点划分语义单元，再决定duration。每个最终单元必须10-15秒；强钩子、转场、静默反应和物证/商品细节都并入相邻有对白单元内部，禁止5-9秒碎镜。禁止用固定镜数反推内容，禁止整批同秒数。",
    "每项先写 visibleCharacterNumbers，列出画面里实际承担动作、说话或可见反应的全部固定人物序号，不设两人入画上限；对白人数单独控制，同一镜最多两名说话人。dialogueLines写本镜最终锁定的完整台词，每项为[说话人序号,完整台词,本句专属表演语气,明确听者序号,plannedSpeechSeconds,plannedAfterBeatSeconds]。普通对话按5-6个有效汉字/秒（目标5.5）计算，争吵、怒斥、质问、控诉、威胁、揭露和反击按至少8个有效汉字/秒计算，并核验窗口既不截断也不拖腔。听者必须是真实对话对象且不能等于说话人，只有确实没有人物听者时才写0。每句必须以。！？!?…结束，任何一句都不得跨镜续说。只有第二项是人物真正说出口的内容，动作、表情、场景、时码和制作说明绝不写进第二项。",
    "每镜填写visualReserveSeconds与durationRationale：动作可与对白同步，任一连续无人说话间隔不超过3秒，按实际需要安排，形成2-4个因果表演拍点：开场状态/入场或触发、对白剧情动作、听者闭口反应、可见结果/交接，并包含至少一次有动机的构图变化。所有人物沿稳定180度轴线保持固定左右站位、朝向和视线，换边必须写明可见穿越或轴线重建。完整试演后若放不下，应在完整句号处分成相邻剧情块，绝不截断一句、拖慢或把半句续到下一镜。",
    "before承接上一镜after；beat只写本镜新增事实/权力/行动；after写不可逆新状态；cutAfter必须明确写出完整句末后的动作或反应切点；dialogueContinuesToNext必须恒为false。",
    "缺少任何镜时只能按缺失i再次请求补齐，已经返回的u项不可改写、改号或重排。不要解释、Markdown、图片提示词或视频提示词。",
    `结构示例：${JSON.stringify(directFastSemanticScheduleSchema())}`
  ].join("\n");
}

// A long film can legitimately contain dozens or hundreds of semantic units.
// Asking a model for that whole array in one response makes a provider-side
// completion cap indistinguishable from a malformed screenplay.  Keep the
// global duration allocation deterministic, then author the semantic details
// in small, independently resumable ranges.
function directFastSemanticScheduleRangePrompt({
  topic,
  product,
  totalSeconds,
  start,
  end,
  durations,
  spine = null,
  previousAfter = "",
  repairFailures = [],
  lockedUnits = []
}) {
  const first = Math.max(1, Math.round(Number(start) || 1));
  const last = Math.max(first, Math.round(Number(end) || first));
  const finalUnit = Math.max(last, Array.isArray(durations) ? durations.length : last);
  const allocation = Array.from({ length: last - first + 1 }, (_, offset) => ({
    i: first + offset,
    duration: Number(durations?.[first + offset - 1]) || 10
  }));
  const locked = sourceArray(lockedUnits)
    .filter(unit => Number(unit?.i) >= first && Number(unit?.i) <= last)
    .map(unit => ({
      i: Number(unit.i),
      duration: Number(unit.duration),
      beat: compact(unit.beat, "", 160),
      before: compact(unit.before, "", 160),
      after: compact(unit.after, "", 160),
      actionEn: compact(unit.actionEn, "", 180),
      framingEn: compact(unit.framingEn, "", 80),
      cameraEn: compact(unit.cameraEn, "", 100),
      stateBeforeEn: compact(unit.stateBeforeEn, "", 100),
      stateAfterEn: compact(unit.stateAfterEn, "", 100),
      soundEn: compact(unit.soundEn, "", 140),
      visibleCharacterNumbers: sourceArray(unit.visibleCharacterNumbers).map(Number).filter(Number.isInteger),
      dialogueLines: sourceArray(unit.dialogueLines),
      visualReserveSeconds: Number(unit.visualReserveSeconds) || 0,
      durationRationale: compact(unit.durationRationale, "", 160),
      cutAfter: compact(unit.cutAfter, "", 160),
      dialogueContinuesToNext: false
    }));
  const lockedIndexes = new Set(locked.map(unit => unit.i));
  const requestedAllocation = allocation.filter(item => !lockedIndexes.has(item.i));
  const lockedCharacters = sourceArray(spine?.c).slice(0, 5).map((item, index) => ({
    number: index + 1,
    id: `C${String(index + 1).padStart(2, "0")}`,
    name: compact(item?.n || item?.name, `角色${index + 1}`, 16),
    identity: compact(item?.r || item?.role, "身份待锁定", 80),
    appearance: compact(item?.d || item?.description, "", 80)
  }));
  const lockedScenes = sourceArray(spine?.sc).map((item, index) => ({
    number: index + 1,
    id: `SC${String(index + 1).padStart(2, "0")}`,
    name: compact(item?.n || item?.name, `场景${index + 1}`, 24),
    purpose: compact(item?.d || item?.description, "", 100)
  }));
  const lockedBeats = sourceArray(spine?.b)
    .filter(item => Number(item?.z) >= first && Number(item?.a) <= last)
    .map(item => ({
      range: [Number(item?.a), Number(item?.z)],
      sceneNumber: Number(item?.sc) || 1,
      entryFact: compact(item?.en, "", 120),
      newGoal: compact(item?.g, "", 120),
      irreversibleExit: compact(item?.ex, "", 120),
      handoff: compact(item?.h, "", 120)
    }));
  return [
    `[SEMANTIC_RANGE start=${first} end=${last}]`,
    `为一部 ${Number(totalSeconds) || 0} 秒竖屏短剧只编写 S${String(first).padStart(2, "0")}–S${String(last).padStart(2, "0")} 的语义切镜。不要输出范围外的镜头，不要解释。`,
    `题材：${JSON.stringify(topic || {})}`,
    `商品：${String(product?.name || "")}；只使用事实：${String(product?.sellingPoints || product?.description || "用户未提供额外卖点")}。涉及商品的动作和台词只能转述这些事实，不得承诺治愈、止痛、立刻见效、恢复正常或任何未提供的绝对结果；优先让人物说真实使用目的和动作，不说广告口号。`,
    lockedCharacters.length
      ? `全剧人物编号表已经先于对白永久锁定：${JSON.stringify(lockedCharacters)}。dialogueLines 每一项必须写成 [上述固定说话人 number, 该人物真正说出口的完整台词, 本句专属表演语气, 明确听者 number, plannedSpeechSeconds, plannedAfterBeatSeconds]；角色姓名、身份、立场、说话目的、说话人与听者 number 必须同时吻合，绝不允许按本段出场顺序重新编号，也不允许互换主角、冲突方或见证人的台词。听者可在画内或画外，即使画外也填其固定 number；只有真正无人物听者才填0。输出前逐句反查“这句话按剧情究竟是谁对谁说”，再填两个 number。`
      : "人物编号表尚未锁定，禁止编写 dialogueLines。",
    lockedScenes.length ? `全剧固定场景表：${JSON.stringify(lockedScenes)}。` : "",
    lockedBeats.length ? `本范围必须承接的锁定因果骨架：${JSON.stringify(lockedBeats)}。不得另起人物关系或颠倒立场。` : "",
    `本段编号已经锁定，但下列 duration 只是断点恢复的初始节奏参考，不是固定镜数公式：${JSON.stringify(allocation)}。普通对话按5–6个有效汉字/秒、冲突对白按至少8个有效汉字/秒计算完整窗口，再为入场/触发、剧情动作、听者闭口反应、有动机运镜、物件/表情特写与末句结果落点单独预留时间；每项 duration 必须写成10–15秒整数，禁止5–9秒碎镜。`,
    last < finalUnit
      ? `全剧最后一镜固定为 S${String(finalUnit).padStart(2, "0")}。当前 S${String(first).padStart(2, "0")}–S${String(last).padStart(2, "0")} 不是结尾：禁止解决主冲突、宣布结局、写“全剧收束/完结/落幕”，也禁止用定格画面结束故事；必须留下可被下一段承接的未完成动作、问题或压力。`
      : `这是全剧最后范围 S${String(first).padStart(2, "0")}–S${String(last).padStart(2, "0")}，只允许在 S${String(finalUnit).padStart(2, "0")} 完成最终收束。最后一镜必须把题材中的 settlementAction=${JSON.stringify(topic?.settlementAction || "")} 和 emotionalPayoff=${JSON.stringify(topic?.emotionalPayoff || "")} 落成可见行动与完整结果；beat/after/cutAfter 都必须写完主语、动作、对象和可见结果，禁止“行动推进N/情节推进/关系改变/完成收束”等占位语，禁止以“说清楚/怎么回事/到底为什么”等重新开启问题的孤立末句收尾。`,
    previousAfter ? `上一镜已锁定的结束状态：${String(previousAfter).slice(0, 180)}。本段首镜 before 必须自然承接。` : "这是开场段，S01 必须立刻呈现可见冲突或伤害钩子。",
    locked.length ? `本段已锁定、绝不可重写的语义单元（只作上下文，不要在本次 u 中重复输出）：${JSON.stringify(locked)}` : "本段暂无已锁定单元。",
    `只输出 JSON 根对象 {\"u\":[...]}。u 必须恰好包含本次未锁定编号：${requestedAllocation.map(item => item.i).join(",") || "无"}；每项依次填写 i、duration、visualReserveSeconds、durationRationale、beat、before、after、visibleCharacterNumbers、dialogueLines、cutAfter、dialogueContinuesToNext。visibleCharacterNumbers 必须列出本镜画面中实际出现并承担动作、说话或可见反应的全部固定人物编号，不设两人入画上限；说话人的编号必须包含在内，不能因为听者或已入场第三人不说话就把他们删掉。`,
    `每项写完整且有剧情作用的对白，句数与说话人数服从实际内容，不设置固定限额；静默反应、动作建立、证据或商品插镜只能作为有对白单元内部切镜，禁止成为零对白生成单元。普通对话按5–6个有效汉字/秒（目标5.5）、争吵/怒斥/强烈质问/控诉/威胁/揭露/反击按至少8个有效汉字/秒计算plannedSpeechSeconds，并同时核验最短/最长窗口。plannedAfterBeatSeconds只放听者闭口反应或结果落点。每镜写明与对白重叠的visualReserveSeconds，任何连续无人说话时段不超过3秒，组织源稿需要的因果动作，按内容决定连续构图或切镜；建立稳定screenSide/depth/facing/eyeline账本，绝不按镜号换边。全部对白与动作按真实重叠关系必须能自然放进10–15秒；放不下就在完整句号处分镜，绝不截句、拖腔或抢读。听者可在画内或画外，不能等于说话人；确实无人物听者才填0。只有第二项属于口型与配音，严禁混入动作、表情、镜头、场景、时码、商品说明或制作说明。每句必须以 。！？… 结束；dialogueContinuesToNext 必须为 false。beat 只写本镜新增事实、权力变化或行动结果；cutAfter 必须是完整句末后的可见动作或反应切点。`,
    repairFailures.length ? `仅修复这些缺口或字段：${repairFailures.join("；")}。已通过的编号不得改写。` : "先在内部核对编号、时长和句末，再一次性输出本段完整 JSON。",
    `结构示例：${JSON.stringify(directFastSemanticScheduleSchema())}`
  ].join("\n");
}

function directFastSemanticUnitFailures(unit, index, options = {}) {
  const failures = [];
  const lines = sourceArray(unit?.dialogueLines);
  if (Number(unit?.i) !== index + 1) failures.push("index");
  if (!Number.isInteger(Number(unit?.duration)) || Number(unit.duration) < 5 || Number(unit.duration) > 15) failures.push("duration");
  if (compact(unit?.beat, "", 160).length < 4) failures.push("beat");
  if (compact(unit?.before, "", 160).length < 2) failures.push("before");
  if (compact(unit?.after, "", 160).length < 2) failures.push("after");
  if (compact(unit?.cutAfter, "", 160).length < 4) failures.push("cutAfter");
  if (unit?.dialogueContinuesToNext === true) failures.push("dialogueContinuesToNext");
  if (lines.some(line => !Array.isArray(line) || !Number.isInteger(Number(line[0])) || Number(line[0]) < 1 || Number(line[0]) > 5
    || spokenLength(line[1]) < 2)) failures.push("dialogueLines");
  if (lines.some(line => {
    if (!Array.isArray(line) || line.length < 4 || line[3] === "" || line[3] === null || line[3] === undefined) return false;
    const speaker = Number(line[0]);
    const listener = Number(line[3]);
    return !Number.isInteger(listener) || listener < 0 || listener > 5 || (listener > 0 && listener === speaker);
  })) failures.push("dialogueListeners");
  const speakers = [...new Set(lines.map(line => Number(Array.isArray(line) ? line[0] : 0)).filter(Number.isFinite))];
  if (speakers.length > 2) failures.push("dialogueSpeakers");
  if (!lines.length) failures.push("emptyDialogueLedger");
  const minimumSpeech = lines.reduce((sum, line) => sum + require("./drama-timing").speechWindowBounds(
    Array.isArray(line) ? line[1] : "", { tone: Array.isArray(line) ? line[2] : "" }
  ).minSeconds, 0);
  if (minimumSpeech + 3 > Number(unit?.duration) + 0.02) failures.push("dialogueActionCapacity");
  const totalUnitCount = Math.max(0, Math.floor(Number(options.totalUnitCount) || 0));
  const authoredText = `${String(unit?.beat || "")} ${String(unit?.after || "")} ${String(unit?.cutAfter || "")}`;
  if (totalUnitCount > 1 && index + 1 < totalUnitCount
    && /(?:全剧|本剧|故事).{0,8}(?:收束|结束|完结)|(?:大结局|最终结局)|(?:画面|故事).{0,8}(?:定格|落幕).{0,10}(?:收束|结束|全剧|故事)/.test(authoredText)) {
    failures.push("prematureFinale");
  }
  return failures;
}

function directFastSemanticScheduleDiagnostics(payload, totalSeconds, options = {}) {
  const units = sourceArray(payload?.u);
  const actualTotal = units.reduce((sum, unit) => sum + (Number(unit?.duration) || 0), 0);
  const invalidUnits = units.map((unit, index) => ({ i: index + 1, failures: directFastSemanticUnitFailures(unit, index, options) }))
    .filter(item => item.failures.length);
  const failures = [];
  if (!units.length) failures.push("empty");
  if (options.durationAdvisory !== true && actualTotal !== Number(totalSeconds)) failures.push(`total:${actualTotal}/${Number(totalSeconds)}`);
  invalidUnits.forEach(item => failures.push(`S${String(item.i).padStart(2, "0")}:${item.failures.join(",")}`));
  return { units, actualTotal, expectedTotal: Number(totalSeconds), invalidUnits, failures, ok: failures.length === 0 };
}

function directFastSemanticScheduleRangeDiagnostics(payload, start, end, durations = [], options = {}) {
  const first = Math.max(1, Math.round(Number(start) || 1));
  const last = Math.max(first, Math.round(Number(end) || first));
  const units = sourceArray(payload?.u);
  const expected = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  const byIndex = new Map();
  const duplicateIndexes = [];
  for (const unit of units) {
    const index = Number(unit?.i);
    if (byIndex.has(index)) duplicateIndexes.push(index);
    else byIndex.set(index, unit);
  }
  const invalidUnits = [];
  for (const index of expected) {
    const unit = byIndex.get(index);
    if (!unit) {
      invalidUnits.push({ i: index, failures: ["missing"] });
      continue;
    }
    const failures = directFastSemanticUnitFailures(unit, index - 1, {
      totalUnitCount: durations.length,
      productStartNumber: options.productStartNumber
    });
    const expectedDuration = Number(durations[index - 1]);
    if (options.durationAdvisory !== true && Number.isFinite(expectedDuration) && Number(unit.duration) !== expectedDuration) failures.push("durationPlan");
    if (failures.length) invalidUnits.push({ i: index, failures });
  }
  const outOfRange = units.map(unit => Number(unit?.i)).filter(index => !expected.includes(index));
  const expectedTotal = expected.reduce((sum, index) => sum + (Number(durations[index - 1]) || 0), 0);
  const actualTotal = expected.reduce((sum, index) => sum + (Number(byIndex.get(index)?.duration) || 0), 0);
  const failures = [];
  if (units.length !== expected.length) failures.push(`count:${units.length}/${expected.length}`);
  if (duplicateIndexes.length) failures.push(`duplicate:${duplicateIndexes.join(",")}`);
  if (outOfRange.length) failures.push(`outOfRange:${outOfRange.join(",")}`);
  if (options.durationAdvisory !== true && actualTotal !== expectedTotal) failures.push(`total:${actualTotal}/${expectedTotal}`);
  invalidUnits.forEach(item => failures.push(`S${String(item.i).padStart(2, "0")}:${item.failures.join(",")}`));
  return {
    units: expected.map(index => byIndex.get(index)).filter(Boolean),
    actualTotal,
    expectedTotal,
    expectedIndexes: expected,
    invalidUnits,
    failures,
    ok: failures.length === 0
  };
}

// Recover complete semantic units from a response whose outer JSON was cut off.
// Only balanced objects are accepted; the incomplete tail is deliberately left
// for the next AI repair request so authored content is never fabricated locally.
function recoverDirectFastSemanticUnitsFromRaw(rawText) {
  const source = String(rawText || "");
  const units = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;
    let depth = 0; let inString = false; let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const value = JSON.parse(source.slice(start, index + 1));
          if (value && typeof value === "object" && !Array.isArray(value)
            && Number.isInteger(Number(value.i)) && value.duration != null
            && (value.beat || value.before || value.after || value.cutAfter)) units.push(value);
        } catch {}
        break;
      }
    }
  }
  const byIndex = new Map();
  for (const unit of units) {
    const index = Number(unit.i);
    if (index > 0 && !byIndex.has(index)) byIndex.set(index, unit);
  }
  return [...byIndex.values()].sort((a, b) => Number(a.i) - Number(b.i));
}

function assertDirectFastSemanticSchedule(payload, totalSeconds, options = {}) {
  const diagnostics = directFastSemanticScheduleDiagnostics(payload, totalSeconds, options);
  if (!diagnostics.ok) throw Object.assign(new Error("语义切镜未返回连续、完整句末且总时长精确的结构"), {
    code: "SCRIPT_SEMANTIC_SCHEDULE_CONTRACT_FAILED",
    expectedTotalSeconds: Number(totalSeconds),
    actualTotalSeconds: diagnostics.actualTotal,
    unitCount: diagnostics.units.length,
    failures: diagnostics.failures,
    invalidSchedule: diagnostics.units,
    noAutomaticRetry: false,
    retryRequiresExplicitResume: false
  });
  return diagnostics.units;
}

function directFastSegmentRanges(unitCount, segmentSize = 5) {
  const count = Math.max(1, Math.floor(Number(unitCount) || 1));
  const size = Math.max(1, Math.min(count, Math.floor(Number(segmentSize) || 5)));
  const ranges = [];
  for (let start = 1; start <= count; start += size) {
    ranges.push([start, Math.min(count, start + size - 1)]);
  }
  return ranges;
}

function directFastStorySpineSchema() {
  return {
    c: [{ n: "姓名", g: "男/女/中性", a: "年龄段", r: "身份、关系与本剧立场", d: "外貌体态" }],
    sc: [{ n: "场景名", d: "空间与全剧剧情任务" }],
    b: [{ a: 1, z: 5, sc: 1, en: "本段进入时已成立的事实", g: "本段唯一新增事实与行动目标", ex: "本段结束时不可逆的新状态", h: "交给下一段的动作或悬念" }]
  };
}

function directFastStorySpinePrompt({ topic, product, unitCount, totalSeconds, productStartNumber, segmentRanges = [] }) {
  const density = storyDensityTargets(totalSeconds, unitCount);
  return [
    `先为一部${totalSeconds}秒、共${unitCount}镜的现实主义竖屏短剧建立唯一全剧骨架。`,
    `题材：${JSON.stringify(topic)}`,
    `商品：${product.name}；只允许使用这些事实：${product.sellingPoints || product.description || "用户未提供额外卖点"}。`,
    `只输出紧凑JSON，根对象严格只含c/sc/b。c写3-5名全剧固定人物；sc写${density.sceneMin}-${density.sceneMax}个有不同剧情任务的固定场景；b恰好${segmentRanges.length}项并按顺序覆盖${JSON.stringify(segmentRanges)}。`,
    "人物编号全剧不变：1=主角，2=核心冲突方，3=关键见证人；每人的g必须明确写本人性别男/女/中性，不能从其配偶或亲属性别反推；身份、关系、立场和外貌必须具体，人物不能跨段改名或互换身份。",
    `每个b只含a/z/sc/en/g/ex/h。b.sc只能写1到sc数组长度之间的整数索引（例如1），禁止写场景名、SC01、字符串数字或0。en是本段进入时已成立的事实；g是本段唯一新增事实和可见行动；ex是不可逆结果；h是下一段第一镜可直接承接的动作、物件、末句或悬念。相邻段必须满足上一段ex/h能够因果承接下一段en，禁止重复争吵和同义复述。`,
    `唯一主反转固定在约72%位置；${product.name}及任何俗称在S${String(productStartNumber).padStart(2, "0")}之前不得出现，之后只用真实需求→自然操作→可见合规结果→人物决定完成植入。最后一镜必须保留人物、动作与因果结局，商品只能进入该行动，不得用无人静物特写覆盖故事收束；不得补写治疗、治愈、止痛、康复保证或用户未提供的功效。`,
    "最高优先级是观众能看懂、愿意看进去：每段必须推进新信息、新行动或新关系后果；对白的说话人、听者、语气和表情要有明确剧情依据。",
    "回复首字符必须是{，末字符必须是}；不要解释、Markdown、分镜正文、画面提示词、模型名称或任何确认语。",
    `结构示例：${JSON.stringify(directFastStorySpineSchema())}`
  ].join("\n");
}

function assertDirectFastStorySpine(payload, ranges) {
  const expected = sourceArray(ranges);
  const characters = sourceArray(payload?.c);
  const scenes = sourceArray(payload?.sc);
  const beats = sourceArray(payload?.b);
  const beatFailures = [];
  const validBeats = beats.length === expected.length && expected.every(([start, end], index) => {
    const beat = beats[index] || {};
    const failures = [];
    if (Number(beat.a) !== Number(start)) failures.push(`a必须是${start}`);
    if (Number(beat.z) !== Number(end)) failures.push(`z必须是${end}`);
    if (!(Number(beat.sc) >= 1 && Number(beat.sc) <= scenes.length)) failures.push(`sc必须在1-${scenes.length}之间`);
    if (compact(beat.en, "", 200).length < 4) failures.push("en至少4字");
    if (compact(beat.g, "", 200).length < 4) failures.push("g至少4字");
    if (compact(beat.ex, "", 200).length < 4) failures.push("ex至少4字");
    if (compact(beat.h, "", 200).length < 2) failures.push("h至少2字");
    if (failures.length) beatFailures.push({ index, expected: [Number(start), Number(end)], failures });
    return Number(beat.a) === Number(start)
      && Number(beat.z) === Number(end)
      && Number(beat.sc) >= 1
      && Number(beat.sc) <= scenes.length
      && compact(beat.en, "", 200).length >= 4
      && compact(beat.g, "", 200).length >= 4
      && compact(beat.ex, "", 200).length >= 4
      && compact(beat.h, "", 200).length >= 2;
  });
  if (characters.length < 3 || characters.length > 5 || scenes.length < 1 || !validBeats) {
    const details = {
      characterCount: characters.length,
      requiredCharacterCount: "3-5",
      sceneCount: scenes.length,
      requiredSceneCount: ">=1",
      beatCount: beats.length,
      expectedBeatCount: expected.length,
      expectedRanges: expected.map(range => range.map(Number)),
      beatFailures
    };
    throw Object.assign(new Error("全剧人物、场景与分段因果骨架不完整"), {
      code: "SCRIPT_DIRECT_SPINE_CONTRACT_FAILED",
      noAutomaticRetry: true,
      retryRequiresExplicitResume: true,
      details,
      invalidDraft: payload
    });
  }
  return payload;
}

function directFastBeatForRange(spine, segmentStart, segmentEnd) {
  const start = Number(segmentStart);
  const end = Number(segmentEnd);
  return sourceArray(spine?.b).find(item => Number(item?.a) === start && Number(item?.z) === end) || null;
}

function directFastSpineFromLegacyPayload(payload, ranges, topic = {}) {
  const characters = sourceArray(payload?.c).slice(0, 5);
  const scenes = sourceArray(payload?.sc).slice(0, 8);
  if (characters.length < 3 || scenes.length < 1) return null;
  const shots = sourceArray(payload?.s);
  const beats = sourceArray(ranges).map(([start, end], index) => {
    const segmentShots = shots.filter(item => Number(item?.i) >= Number(start) && Number(item?.i) <= Number(end));
    const first = segmentShots[0] || {};
    const last = segmentShots.at(-1) || {};
    const ratio = index / Math.max(1, sourceArray(ranges).length - 1);
    const goal = ratio < 0.2
      ? topic.hook
      : ratio < 0.65
        ? topic.proofChain || topic.logline
        : ratio < 0.8
          ? topic.reversal
          : topic.emotionalPayoff || topic.logline;
    return {
      a: Number(start),
      z: Number(end),
      sc: (index % scenes.length) + 1,
      en: compact(first.bf, index ? `承接上一段留下的动作与未解决事实` : topic.hook || "伤害动作已经发生", 120),
      g: compact(first.a || goal, `推进第${index + 1}段唯一新事实和行动`, 120),
      ex: compact(last.af, `第${index + 1}段形成不可逆的新状态`, 120),
      h: compact(last.a, index === sourceArray(ranges).length - 1 ? "人物用行动完成结局" : "末句与手部动作交给下一段", 80)
    };
  });
  return { c: characters, sc: scenes, b: beats };
}

function assertDirectFastSegment(payload, segmentStart, segmentEnd, options = {}) {
  const start = Math.max(1, Math.floor(Number(segmentStart) || 1));
  const end = Math.max(start, Math.floor(Number(segmentEnd) || start));
  const expected = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const shots = sourceArray(payload?.s);
  const actual = shots.map(item => Math.floor(Number(item?.i) || 0));
  const characters = sourceArray(options.characters).length ? sourceArray(options.characters) : sourceArray(payload?.c);
  const scenes = sourceArray(options.scenes).length ? sourceArray(options.scenes) : sourceArray(payload?.sc);
  const hasReferenceData = characters.length >= 3 && scenes.length >= 1;
  const exactRange = actual.length === expected.length && actual.every((number, index) => number === expected[index]);
  const strictFailures = [];
  const strictShape = options.strict !== true || shots.every(item => {
    const dialogue = sourceArray(item?.d);
    const visible = sourceArray(item?.v).map(Number);
    const focus = Number(item?.f);
    const shotNumber = Number(item?.i) || 0;
    const semanticUnit = sourceArray(options.semanticUnits).find(unit => Number(unit?.i) === shotNumber);
    const lockedDialogue = sourceArray(semanticUnit?.dialogueLines);
    const dialogueSpeakers = dialogue.map(line => Number(Array.isArray(line) ? line[0] : 0));
    const uniqueSpeakers = [...new Set(dialogueSpeakers.filter(Number.isFinite))];
    const semanticDialogue = !semanticUnit || (
      dialogue.length === lockedDialogue.length
      && dialogue.every((line, index) => Array.isArray(line)
        && Number(line[0]) === Number(lockedDialogue[index]?.[0])
        && String(line[1] || "").trim() === String(lockedDialogue[index]?.[1] || "").trim()
        && (lockedDialogue[index]?.[3] === undefined || lockedDialogue[index]?.[3] === null || lockedDialogue[index]?.[3] === ""
          || Number(line[5]) === Number(lockedDialogue[index]?.[3])))
    );
    const checks = {
      title: compact(item?.t, "", 80).length >= 2,
      action: compact(item?.a, "", 160).length >= 4,
      before: compact(item?.bf, "", 160).length >= 4,
      after: compact(item?.af, "", 160).length >= 4,
      emotion: compact(item?.em, "", 120).split("→").length >= 3,
      focus: focus >= 1 && focus <= characters.length,
      visible: visible.length >= 1 && new Set(visible).size === visible.length && visible.every(value => value >= 1 && value <= characters.length),
      // Turn count, punctuation and character-per-second targets are creative
      // guidance.  They must not strand a structurally usable result or cause
      // paid rewrites; exact authored dialogue is preserved below.
      turns: true,
      dialogue: dialogue.every(line => Array.isArray(line) && Number(line[0]) >= 1 && Number(line[0]) <= characters.length && spokenLength(line[1]) >= 2),
      semanticDialogue,
      dialogueBudget: true,
      speakers: uniqueSpeakers.length <= 2 && dialogueSpeakers.every(value => visible.includes(value)),
      unique: true,
      opening: true
    };
    const passed = Object.values(checks).every(Boolean);
    if (!passed) strictFailures.push({ shot: Number(item?.i) || 0, failed: Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key) });
    return passed;
  });
  if (!hasReferenceData || !exactRange || !strictShape) {
    throw Object.assign(new Error(
      `剧本 S${String(start).padStart(2, "0")}–S${String(end).padStart(2, "0")} 未返回完整连续、可表演的对白结构`
    ), {
      code: "SCRIPT_DIRECT_SEGMENT_CONTRACT_FAILED",
      segmentStart: start,
      segmentEnd: end,
      expectedShotNumbers: expected,
      actualShotNumbers: actual,
      strictFailures,
      noAutomaticRetry: true,
      retryRequiresExplicitResume: true
    });
  }
  return payload;
}

function directFastUserPrompt({ topic, product, unitCount, totalSeconds, productStartNumber, segmentStart = 1, segmentEnd = unitCount, scriptFormatDirective = "", spine = null, segmentRanges = [], unitDurations = [], semanticUnits = [], repairFailures = [], anchor = false }) {
  const start = Math.max(1, Math.min(unitCount, Number(segmentStart) || 1));
  const end = Math.max(start, Math.min(unitCount, Number(segmentEnd) || unitCount));
  const segmentCount = end - start + 1;
  const durationContract = Array.from({ length: segmentCount }, (_, offset) => {
    const number = start + offset;
    const seconds = Math.max(10, Math.min(15, Number(unitDurations[number - 1]) || Math.round(totalSeconds / unitCount) || 12));
    return `S${String(number).padStart(2, "0")}=${dialogueUnitPrompt(seconds, { solo: false, productPackshot: number === productStartNumber })}`;
  }).join("；");
  const beat = directFastBeatForRange(spine, start, end);
  const lockedSemanticUnits = sourceArray(semanticUnits).filter(unit => Number(unit?.i) >= start && Number(unit?.i) <= end);
  const repairNotes = sourceArray(repairFailures).map(item => compact(item, "", 180)).filter(Boolean).slice(-12);
  const rootContract = anchor
    ? `根对象严格为c/sc/b/s。c和sc是全剧唯一人物表与场景表；b必须按顺序覆盖这些分段：${JSON.stringify(segmentRanges)}；s只写本次第${start}-${end}镜。`
    : spine
      ? `根对象严格只含s；全剧人物编号与场景不可改写。固定人物：${JSON.stringify(spine.c)}；固定场景：${JSON.stringify(spine.sc)}；本段因果任务：${JSON.stringify(beat)}。`
      : "根对象严格为c/sc/s。";
  return [
    spine ? `STRICT OUTPUT BOUNDARY: return exactly one root object {"s":[...]}. Do not include c, sc, b, characters, scenes, props, sound, continuity, closure, commentary, or any whole-script data.` : "",
    repairNotes.length ? `REPAIR ONLY THIS SEGMENT: ${repairNotes.join("; ")}. Return the complete segment JSON again; do not explain the prior failure and do not omit any shot or locked dialogue.` : "",
    `请写一部${totalSeconds}秒竖屏短剧的紧凑剧情母稿第${start}-${end}镜，共${segmentCount}镜；全剧总计${unitCount}镜。`,
    `题材：${JSON.stringify(topic)}`,
    `商品：${product.name}；卖点：${product.sellingPoints || product.description || "只按用户提供事实"}。`,
    `只输出JSON，${rootContract} 人物序号固定：1=主角，2=与主角发生核心冲突的人，3=关键见证人；s必须恰好${segmentCount}项，i从${start}连续到${end}，不得输出区间外镜头。`,
    anchor ? "b的每一段必须承接上一段ex：en写进入事实，g只写本段新增事实和动作，ex写不可逆结果，h写下一段能直接接拍的动作或悬念；不得重复争吵、重复误会或提前泄露主反转。" : "本段第一镜bf必须承接因果任务en，最后一镜af必须落实ex，末句和末动作必须交出h；不得另起故事、改名、换关系或重复上一段信息。",
    "每个s只允许t/a/bf/af/em/f/v/d/visualReserveSeconds/durationRationale字段：f和v使用c的1起始序号；v保留全部实际入画人物，不设两人入画上限，f只是本单元开场焦点，不是全段唯一说话人；a/bf/af只能写c中已锁定人物或直接写人物序号，不得发明、复制示例或沿用其他故事的人名；d必须有1–2项，每项严格为[说话人序号,完整台词,语气与气口,面部/身体动作,听者反应,明确听者序号,plannedSpeechSeconds,plannedAfterBeatSeconds]，后两项由逐句试演决定。只有第二项是人物真正说出口的内容，其余项永远是静默制作说明。听者可在画内或画外，必须填固定人物序号，只有真正无人物听者才填0。说话人序号必须来自v，同一S可由两人自然问答，其他入画人物闭口并执行其可见反应。说话人变化时按对白顺序形成明确正反打切点；商品整体或细节镜只能作为该有对白S内部的短暂插镜。",
    `每镜d严格按本镜时长写自然可演对白：${durationContract}。普通对白按5–6个有效汉字/秒、冲突对白按至少8个有效汉字/秒计算，同步组织开场/入场或触发、剧情动作、听者反应、有动机运镜、物件/表情特写和末句结果落点；每段连续无人说话时间不得超过3秒；组织源稿需要的因果相连动作，不设拍点数，禁止站桩。每句必须完整且改变信息、权力或行动，不能同义复述；语气与表情写清起点→触发→峰值→余震。`,
    lockedSemanticUnits.length ? `【不可改写的语义切镜与完整台词】${JSON.stringify(lockedSemanticUnits)}。每个s的i、时长语义、bf、af、动作落点和d台词原文必须逐项对应；只能补语气、气口、身体动作和听者反应。禁止删字、改字、并句、拆句或把半句移到下一镜。` : "",
    "对白质量优先级固定为：对白内容＞语气＞情绪＞场景＞运镜＞其他。禁止把时间码、场景标题、动作说明、商品说明、制作说明写进d；禁止连续使用‘核准/作证/不是误会/为何被藏’等模板词填充全剧，禁止每句套用同一套情绪描述。",
    "S01前2秒必须由伤害动作直接开场，第一句必须是6-12字的质问或制止；前60秒优先在同一连续S单元内完成短句问答，当前说话人开口、听者闭口反应，换人即按时间点硬切到回应者机位，禁止错嘴。",
    `唯一主反转固定在约72%位置。${product.name}及任何俗称在S${String(productStartNumber).padStart(2, "0")}之前绝对禁止出现；S${String(productStartNumber).padStart(2, "0")}-S${String(Math.min(unitCount, productStartNumber + 2)).padStart(2, "0")}才用3镜完成真实需求→自然使用→可见合规体验→人物决定，不写治疗、治愈或医疗承诺。最后一镜回到人物行动结局。`,
    scriptFormatDirective,
    "总JSON尽量紧凑，不要解释，不要Markdown，不要输出画面提示词、声音提示词或模型名称。",
    "回复的第一个字符必须是{，最后一个字符必须是}。禁止先说‘我会按要求编写’或任何确认、计划、说明；直接给完整JSON。",
    `结构示例：${JSON.stringify(anchor ? { ...directFastStorySpineSchema(), s: directFastResponseSchema().s } : spine ? { s: directFastResponseSchema().s } : directFastResponseSchema())}`
  ].join("\n");
}

function characterFallbacks(topic = {}) {
  const relationship = compact(topic.relationship, "家人", 16);
  return [
    { n: "主角", a: "成年", r: `${relationship}中的核心当事人，也是长期承担者`, d: "外貌、体态和永久识别特征按本剧题材建立" },
    { n: "冲突方", a: "成年", r: `${relationship}中的核心冲突方`, d: "外貌、体态和永久识别特征与主角清楚区分" },
    { n: "见证人", a: "成年", r: "掌握关键事实并推动行动的见证人", d: "外貌、体态和永久识别特征与前两人清楚区分" }
  ];
}

function inferredVoiceDescription(character = {}, index = 0) {
  const explicitGender = String(character.g || character.gender || character.sex || "").trim();
  const roleLead = String(character.r || character.role || "").split(/[，。；、]/)[0];
  const descriptionLead = String(character.d || character.description || "").split(/[，。；、]/)[0];
  const identitySource = `${explicitGender} ${roleLead} ${descriptionLead}`;
  const source = `${character.n || character.name || ""} ${character.a || character.age || ""} ${identitySource}`;
  // Infer only from the character's explicit field and leading self-identity.
  // Scanning the whole relationship paragraph made a husband become female
  // merely because his role text also mentioned “妻子”.
  const female = /女(?:性|人|孩|儿|声)?|母亲|妈妈|妻子|姐姐|妹妹|奶奶|婆婆|阿姨|姑姑|婶婶|嫂子/.test(identitySource);
  const male = /男(?:性|人|孩|声)?|父亲|爸爸|丈夫|哥哥|弟弟|爷爷|叔叔|舅舅|伯伯/.test(identitySource);
  const older = /老年|中老年|老人|爷|奶|婆|[6-9]\d岁/.test(source);
  const young = /少年|青年|学生|小伙|姑娘|1\d岁|2\d岁/.test(source);
  const gender = female !== male ? (female ? "女声" : "男声") : "自然中性声线";
  const age = older ? "中老年" : young ? "青年" : "成年";
  const texture = index % 3 === 0 ? "中低音、沉稳有生活质感" : index % 3 === 1 ? "中音、清晰偏紧" : "中音、厚实克制";
  return `${age}${gender}；${texture}；语速、重音和气口随本角色当前冲突自然变化`;
}

function buildDirectFastFallbackSpine({ topic = {}, ranges = [] } = {}) {
  const characters = characterFallbacks(topic);
  const scenes = [
    { n: "家庭客厅", d: "门口、沙发、茶几与通道关系清楚，承担冲突开场和关系施压" },
    { n: "旧物整理间", d: "纸箱、桌面与文件阅读区固定，承担证据递进和主反转" },
    { n: "社区工作室", d: "工作台、低柜与行动通道固定，承担商品真实使用和结局回收" }
  ];
  const items = sourceArray(ranges);
  return {
    c: characters,
    sc: scenes,
    b: items.map(([start, end], index) => ({
      a: Number(start),
      z: Number(end),
      sc: (index % scenes.length) + 1,
      en: index === 0
        ? compact(topic.hook, "伤害动作已经发生，冲突双方当场对峙", 120)
        : `承接上一段留下的物件、末句和未解决事实${index}`,
      g: compact([topic.proofChain, topic.logline, topic.reversal, topic.emotionalPayoff][index % 4], `第${index + 1}段只推进一项新证据和可见行动`, 120),
      ex: `第${index + 1}段完成动作后形成不可逆的新关系状态`,
      h: index === items.length - 1 ? "人物用持续行动完成结局" : `以第${index + 1}段末句、视线和手部动作交给下一段`
    }))
  };
}

function fallbackDialogue(number, duration, focus, other, solo, context = {}) {
  const seconds = Math.max(10, Math.min(15, Number(duration) || 12));
  const budget = dialogueUnitBudget(seconds, { solo });
  const count = budget.targetTurns;
  const stage = String(context.stage || "pressure");
  const topic = context.topic || {};
  const proofItems = String(topic.proofChain || topic.themeObject || "当年的证据")
    .split(/[、，,；;\/／]+/).map(item => compact(item, "", 10)).filter(Boolean);
  const proofAt = offset => proofItems[(number + offset) % Math.max(1, proofItems.length)] || compact(topic.themeObject, "当年的证据", 10);
  const theme = compact(topic.themeObject, "这件旧物", 10);
  const reversal = "事情根本不是你说的那样";
  const payoff = "把欠下的用行动补回来";
  const banks = {
    hook: ["住手！有话冲我来", "先把人放开", "你砸的是一家人的活路", "先把手放下再说", "今天谁也别想躲"],
    pressure: [`你说他欠钱，${proofAt(0)}呢`, `${theme}一直在他手里`, `别拿亲情逼人认账`, `我已经为这事付出代价`, `你敢不敢当面把账说清`, `砸坏的东西你先赔`],
    cost_kindness: ["我先护住人，工作丢了也认", "她吃的苦不是一句活该", `为了${theme}，她让掉了退路`, "你可以不领情，不能再伤她", "先让她把真话说完", "这份亏欠我替她记着"],
    evidence: [`${proofAt(0)}上的时间对不上`, `${proofAt(1)}把前后经过都记下了`, `你刚才说的话和${proofAt(2)}矛盾`, `别碰${theme}，原样放回去`, "现在请你看着我回答", "这不是猜测，是你亲手留下的"],
    main_reversal: [`原来${reversal}`, "这些年是我错怪她了", "你拿别人的忍让当软弱", "一句道歉抵不了这些损失", "欠下的钱和尊严都要还", "从现在起由她自己决定"],
    payoff: [`先把${proofAt(0)}交回去`, "损失我今天就补", "该道歉的人一个都不能少", "这次我站在她这边", "后果由我来承担", `我要亲手把${payoff}做成`],
    ending: [`${theme}收好，别再丢了`, "说过的补偿都已经办完", "往后遇事先听完真话", "这一次我不会再让她退", payoff, "明天我们一起重新开始"]
  };
  const templates = number === 1 ? banks.hook : (banks[stage] || banks.pressure);
  let selected = Array.from({ length: count }, (_, index) => templates[(number + index - 1) % templates.length]);
  let totalSpoken = selected.reduce((sum, text) => sum + spokenLength(text), 0);
  // Deterministic fallback must itself satisfy the local short-sentence budget
  // it is validated against; otherwise the emergency path throws instead of
  // yielding a resumable unit. Extend turns until at least `minChars` is
  // reached, without crossing `maxChars`.
  const completeExtensions = [
    "你现在必须当面对我说清楚",
    "请你把话一次说完整",
    "这次你别再回避事实",
    "事情总要有个清楚的交代",
    "你今天躲不过这个追问",
    "这笔账迟早要算明白",
    "我把证据就放在你面前",
    "你亲眼看见也赖不掉"
  ];
  const extensionOrder = number === 1 ? [1, 0] : selected.map((_, index) => index);
  for (let guard = 0; totalSpoken < budget.minChars && guard < 200; guard++) {
    const index = extensionOrder[guard % extensionOrder.length];
    const candidate = completeExtensions[guard % completeExtensions.length];
    if (totalSpoken + spokenLength(candidate) > budget.maxChars) continue;
    selected[index] = `${selected[index]}，${candidate}`;
    totalSpoken += spokenLength(candidate);
  }
  while (totalSpoken > budget.maxChars && selected.length > budget.minTurns) {
    selected.pop();
    totalSpoken = selected.reduce((sum, text) => sum + spokenLength(text), 0);
  }
  if (totalSpoken < budget.minChars || totalSpoken > budget.maxChars) {
    const error = new Error(`本地完整短句预算 ${totalSpoken} 字不在 ${budget.minChars}-${budget.maxChars} 字范围内`);
    error.code = "DIRECT_FAST_FALLBACK_DIALOGUE_BUDGET_INVALID";
    throw error;
  }
  const deliveries = [
    "压着急火开口，关键事实逐字加重，句尾短促落下",
    "先本能防御，听见事实后语速放慢，尾音发虚",
    "情绪被刺中后拔高半度，重音落在损失和选择上",
    "声音回落但态度更硬，停半拍后把决定说完"
  ];
  const bodies = ["眉心收紧，手掌护住眼前的人或物", "视线躲开一瞬，肩膀收紧后重新对视", "下颌绷紧，身体向前半步逼对方回应", "呼吸停半拍，手部完成归还、阻拦或站队动作"];
  const reactions = ["闭口倒吸一口气，手停在半空", "闭口盯住说话人，眼神从强硬变迟疑", "闭口后退半步，手指不自觉松开", "闭口消化末句，随后用可见动作作出选择"];
  return selected.map((text, index) => {
    const spoken = `${text}${number === 1 && index === 0 ? "！" : "。"}`;
    return [
      solo || index % 2 === 0 ? focus : other,
      spoken,
      deliveries[index % deliveries.length],
      bodies[index % bodies.length],
      reactions[index % reactions.length],
      solo ? 0 : (solo || index % 2 === 0 ? other : focus),
      estimateActedSpeechSeconds(spoken),
      0.45
    ];
  });
}

function fallbackAction(number, stage, focusName, otherName, beat = {}, topic = {}) {
  const objects = ["旧物夹层", "日期记录", "汇款回单", "门口监控", "邻居证词", "签字笔迹", "工作记录", "通话清单", "银行回单", "手写账页", "钥匙去向", "收据背面"];
  const verbs = ["摊开", "翻到", "对准", "递出", "圈出", "按住", "取回", "锁定", "拍下", "交给", "核准"];
  const reactions = ["停住抢夺的手", "后退半步", "移开视线", "松开门把", "压下争辩", "接过记录", "叫来见证人", "把旧物放回桌面", "当场改口", "撤回刚才的决定"];
  const object = objects[(number * 5) % objects.length];
  const verb = verbs[(number * 7) % verbs.length];
  const reaction = reactions[(number * 3) % reactions.length];
  const sourceFact = compact([topic.themeObject, topic.proofChain, beat.g].filter(Boolean)[number % 3], object, 22);
  if (stage === "main_reversal") return `${focusName}${verb}${sourceFact}完成最终核对，${otherName}${reaction}并当众承认旧判断错误`;
  if (stage === "cost_kindness") return `${focusName}放下自己的退路，${verb}${sourceFact}保护家人，${otherName}${reaction}`;
  if (stage === "evidence") return `${focusName}${verb}${sourceFact}逐项核对，${otherName}${reaction}，新的事实进入众人视线`;
  if (stage === "payoff") return `${focusName}${verb}${object}落实补偿，${otherName}${reaction}，关系边界因此改变`;
  if (stage === "ending") return `${focusName}收好${sourceFact}并兑现后续安排，${otherName}${reaction}，两人带着新决定离开`;
  return `${focusName}${verb}${object}追问刚才的伤害，${otherName}${reaction}，现场失去一条退路`;
}

function buildDirectFastFallbackSegment({ spine = {}, topic = {}, segmentStart = 1, segmentEnd = 1, unitDurations = [], productStartNumber = 0 } = {}) {
  const characters = sourceArray(spine.c).length >= 3 ? spine.c : characterFallbacks(topic);
  const scenes = sourceArray(spine.sc).length ? spine.sc : buildDirectFastFallbackSpine({ topic, ranges: [[segmentStart, segmentEnd]] }).sc;
  const start = Math.max(1, Math.floor(Number(segmentStart) || 1));
  const end = Math.max(start, Math.floor(Number(segmentEnd) || start));
  return {
    s: Array.from({ length: end - start + 1 }, (_, offset) => {
      const number = start + offset;
      const duration = Math.max(10, Math.min(15, Number(unitDurations[number - 1]) || 12));
      // Test-only emergency structure mirrors the runtime continuity contract:
      // one S unit can carry a two-person exchange and the Director Agent later
      // compiles its turns into camera takes inside one provider block.
      const focus = number % 2 === 0 ? 2 : 1;
      const other = focus === 1 ? 2 : 1;
      const solo = false;
      const beat = sourceArray(spine.b).find(item => Number(item?.a) <= number && Number(item?.z) >= number) || {};
      const stage = stageFor(number - 1, Math.max(end, unitDurations.length || end));
      const focusName = compact(characters[focus - 1]?.n, `角色${focus}`, 12);
      const otherName = compact(characters[other - 1]?.n, `角色${other}`, 12);
      const coreAction = fallbackAction(number, stage, focusName, otherName, beat, topic);
      return {
        i: number,
        t: number === 1 ? "当场制止" : stage === "main_reversal" ? "证据翻转" : `行动推进${number}`,
        a: number === 1
          ? `${focusName}冲过去推开正在伤人的手并拦住对方，${otherName}当场回应；${compact(topic.hook, "当场伤害被制止", 54)}`
          : coreAction,
        bf: compact(beat.en, `第${number}镜开始时上一项事实仍未解决`, 120),
        af: compact(beat.ex, `第${number}镜结束时关系和证据状态已经改变`, 120),
        em: stage === "main_reversal" ? "压抑→看清证据→情绪崩开→决定承担" : "克制→事实刺激→情绪抬升→压住余震",
        f: focus,
        v: [focus, other],
        d: fallbackDialogue(number, duration, focus, other, solo, { stage, beat, topic })
      };
    }),
    c: characters,
    sc: scenes
  };
}

// Used only when the relay has exhausted its bounded, receipt-aware recovery
// attempts without returning *any* body for a missing semantic unit.  It does
// not touch accepted model units; it turns the same deterministic production
// contract into a valid semantic envelope so the project can continue.
function buildDirectFastFallbackSemanticUnit({ topic = {}, spine: lockedSpine = null, index = 1, duration = 10, productStartNumber = 0, previousAfter = "" } = {}) {
  const number = Math.max(1, Math.floor(Number(index) || 1));
  const seconds = Math.max(10, Math.min(15, Math.floor(Number(duration) || 12)));
  const spine = lockedSpine && sourceArray(lockedSpine?.c).length >= 3
    ? lockedSpine
    : buildDirectFastFallbackSpine({ topic, ranges: [[number, number]] });
  const shot = buildDirectFastFallbackSegment({
    spine,
    topic,
    segmentStart: number,
    segmentEnd: number,
    unitDurations: Array.from({ length: number }, (_, offset) => offset + 1 === number ? seconds : 10),
    productStartNumber
  }).s[0];
  let dialogueLines = sourceArray(shot?.d).map(line => [Number(line?.[0]), String(line?.[1] || "").trim()])
    .filter(line => Number.isInteger(line[0]) && line[1]);
  const budget = dialogueUnitBudget(seconds, { solo: new Set(dialogueLines.map(line => line[0])).size <= 1 });
  const spoken = () => dialogueLines.reduce((sum, line) => sum + spokenLength(line[1]), 0);
  if (spoken() > budget.maxChars || dialogueLines.length < budget.minTurns || dialogueLines.length > budget.maxTurns) {
    const source = dialogueLines.map(line => [line[0], line[1]]);
    dialogueLines = fitDialogueLines(source, false, seconds, { solo: true })
      .map(line => [Number(line.speaker) || 1, String(line.text || "").trim()]);
  }
  return {
    i: number,
    duration: seconds,
    beat: completeNarrative(shot?.a, "当前镜头推进一项新事实"),
    before: completeNarrative(previousAfter || shot?.bf, "承接上一镜尚未解决的行动"),
    after: completeNarrative(shot?.af, "本镜形成新的可见关系状态"),
    visibleCharacterNumbers: [...new Set(sourceArray(shot?.v).map(Number).filter(Number.isInteger))],
    dialogueLines: dialogueLines.map((line, index) => [
      line[0],
      line[1],
      semanticDeliveryForLine({ beat: shot?.t, before: shot?.bf, after: shot?.af }, line[1], index),
      sourceArray(shot?.v).map(Number).find(value => Number.isInteger(value) && value !== line[0]) || 0,
      estimateActedSpeechSeconds(line[1]),
      index === dialogueLines.length - 1 ? 0.8 : 0.45
    ]),
    visualReserveSeconds: Math.max(3, seconds * 0.24),
    durationRationale: "本地兼容保底按完整句表演、听者反应和动作落点共同保留时长",
    cutAfter: completeNarrative(shot?.a, "末句后以可见动作落点切镜"),
    dialogueContinuesToNext: false
  };
}

function semanticDeliveryForLine(unit = {}, text = "", index = 0) {
  const context = `${unit?.beat || ""} ${unit?.before || ""} ${unit?.after || ""} ${text}`;
  if (/心疼|安慰|照顾|扶起|戴上|保护|奶奶|母亲|老人/u.test(context)) {
    return "心疼而克制地轻声说，语速放慢，关键信息柔和落重音，句尾留半拍确认对方反应";
  }
  if (/痛心|绝望|妥协|哭|作孽|委屈|颤抖/u.test(context)) {
    return "痛心无力地低声挤出，音量偏低、语速断续，重音带颤，句尾泄气并停顿";
  }
  if (/质问|逼|抢|怒|制止|住手|欺负|威胁|驱逐|过户/u.test(context) || /！$/.test(String(text || "").trim())) {
    return index % 2
      ? "被逼到慌乱后强撑着提高音量，语速先快后慢，重音落在辩解事实，句尾发虚"
      : "压着怒气陡然提高音量，语速短促有力，重音砸在关键事实，句尾收住等待回应";
  }
  if (/证据|合同|日期|签名|真相|确认|看清/u.test(context) || /[？?]$/.test(String(text || "").trim())) {
    return "警惕而克制地追问，音量适中、语速略慢，重音落在证据词，句尾上扬后留出回答气口";
  }
  return index % 2
    ? "先防御后松动地回应，音量适中、语速逐渐放缓，重音落在事实，句尾留半拍"
    : "克制但明确地开口，音量适中、语速稳定，重音落在核心事实，句尾收稳等待反应";
}

function semanticBodyForLine(unit = {}, delivery = "", index = 0) {
  const context = `${unit?.beat || ""} ${unit?.before || ""} ${unit?.after || ""} ${delivery}`;
  if (/心疼|安慰|照顾|扶起|戴上|保护/u.test(context)) return "上身微微前倾靠近对方，双手配合照护动作，视线始终确认对方状态";
  if (/痛心|绝望|妥协|哭|颤抖/u.test(context)) return "肩背下沉，手指失力，眼神短暂回避后重新看向听者";
  if (/怒|质问|逼|抢|制止|威胁|驱逐/u.test(context)) return "下颌绷紧，身体重心前压，手势在重音处落定但不遮挡听者反应";
  return index % 2 ? "肩膀先收紧再松开，视线短暂回避后回到听者脸上" : "身体保持稳定，手部动作跟随重音落点，目光锁定听者";
}

function semanticNarrativeIsPlaceholder(value) {
  const text = String(value || "").replace(/[\s。！？!?；;：:，,]/g, "");
  return /^(?:行动推进\d*|情节推进\d*|剧情推进\d*|推进事实\d*|关系改变|完成收束|结局收束|故事结束|人物完成动作|当前镜头推进一项新事实)$/u.test(text);
}

function semanticNarrativeLooksDangling(value) {
  const text = String(value || "").replace(/\s+/g, "").replace(/[，,；;：:]$/g, "");
  return /(?:并|以及|和|与|到|向|把|将|让|在|从|对|给|坐到|走到|放到|拿到|交到|回到)$/u.test(text);
}

function unresolvedFinalDialogue(value) {
  const text = String(value || "").replace(/\s+/g, "").replace(/[。！？!?…]+$/g, "");
  return /^(?:你)?(?:把话)?说清(?:楚)?|^(?:这|那)?到底(?:怎么回事|为什么)|^(?:怎么回事|为什么|凭什么)$/u.test(text);
}

function normalizeSemanticUnitForCompilation(unit, topic = {}, index = 1, totalUnitCount = 1) {
  const normalized = {
    ...unit,
    beat: completeNarrative(unit?.beat, "当前镜头推进一项新事实"),
    before: completeNarrative(unit?.before, "承接上一镜尚未解决的行动"),
    after: completeNarrative(unit?.after, "本镜形成新的可见关系状态"),
    cutAfter: completeNarrative(unit?.cutAfter, "末句后以可见动作落点切镜"),
    dialogueLines: sourceArray(unit?.dialogueLines).map(line => Array.isArray(line) ? [...line] : line)
  };
  const finalUnit = Number(index) === Number(totalUnitCount);
  const settlement = completeNarrative(topic?.settlementAction, "");
  const payoff = completeNarrative(topic?.emotionalPayoff, "");
  if (semanticNarrativeIsPlaceholder(normalized.beat) || semanticNarrativeLooksDangling(normalized.beat)) {
    normalized.beat = finalUnit
      ? settlement || payoff || "人物以可见行动兑现最终决定"
      : (!semanticNarrativeIsPlaceholder(normalized.cutAfter) && !semanticNarrativeLooksDangling(normalized.cutAfter)
          ? normalized.cutAfter
          : `${normalized.before}之后，人物完成新的可见行动`);
  }
  if (semanticNarrativeIsPlaceholder(normalized.after) || semanticNarrativeLooksDangling(normalized.after)) {
    normalized.after = finalUnit && (settlement || payoff)
      ? [settlement, payoff].filter(Boolean).join("；")
      : `${normalized.beat}之后，人物关系或证据形成可见的新状态`;
  }
  if (semanticNarrativeIsPlaceholder(normalized.cutAfter) || semanticNarrativeLooksDangling(normalized.cutAfter)) {
    normalized.cutAfter = `${finalUnit ? settlement || normalized.beat : normalized.beat}完成后，人物在可见结果上停留0.5秒切镜`;
  }
  if (!finalUnit) return normalized;
  // An isolated question at the final cut reopens the conflict and was the
  // source of unusable endings such as “你把话说清”。Do not buy another model
  // repair when review is disabled; keep the authored visible settlement and
  // make this one defective line silent instead.
  if (normalized.dialogueLines.length === 1 && unresolvedFinalDialogue(normalized.dialogueLines[0]?.[1]) && (settlement || payoff)) {
    normalized.dialogueLines = [];
  }
  return normalized;
}

function inferSemanticListenerNumber(line, unit, spine = {}, visibleNumbers = []) {
  const speaker = Number(line?.[0]);
  const supplied = Number(line?.[3]);
  const characterCount = sourceArray(spine?.c).length;
  if (Number.isInteger(supplied) && supplied >= 0 && supplied <= characterCount && supplied !== speaker) return supplied;
  const characters = sourceArray(spine?.c).map((character, index) => ({
    number: index + 1,
    name: String(character?.n || character?.name || "").trim()
  }));
  const mentionedIn = text => characters.filter(character => character.number !== speaker && character.name && String(text || "").includes(character.name));
  const directMentions = mentionedIn(`${line?.[2] || ""} ${line?.[1] || ""}`);
  if (directMentions.length === 1) return directMentions[0].number;
  const unitMentions = mentionedIn(`${unit?.beat || ""} ${unit?.before || ""} ${unit?.after || ""} ${unit?.cutAfter || ""}`);
  if (unitMentions.length === 1) return unitMentions[0].number;
  const otherVisible = sourceArray(visibleNumbers).map(Number).filter(value => Number.isInteger(value) && value !== speaker);
  return otherVisible.length === 1 ? otherVisible[0] : 0;
}

// The semantic schedule is the creative source of truth: it contains the
// locked dialogue, state transitions and cut point.  Re-asking an LLM to emit
// those exact facts with five extra performance fields is not creative work;
// it is a lossy serialization step that can be truncated and can contradict
// the lock.  Compile that deterministic envelope locally instead.
function buildDirectFastSemanticSegment({ spine = {}, topic = {}, segmentStart = 1, segmentEnd = 1, unitDurations = [], productStartNumber = 0, semanticUnits = [] } = {}) {
  const base = buildDirectFastFallbackSegment({
    spine,
    topic,
    segmentStart,
    segmentEnd,
    unitDurations,
    productStartNumber
  });
  const totalUnitCount = Math.max(1, sourceArray(unitDurations).length, Number(segmentEnd) || 1);
  const units = new Map(sourceArray(semanticUnits).map(unit => {
    const number = Number(unit?.i);
    return [number, normalizeSemanticUnitForCompilation(unit, topic, number, totalUnitCount)];
  }));
  return {
    ...base,
    s: base.s.map(shot => {
      const unit = units.get(Number(shot.i));
      if (!unit) return shot;
      const explicitVisible = sourceArray(unit.visibleCharacterNumbers)
        .map(Number)
        .filter(id => Number.isInteger(id) && id >= 1 && id <= sourceArray(spine?.c).length);
      const lockedDialogue = sourceArray(unit.dialogueLines)
        .filter(line => Array.isArray(line) && Number.isInteger(Number(line[0])) && String(line[1] || "").trim())
        .map((line, index) => {
          const authoredDelivery = String(line[2] || "").trim();
          const genericDelivery = !authoredDelivery || /^(?:自然说|自然表达|语气贴合当前冲突|按当前情绪表达)/u.test(authoredDelivery);
          return [
            Number(line[0]),
            String(line[1]).trim(),
            genericDelivery ? semanticDeliveryForLine(unit, line[1], index) : authoredDelivery,
            inferSemanticListenerNumber(line, unit, spine, explicitVisible),
            Number(line[4]) > 0 ? Number(line[4]) : 0,
            Number(line[5]) >= 0 ? Number(line[5]) : 0
          ];
        });
      const speakingIds = [...new Set(lockedDialogue.map(line => line[0]))];
      const semanticContext = `${unit?.beat || ""} ${unit?.before || ""} ${unit?.after || ""} ${unit?.cutAfter || ""}`;
      const mentionedVisible = sourceArray(spine?.c)
        .map((character, index) => ({ id: index + 1, name: String(character?.n || character?.name || "").trim() }))
        .filter(item => item.name && semanticContext.includes(item.name))
        .map(item => item.id);
      // The raw direct contract always retains a camera/focus owner, including
      // a silent product unit. The later materializer is the authoritative
      // place that removes people from a clean packshot; emptying `v` here
      // would make the otherwise valid semantic segment impossible to compile.
      const visible = [...new Set([
        ...speakingIds,
        ...(explicitVisible.length ? explicitVisible : mentionedVisible.length ? mentionedVisible : sourceArray(shot.v).map(Number).filter(Number.isInteger))
      ])];
      const focus = visible[0] || Number(shot.f) || 1;
      return {
        ...shot,
        t: compact(unit.beat, shot.t, 80),
        a: completeNarrative(`${unit.beat || "推进事实"}；${unit.cutAfter || "人物完成动作并形成反应"}`, shot.a),
        bf: completeNarrative(unit.before, shot.bf),
        af: completeNarrative(unit.after, shot.af),
        em: `克制→${compact(unit.beat, "事实推进", 28)}→${compact(unit.after, "关系改变", 28)}→余震`,
        f: focus,
        v: visible,
        d: lockedDialogue.map(([speaker, text, delivery, listenerNumber, plannedSpeechSeconds, plannedAfterBeatSeconds], index) => [
          speaker,
          text,
          delivery,
          semanticBodyForLine(unit, delivery, index),
          index === lockedDialogue.length - 1 ? "听者先停住动作，再给出可见反应" : "前一位说话人闭口等待回应",
          listenerNumber,
          plannedSpeechSeconds,
          plannedAfterBeatSeconds
        ]),
        visualReserveSeconds: Number(unit.visualReserveSeconds) >= 0 ? Number(unit.visualReserveSeconds) : 0,
        durationRationale: compact(unit.durationRationale, "AI已按对白表演、动作和运镜共同分配本镜时长", 160)
      };
    })
  };
}

function materializeCharacters(payload, topic) {
  const authored = sourceArray(payload?.c).slice(0, 5);
  const fallbacks = characterFallbacks(topic);
  const merged = [...authored];
  while (merged.length < 3) merged.push(fallbacks[merged.length]);
  return merged.slice(0, 5).map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    const fallback = fallbacks[index] || fallbacks.at(-1);
    const name = compact(source.n || source.name, fallback.n, 12);
    const gender = compact(source.g || source.gender || source.sex, fallback.g || "", 8);
    const age = compact(source.a || source.age, fallback.a, 12);
    const role = compact(source.r || source.role, fallback.r, 40);
    const description = compact(source.d || source.description, fallback.d, 70);
    const digest = crypto.createHash("sha256").update(`${name}|${age}|${role}`).digest("hex");
    return {
      id: `C${String(index + 1).padStart(2, "0")}`,
      name,
      gender,
      age,
      role,
      description,
      identitySignature: `${description}；脸部固定识别码${digest.slice(0, 6)}`,
      desire: index === 0 ? "让家人过得体面并守住尊严" : index === 1 ? "弄清真相并弥补旧伤" : "把亲眼见证的事实说清楚",
      fear: index === 0 ? "自己的牺牲拖累家人" : index === 1 ? "发现自己曾伤害最亲的人" : "真话说晚后再也来不及",
      arc: index === 0 ? "从隐忍承担到被行动看见" : index === 1 ? "从误判伤人到承担现实代价并行动修复" : "从旁观到公开作证",
      voiceDescription: inferredVoiceDescription({ n: name, g: gender, a: age, r: role, d: description }, index),
      signatureLine: ["今天这件事必须当面说清楚。", "我不再躲了，错在哪里我就补在哪里。", "我亲眼看见的事，今天一句都不会少。", "先把真话摆出来，再谈谁该留下。", "事情到这一步，谁都不能再装糊涂。"][index] || "今天必须把真话说清楚。",
      continuityLocks: [`姓名年龄与脸部识别码${digest.slice(0, 6)}固定`, "发型、体态和声线在同一时间段不得漂移"]
    };
  });
}

function materializeScenes(payload, totalSeconds = 300, unitCount = 30) {
  const authoredByName = new Map();
  for (const item of sourceArray(payload?.sc)) {
    const source = item && typeof item === "object" ? item : {};
    const name = compact(source.n || source.name, "", 18);
    if (name && !authoredByName.has(name)) authoredByName.set(name, source);
  }
  const authored = [...authoredByName.values()];
  const density = storyDensityTargets(totalSeconds, unitCount);
  const targetCount = Math.max(density.sceneMin, Math.min(density.sceneMax, authored.length || density.sceneMin));
  const fallbacks = [
    { n: "主要冲突场所", d: "空间入口、人物关系位和关键动作区清楚，承担伤害钩子与第一次对抗" },
    { n: "事实揭示场所", d: "人物正反打位、关键物件区和行动通道固定，承担事实递进与主反转" },
    { n: "行动回收场所", d: "人物关系位、商品使用区和离场通道固定，承担行动补偿与结局回收" }
  ];
  const merged = [...authored];
  while (merged.length < targetCount) {
    const index = merged.length;
    const base = fallbacks[index % fallbacks.length];
    const chapter = Math.floor(index / fallbacks.length) + 1;
    merged.push({
      n: chapter === 1 ? base.n : `${base.n}·阶段${chapter}`,
      d: `${base.d}；承担第${index + 1}个独立剧情任务并产生新的因果结果`
    });
  }
  return merged.slice(0, targetCount).map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    const fallback = fallbacks[index] || fallbacks.at(-1);
    const name = compact(source.n || source.name, fallback.n, 18);
    const description = compact(source.d || source.description, fallback.d, 90);
    return {
      id: `SC${String(index + 1).padStart(2, "0")}`,
      name,
      interiorExterior: "内景",
      time: index === 0 ? "夜间" : index === 1 ? "日间" : "午后",
      description,
      lighting: index === 0 ? "暖黄侧光与窗外冷光对比" : "自然散射光，物证区域更亮",
      atmosphere: index === 0 ? "室内环境底噪、缝纫机与衣料摩擦" : "室内环境底噪、脚步与纸张动作声",
      scenePurpose: description,
      entryAction: "人物带着上一场未解决的动作或物件进入",
      exitAction: "完成本场不可逆行动后离开画面",
      cameraAnchors: ["门口关系位", "工作台侧向位", "人物正反打位"],
      transitionReason: "由上一场动作、物件或声音桥自然切入"
    };
  });
}

function stageFor(index, unitCount) {
  if (unitCount === 30) return STAGES[index];
  const reversal = directFastReversalIndex(unitCount);
  if (index === reversal) return "main_reversal";
  if (index === 0) return "hook";
  const costlyTarget = Math.max(1, Math.round(unitCount / 15));
  const costlyStep = Math.max(3, Math.floor(reversal / (costlyTarget + 1)));
  if (index < reversal && index % costlyStep === 0) return "cost_kindness";
  if (index < Math.round(unitCount * 0.5)) return "pressure";
  if (index < reversal) return "evidence";
  return index === unitCount - 1 ? "ending" : "payoff";
}

function directFastReversalIndex(unitCount) {
  const count = Math.max(1, Math.floor(Number(unitCount) || 1));
  return count <= 2
    ? Math.max(0, count - 1)
    : Math.min(count - 2, Math.max(1, Math.round(count * 0.72 - 0.5)));
}

function directFastProductStartIndex(unitCount) {
  const count = Math.max(1, Math.floor(Number(unitCount) || 1));
  return Math.max(0, Math.min(count - 1, Math.max(
    count - Math.min(3, count),
    directFastReversalIndex(count) + 1,
    Math.floor(count * 0.65) + 1
  )));
}

function sceneFor(index, unitCount, scenes, payload = {}) {
  const shotNumber = index + 1;
  const beat = sourceArray(payload?.b).find(item => Number(item?.a) <= shotNumber && Number(item?.z) >= shotNumber);
  const authoredScene = Number(beat?.sc);
  if (authoredScene >= 1 && authoredScene <= scenes.length) return scenes[authoredScene - 1];
  const bucket = Math.min(scenes.length - 1, Math.floor(index / Math.ceil(unitCount / scenes.length)));
  return scenes[bucket] || scenes.at(-1);
}

function mapCompactShot(payload, index) {
  const source = sourceArray(payload?.s).find(item => Number(item?.i) === index + 1) || sourceArray(payload?.s)[index] || {};
  return source && typeof source === "object" ? source : {};
}

function deliveryFor(emotion, index) {
  const high = /怒|崩|惊|慌|痛|悔|羞|绝望|决绝/.test(emotion);
  return `${compact(emotion, "克制→受刺激→情绪抬升→压住余震", 45)}；${high ? "中高音量" : "中低音量"}；${index % 3 === 0 ? "先慢后快" : "语速中等"}；重咬动作词；句尾留半拍气口`;
}

function productCategoryProfile(product = {}) {
  const name = compact(product.name, "用户商品", 32);
  const facts = `${name} ${product.description || ""} ${product.sellingPoints || ""}`;
  if (/书|读物|图册|绘本|教材|手册|指南|小说|诗集|文集/.test(facts)) {
    return {
      need: characterName => `${characterName}需要从已有文字资料里确认与当前处境直接相关的信息`,
      action: characterName => `${characterName}拿起${name}，翻到已标记的一页并逐行核对其中内容`,
      outcome: "书页、标记和人物随后执行的整理动作都清晰可见；只呈现阅读与信息核对，不虚构书中结论",
      decision: characterName => `${characterName}决定保留这本书，并按读到的真实信息整理下一步行动`
    };
  }
  if (/茶|咖啡|饮料|饮品|水|奶|果汁|酒|食品|零食|饼|糕|粉|粥|汤|米|面|油|酱|糖|坚果/.test(facts)) {
    return {
      need: characterName => `${characterName}在连续处理事情的间隙需要按包装真实信息取用日常食品或饮品`,
      action: characterName => `${characterName}查看${name}包装后按正常方式打开、倒出或取用`,
      outcome: "包装状态、实际取用和人物继续行动都清晰可见；不虚构口感、营养或健康功效",
      decision: characterName => `${characterName}决定把${name}按真实用途留在日常安排里`
    };
  }
  if (/衣|裤|裙|鞋|袜|帽|围巾|手套|眼镜|首饰|项链|手链|包|箱/.test(facts)) {
    return {
      need: characterName => `${characterName}需要为接下来的真实场合整理合适的随身或穿戴物品`,
      action: characterName => `${characterName}检查${name}的外观与细节，并按品类正常穿戴、携带或收纳`,
      outcome: "穿戴或携带前后的状态变化清晰可见；不虚构材质、尺码或性能",
      decision: characterName => `${characterName}决定在接下来的行动中继续使用或携带${name}`
    };
  }
  if (/护膝|护腰|护腕|护踝|支撑|绑带|垫|枕|坐垫/.test(facts)) {
    return {
      need: characterName => `${characterName}在长时间完成日常动作前需要按商品真实用途做好支撑准备`,
      action: characterName => `${characterName}坐下整理${name}，按对应身体部位与商品结构自然佩戴`,
      outcome: "佩戴、弯曲、起身与走动过程清晰可见；只呈现日常使用体验，不作治疗承诺",
      decision: characterName => `${characterName}决定在需要完成同类日常动作时按真实用途使用${name}`
    };
  }
  if (/锅|杯|壶|刀|剪|灯|机|器|刷|清洁|收纳|桌|椅|床|柜|家居|工具/.test(facts)) {
    return {
      need: characterName => `${characterName}需要用合适的日常工具完成眼前具体任务`,
      action: characterName => `${characterName}检查${name}后，按其真实品类完成一次可见操作`,
      outcome: "操作步骤、商品状态和任务结果清晰可见；不虚构规格、效率或耐用性",
      decision: characterName => `${characterName}决定把${name}用于之后同类日常任务`
    };
  }
  return {
    need: characterName => `${characterName}需要用用户提供的${name}完成眼前具体任务`,
    action: characterName => `${characterName}先核对${name}的外观与真实信息，再按该品类常规方式使用`,
    outcome: "商品、实际操作和操作后的可见状态都清晰呈现；不补写用户未提供的功能、规格或承诺",
    decision: characterName => `${characterName}根据实际使用结果决定在后续行动中保留${name}`
  };
}

function resolveProductProfileText(value, characterName) {
  return typeof value === "function" ? value(characterName) : String(value || "");
}

function productBridge(product, character, index) {
  const profile = productCategoryProfile(product);
  const role = index % 3;
  return {
    situationNeed: resolveProductProfileText(profile.need, character.name),
    whyNow: role === 0 ? "新的具体任务马上开始，人物主动按真实需求做准备" : "上一镜已经完成真实操作，需要观察结果并作出决定",
    action: resolveProductProfileText(profile.action, character.name),
    observableOutcome: resolveProductProfileText(profile.outcome, character.name),
    relationOrDecisionShift: `${character.id}${resolveProductProfileText(profile.decision, character.name)}`
  };
}

function materializeDirectFastScript({ payload, topic, product, filmSchedule }) {
  const unitCount = Math.max(1, Number(filmSchedule.unitCount) || 30);
  const totalSeconds = Math.max(5, Number(filmSchedule.totalSeconds) || 300);
  const characters = materializeCharacters(payload, topic);
  const scenes = materializeScenes(payload, totalSeconds, unitCount);
  const reversalIndex = directFastReversalIndex(unitCount);
  const productStartIndex = directFastProductStartIndex(unitCount);
  const plans = [];
  const rawShots = [];

  for (let index = 0; index < unitCount; index += 1) {
    const source = mapCompactShot(payload, index);
    const id = `S${String(index + 1).padStart(2, "0")}`;
    const stage = index === reversalIndex ? "main_reversal" : stageFor(index, unitCount);
    const duration = Number(filmSchedule.suggestedDurations?.[index]) || Math.round(totalSeconds / unitCount);
    const scene = sceneFor(index, unitCount, scenes, payload);
    const authoredFocus = Math.max(1, Math.min(characters.length, Number(source.f) || ((index % characters.length) + 1)));
    const authoredVisible = sourceArray(source.v).map(Number).filter(Number.isFinite).map(value => Math.max(1, Math.min(characters.length, value)));
    const authoredSpeakers = sourceArray(source.d).map(item => Number(Array.isArray(item) ? item[0] : item?.s)).filter(Number.isFinite)
      .map(value => Math.max(1, Math.min(characters.length, value)));
    const authoredListeners = sourceArray(source.d).map(item => Number(Array.isArray(item) ? item[5] : item?.listenerNumber))
      .filter(value => Number.isInteger(value) && value >= 1 && value <= characters.length);
    const visibleIndexes = [...new Set([...authoredSpeakers, ...(authoredVisible.length ? authoredVisible : [authoredFocus, ...authoredListeners])])];
    const productMention = index >= productStartIndex && index < productStartIndex + 3;
    // Product placement is part of a character's causal action.  A fixed
    // personless packshot previously replaced the only ending shot in a
    // 30-second story.  Every product shot now keeps actors; the final one is
    // always the observable result and narrative decision.
    const productRole = productMention ? (index === unitCount - 1 ? "product_result" : "product_use") : "none";
    const productIntroduction = productRole === "product_use" && index === productStartIndex;
    const visibleCharacterIds = visibleIndexes.map(value => characters[value - 1]?.id).filter(Boolean);
    const focus = characters[authoredFocus - 1] || characters[0];
    const authoredDialogue = sourceArray(source.d);
    const authoredSpeakerCount = new Set(authoredSpeakers).size;
    const intendedSolo = authoredDialogue.length ? authoredSpeakerCount <= 1 : visibleIndexes.length <= 1;
    // New spine-based responses are validated against the exact per-shot
    // duration and arrive ready to perform. Legacy payloads are still fitted
    // locally so old paused tasks remain resumable without rewriting them.
    let dialogueSource = payload?.spineLocked === true
      ? authoredDialogue.map(item => Array.isArray(item) ? item : [item?.s, item?.x || item?.text, item?.delivery, item?.body, item?.listenerBeat, item?.listenerNumber, item?.plannedSpeechSeconds, item?.plannedAfterBeatSeconds])
        .map(([speaker, text, delivery, body, listenerBeat, listenerNumber, plannedSpeechSeconds, plannedAfterBeatSeconds]) => ({
          speaker: Math.max(1, Number(speaker) || 1),
          text: authoredSpeech(text),
          delivery: compact(delivery, "按当前冲突自然起伏", 120),
          body: compact(body, "面部和手部随台词发生可见变化", 120),
          listenerBeat: compact(listenerBeat, "听者闭口并给出可见反应", 120),
          listenerNumber: Number.isInteger(Number(listenerNumber)) ? Number(listenerNumber) : 0,
          plannedSpeechSeconds: Number(plannedSpeechSeconds) > 0 ? Number(plannedSpeechSeconds) : 0,
          plannedAfterBeatSeconds: Number(plannedAfterBeatSeconds) >= 0 ? Number(plannedAfterBeatSeconds) : 0
        }))
        .filter(item => spokenLength(item.text) >= 2)
      : fitDialogueLines(authoredDialogue, index === 0, duration, { solo: intendedSolo, productPackshot: productRole === "product_packshot" });
    if (index === 0 && dialogueSource.length && payload?.spineLocked !== true) {
      dialogueSource[0].text = openingSentenceFromSource(dialogueSource[0].text);
    }
    const bridge = productMention ? productBridge(product, focus, index) : { situationNeed: "", whyNow: "", action: "", observableOutcome: "", relationOrDecisionShift: "" };
    const authoredNarrativeAction = completeNarrative(source.a || source.action, `${focus.name}完成第${index + 1}个不可逆动作，现场关系随之改变`);
    const dialogueVisibleIds = visibleCharacterIds;
    const action = index === 0
      ? completeNarrative(source.a || source.action || topic.hook, "对方踢开跪地劳作的人，婚纱裙摆从手中滑落")
      : productRole === "product_result"
          ? completeNarrative(`${authoredNarrativeAction}；${bridge.observableOutcome}`, authoredNarrativeAction)
          : productMention
            ? completeNarrative(`${bridge.action}；${authoredNarrativeAction}`, authoredNarrativeAction)
            : authoredNarrativeAction;
    // Preserve model-authored English mirrors when a provider supplies them.
    // They are deliberately not synthesized from Chinese here: the final
    // compiler must receive the authored execution semantics, while legacy
    // payloads remain compatible through its existing deterministic fallback.
    const actionEn = compact(source.actionEn || source.visualBeatEn, "", 180);
    const framingEn = compact(source.framingEn || source.shotSizeEn, "", 80);
    const cameraEn = compact(source.cameraEn || source.cameraMoveEn, "", 100);
    const stateBeforeEn = compact(source.stateBeforeEn, "", 100);
    const stateAfterEn = compact(source.stateAfterEn, "", 100);
    const soundEn = compact(source.soundEn || source.audioPlanEn || source.soundDesignEn, "", 140);
    const before = completeNarrative(source.bf, `上一镜结果压到${focus.name}面前`);
    const after = completeNarrative(source.af, `${focus.name}用可见动作把关系推进到无法退回的状态`);
    const emotion = compact(source.em, stage === "main_reversal" ? "压抑→看清证据→崩溃→决定承担" : "克制→受刺激→情绪抬升→压住余震", 65);
    let dialogueTurns = dialogueSource.map((turn, turnIndex) => {
      const speaker = characters[Math.max(0, Math.min(characters.length - 1, turn.speaker - 1))] || focus;
      const explicitListener = Number(turn.listenerNumber) >= 1 && Number(turn.listenerNumber) <= characters.length
        ? characters[Number(turn.listenerNumber) - 1]
        : null;
      const listener = explicitListener && explicitListener.id !== speaker.id
        ? explicitListener
        : dialogueVisibleIds.map(characterId => characters.find(item => item.id === characterId)).find(item => item && item.id !== speaker.id) || null;
      const listenerBeat = listener
        ? String(turn.listenerBeat || "").includes(listener.name)
          ? turn.listenerBeat
          : `${listener.name}${dialogueVisibleIds.includes(listener.id) ? "闭口听完" : "在画外轴线方向听完"}，眼神、呼吸和手部出现与本句含义一致的可见反应`
        : (turn.listenerBeat || "画外听者屏住呼吸，下一镜承接其反应");
      return {
        speakerId: speaker.id,
        listenerIds: listener ? [listener.id] : [],
        text: turn.text,
        beat: ["attack", "deflect", "counter", "reveal", "counter", "decision"][turnIndex % 6],
        delivery: turn.delivery || deliveryFor(emotion, turnIndex),
        body: turn.body || `${speaker.name}第${turnIndex + 1}句时${turnIndex < 2 ? "手指收紧并稳住重心" : turnIndex < 4 ? "下颌绷住、身体向前半步" : "呼吸停半拍后完成决定动作"}`,
        listenerBeat,
        subshotNumber: 1,
        onScreen: dialogueVisibleIds.includes(speaker.id),
        plannedSpeechSeconds: Number(turn.plannedSpeechSeconds) > 0 ? Number(turn.plannedSpeechSeconds) : 0,
        plannedAfterBeatSeconds: Number(turn.plannedAfterBeatSeconds) >= 0 ? Number(turn.plannedAfterBeatSeconds) : 0
      };
    });
    const visualReserveSeconds = Number(source.visualReserveSeconds) >= 0 ? Number(source.visualReserveSeconds) : 0;
    const atomicSubshotPlan = planAtomicDialogueSubshots(duration, dialogueTurns, { visualReserveSeconds });
    dialogueTurns = atomicSubshotPlan.turns;
    let productionSubshotUnits = atomicSubshotPlan.units.map(unit => ({ ...unit }));
    if (productIntroduction) {
      // One short, silent product camera phase establishes the whole pack and
      // its key detail before the complete dialogue starts. It remains in the
      // first speaker-owned provider block, so this visual requirement creates
      // no extra paid request and never fragments a spoken sentence.
      const preludeEnd = Math.min(2, Math.max(1, duration * 0.18));
      const remaining = Math.max(0.001, duration - preludeEnd);
      productionSubshotUnits = [
        { number: 1, start: 0, end: Number(preludeEnd.toFixed(3)), speakerKey: "", onScreen: false, turnIndexes: [] },
        ...atomicSubshotPlan.units.map((unit, unitIndex) => ({
          ...unit,
          number: unitIndex + 2,
          start: Number((preludeEnd + remaining * unit.start / duration).toFixed(3)),
          end: Number((preludeEnd + remaining * unit.end / duration).toFixed(3))
        }))
      ];
      productionSubshotUnits.at(-1).end = duration;
      dialogueTurns = dialogueTurns.map(turn => ({ ...turn, subshotNumber: Number(turn.subshotNumber || 1) + 1 }));
    }
    const planVisibleIds = visibleCharacterIds;
    const openingSpeakerId = dialogueTurns[0]?.speakerId || planVisibleIds[0] || "";
    const counterpart = characters.find(item => planVisibleIds.includes(item.id) && item.id !== openingSpeakerId) || null;
    const dialogueSpeakerIds = [...new Set(dialogueTurns.map(turn => turn.speakerId).filter(Boolean))];
    const dialogueIsSolo = dialogueSpeakerIds.length <= 1;
    const visualBeat = `${id}独占动作：${action}`;
    const mainlineBeat = stage === "main_reversal"
      ? `主反转：${compact(topic.reversal, action, 70)}`
      : stage === "evidence"
        ? `证据递进：${compact(topic.proofChain, action, 70)}`
        : stage === "cost_kindness"
          ? `有成本善意：${action}`
          : stage === "payoff"
            ? `行动兑现：${action}`
            : action;
    const plan = {
      id,
      title: compact(source.t || source.title, `${stage}·${index + 1}`, 28),
      duration,
      characters: planVisibleIds.map(characterId => characters.find(item => item.id === characterId)?.name).filter(Boolean),
      scenePresenceCharacterIds: planVisibleIds,
      visibleCharacterIds: planVisibleIds,
      focusCharacterId: openingSpeakerId || planVisibleIds[0] || "",
      counterpartCharacterId: counterpart?.id || "",
      cameraOwnerId: openingSpeakerId || planVisibleIds[0] || "",
      mouthOwnerId: openingSpeakerId,
      shotFunction: productMention ? productRole : (planVisibleIds.length > 1 ? "two_shot" : "speaker_closeup"),
      scene: scene.name,
      sceneObjective: mainlineBeat,
      transitionReason: index === 0 ? "冷开场直接砸入危机" : "承接上一镜末句、视线与手部动作",
      mainlineStage: stage,
      mainlineBeat,
      kindnessCost: stage === "cost_kindness" ? `${focus.name}为保护家人失去时间、尊严或现实机会` : "无",
      reversalSetup: stage === "evidence" ? compact(topic.proofChain, "可见物证进入画面", 70) : "无",
      action,
      actionEn,
      stateBefore: before,
      stateAfter: after,
      stateBeforeEn,
      stateAfterEn,
      causalLink: index === 0 ? "伤害动作发生，所以首句制止立刻引爆母女冲突" : `因为S${String(index).padStart(2, "0")}留下未解决的动作和事实，所以${action}导致${after}`,
      visualBeat,
      compositionPlan: dialogueIsSolo
        ? `${index % 3 === 0 ? "说话人单人近景" : index % 3 === 1 ? "说话人中近景缓推" : "侧向说话人近景"}；说话人看听者而非镜头`
        : "双人对白按dialogueTurns时间顺序执行说话人近景↔听者反打；换speakerId即硬切机位并切换唯一嘴型，保持180度轴线",
      audioPlan: `0-${duration}秒连续室内环境底噪；对白清晰；脚步、衣料摩擦、纸张或器物动作特效声同步；只保留现场声`,
      framingEn,
      cameraEn,
      soundEn,
      dialogueGoal: `${dialogueUnitPrompt(duration, { solo: dialogueIsSolo, productPackshot: productRole === "product_packshot" })}；按轮次完成攻防，只新增一条关键信息并由末句或末动作触发可见后果`,
      visualReserveSeconds,
      durationRationale: completeNarrative(source.durationRationale, "本镜时长由对白完整表演、听者反应、运镜和动作落点共同决定"),
      dialogueArc: {
        entryCause: before,
        speakerGoalA: `${focus.name}逼对方正面回应刚发生的事实`,
        speakerGoalB: counterpart ? `${counterpart.name}试图守住原判断或现实利益` : "本镜为单人短锤，画外听者或相邻反应镜承接",
        newInformation: mainlineBeat,
        exitConsequence: after
      },
      emotion,
      emotionArc: { start: emotion.split("→")[0] || "克制", trigger: action, peak: emotion.split("→")[2] || "情绪抬升", aftershock: emotion.split("→").at(-1) || "余震" },
      performanceBeats: { faceAction: "眉眼、下颌和泪线随台词逐句变化", bodyAction: "手部、肩颈和重心在末句完成状态改变", voiceDelivery: deliveryFor(emotion, index), listenerReaction: counterpart ? `${counterpart.name}逐句出现眼神、呼吸和手部反应` : "听者反应由画外呼吸与下一镜承接" },
      startFrame: `${scene.name}中${focus.name}保持${before}的姿态，视线落向听者`,
      endFrame: `${focus.name}完成${after}的动作后仍有呼吸、手指或泪线微动`,
      tragedy: null,
      faceSlap: stage === "main_reversal" ? { attack: "旧判断被公开", proof: compact(topic.proofChain, "物证落桌", 70), reaction: "过错方失语并失去退路", action: "主角完成现实清算" } : null,
      silenceBeat: null,
      motifRecall: compact(topic.themeObject, "核心物件", 45),
      storyCoreRefs: ["valueStatement", "protagonistWound", "themeObject"],
      reversalRole: stage === "main_reversal" ? "唯一主反转并完成证据重释" : stage === "evidence" ? "推进可见证明链" : "为唯一主反转积累关系和行动代价",
      imageReferenceCharacterIds: planVisibleIds,
      videoReferenceCharacterIds: planVisibleIds,
      offscreenSpeakerIds: [...new Set(dialogueTurns.filter(turn => turn.onScreen === false).map(turn => turn.speakerId))],
      wardrobeBindings: planVisibleIds.map(characterId => ({ characterId, wardrobeId: `wardrobe_${characterId}`, continuity: "同一时段服装、发型与配饰不变" })),
      propBindings: [],
      productMention,
      productShotType: productMention ? productRole : "none",
      productCausalBridge: bridge,
      subshotTarget: productionSubshotUnits.length
    };

    const subshotRoles = productionSubshotUnits.map((unit, unitIndex) => {
      if (productIntroduction && unitIndex === 0) return "product_packshot product_detail";
      if (productRole === "product_packshot") return "product_packshot";
      if (productRole === "product_use" || productIntroduction) return "product_use";
      if (productRole === "product_result") return unitIndex === productionSubshotUnits.length - 1 ? "product_result" : "product_reaction";
      if (productMention) return unitIndex === productionSubshotUnits.length - 1 ? "product_result" : "product_use";
      return dialogueIsSolo ? "speaker_hold" : "dialogue_exchange";
    });
    const boundaries = productionSubshotUnits.map(unit => [unit.start, unit.end]);
    const subshots = boundaries.map(([start, end], subIndex) => {
      const role = subshotRoles[subIndex];
      const cleanProduct = false; // Every commerce beat retains its named in-story performer.
      const turns = dialogueTurns.filter(turn => turn.subshotNumber === subIndex + 1);
      const firstTurn = turns[0] || null;
      const segmentSpeakerIds = [...new Set(turns.map(turn => turn.speakerId).filter(Boolean))];
      const segmentOffscreenSpeakerIds = [...new Set(turns.filter(turn => turn.onScreen === false).map(turn => turn.speakerId).filter(Boolean))];
      const segmentListenerIds = [...new Set(turns.flatMap(turn => turn.listenerIds || []).filter(Boolean))];
      const cameraOwnerId = cleanProduct
        ? ""
        : firstTurn?.onScreen !== false && firstTurn?.speakerId
          ? firstTurn.speakerId
          : (segmentListenerIds[0] || plan.cameraOwnerId || focus.id);
      const mouthOwnerId = cleanProduct || !firstTurn || firstTurn.onScreen === false ? "" : firstTurn.speakerId;
      const cameraOwner = characters.find(item => item.id === cameraOwnerId) || focus;
      return {
        start,
        end,
        shotType: role,
        cutReason: subIndex === 0 ? plan.transitionReason : dialogueIsSolo ? "同一说话人表演递进" : "台词与视线接力，按speakerId时间点硬切正反打",
        framing: cleanProduct ? "剧情人物持物中近景" : dialogueIsSolo ? (subIndex === 0 ? "说话人中近景" : subIndex === 1 ? "同一说话人缓推近景" : "同一说话人余震近景") : "当前说话人近景；轮次变化时切回应者反打",
        camera: cleanProduct ? "稳定商品机位" : dialogueIsSolo ? (subIndex === 1 ? "同一机位轻微推进" : subIndex === 2 ? "同一机位停止并保持" : "稳定机位开始缓推") : "保持180度轴线；speakerId变化处使用无转场硬切",
        action: cleanProduct ? `${product.name}整体与用户图片中可见的真实外观细节在干净承载面上清晰呈现` : `${action}；第${subIndex + 1}段完成可见状态变化`,
        actionEn,
        framingEn,
        cameraEn,
        stateBeforeEn: subIndex === 0 ? stateBeforeEn : "",
        stateAfterEn: subIndex === boundaries.length - 1 ? stateAfterEn : "",
        dialogueTurns: turns,
        sound: `连续室内环境底噪；${subIndex === 0 ? "衣料摩擦" : subIndex === 1 ? "脚步与急促呼吸" : "纸张或器物轻响"}动作特效声`,
        soundEn,
        transition: subIndex === boundaries.length - 1 ? "以末句和动作结果桥接下一镜" : "台词与视线接力",
        visibleCharacterIds: cleanProduct ? [] : planVisibleIds,
        cameraOwnerId,
        mouthOwnerId,
        speakerIds: cleanProduct ? [] : segmentSpeakerIds,
        offscreenSpeakerIds: cleanProduct ? [] : segmentOffscreenSpeakerIds,
        listenerIds: cleanProduct ? [] : segmentListenerIds,
        speakerFacing: cleanProduct ? "无人脸" : `${cameraOwner.name}朝向听者眼睛`,
        listenerFacing: counterpart ? `${counterpart.name}看向当前说话人` : "听者位于画外轴线方向",
        eyelineDirection: "保持180度轴线，禁止对镜头念词",
        emotionBeat: subIndex === 0 ? "情绪起始" : subIndex === boundaries.length - 1 ? "余震和决定" : "触发与峰值",
        faceAction: cleanProduct ? "无人脸" : "眉心、眼睑、下颌与泪线出现递进变化",
        bodyAction: cleanProduct ? "商品保持稳定、结构清晰" : "手指、肩颈与身体重心完成递进动作",
        voiceDelivery: deliveryFor(emotion, subIndex)
      };
    });
    const rawShot = {
      id,
      title: plan.title,
      duration,
      action,
      actionEn,
      stateBefore: before,
      stateAfter: after,
      stateBeforeEn,
      stateAfterEn,
      causalLink: plan.causalLink,
      visualBeat,
      compositionPlan: plan.compositionPlan,
      audioPlan: plan.audioPlan,
      framingEn,
      cameraEn,
      soundEn,
      dialogueArc: plan.dialogueArc,
      dialogueTurns,
      cameraOwnerId: plan.cameraOwnerId,
      mouthOwnerId: plan.mouthOwnerId,
      criticalOnScreenText: [],
      emotion,
      emotionArc: plan.emotionArc,
      performanceBeats: plan.performanceBeats,
      performance: `${focus.name}先以${plan.emotionArc.start}压住表情，受动作刺激后眉眼与下颌改变，末句时手部和重心完成决定`,
      soundDesign: `连续室内环境底噪、清晰对白与同步动作特效声，只保留现场声`,
      soundCueSheet: { bed: `0-${duration}秒连续室内环境底噪`, sfx: "衣料摩擦、脚步、呼吸与器物动作特效声", silenceDesign: "非静默单元", motifRecall: compact(topic.themeObject, "核心物件声音母题", 45) },
      transitionIn: plan.transitionReason,
      transitionOut: "以末句、视线或手部动作桥接下一镜",
      startFrame: plan.startFrame,
      endFrame: plan.endFrame,
      subshots,
      productMention,
      productCausalBridge: bridge
    };
    // Blueprint review and the final shot compiler must inspect the same
    // authored insert roles.  Keeping subshots only on rawShots made the
    // blueprint think a valid one-second product detail insert was missing.
    plan.subshots = subshots;
    plans.push(plan);
    rawShots.push(rawShot);
  }

  const highlights = sourceArray(topic.highlights).map(item => compact(item, "", 70)).filter(Boolean);
  const storyBible = {
    title: compact(topic.title, "看见她的付出", 24),
    logline: compact(topic.logline, "一段被误解的亲情在可见证据和行动中完成清算与回收。", 140),
    storyMechanism: compact(topic.storyMechanism, "sacrifice_repaid", 24),
    storyCore: {
      storyMechanism: compact(topic.storyMechanism, "sacrifice_repaid", 24),
      valueStatement: compact(topic.valueStatement, "真正的亲情要靠看见和行动回报，而不是口头原谅。", 90),
      protagonistWound: compact(topic.protagonistWound, "长期被轻视后习惯隐忍承担。", 80),
      falseBelief: compact(topic.falseBelief, "只要自己牺牲就能换来家人体面。", 80),
      wantVsNeed: "人物想维持表面体面，真正需要的是看见牺牲、承担后果并改变生活方式",
      antagonistLogic: "误解者用体面和现实利益为伤害辩护，直到证据让其失去退路",
      moralDilemma: "继续隐忍保住表面和睦，还是公开真相让关系承担现实代价",
      irreversibleChoice: "主角把证据和决定公开，拒绝再用沉默替伤害者兜底",
      themeObject: compact(topic.themeObject, "承载牺牲与证据的旧物", 80),
      audienceFeeling: compact(topic.audienceAppeal, "先心疼，再愤怒，最后从行动回收中获得释放。", 90)
    },
    reversalMatrix: {
      audienceBelieves: compact(topic.falseBelief, "承担者的沉默被误读为卑微和无能。", 80),
      antagonistMisdirection: "伤害者把现实牺牲包装成理所当然，让旁人只看见表面不体面",
      evidence1: compact(topic.proofChain, "可见物证与日期证明牺牲真实发生。", 100),
      evidence2: "",
      redHerring: "",
      reinterpretation: [compact(topic.reversal, "旧动作和旧物在主反转时被重新理解。", 100)],
      costAfterReversal: "误解者当众失去体面和辩解退路，并必须用持续行动承担修复成本"
    },
    story: {
      synopsis: compact(`${topic.logline || ""}；${highlights.join("；")}；${topic.emotionalPayoff || ""}`, "亲情误判经由证据和行动完成反转与回收。", 560),
      hook: compact(topic.hook, plans[0]?.action, 100),
      conflict: compact(topic.logline, "亲情牺牲被误解，伤害者拒绝面对现实代价。", 120),
      escalation: plans.filter(item => item.mainlineStage === "pressure").map(item => item.action),
      evidence: plans.filter(item => item.mainlineStage === "evidence").map(item => item.mainlineBeat),
      costlyKindness: plans.filter(item => item.mainlineStage === "cost_kindness").map(item => item.action),
      mainReversal: plans[reversalIndex]?.mainlineBeat,
      payoff: plans.filter(item => item.mainlineStage === "payoff").map(item => item.action),
      ending: plans.at(-1)?.action
    },
    characters,
    scenes,
    props: [
      { name: compact(topic.themeObject, "核心旧物", 24), appearance: "旧痕、折痕和使用痕迹清楚可辨", holder: `${characters[0].name}转交给${characters[1].name}`, units: [plans[0].id, plans[reversalIndex].id], purpose: "牺牲证据和主题回收", continuity: "外观痕迹与持有人变化必须连续" },
      { name: product.name, appearance: "外观完全以用户上传商品图为准", holder: `${characters[1].name}双手自然操作`, units: plans.filter(item => item.productMention).map(item => item.id), purpose: "反转后的日常行动回收", continuity: "不得虚构品牌、规格、价格或医疗功效" }
    ],
    actPlan: Array.from({ length: 6 }, (_, index) => ({
      act: index + 1,
      timeRange: `${Math.round(index * totalSeconds / 6)}-${Math.round((index + 1) * totalSeconds / 6)}秒`,
      entryState: plans[Math.floor(index * unitCount / 6)]?.stateBefore || "承接上一幕状态",
      irreversibleBeat: plans[Math.min(unitCount - 1, Math.floor((index + 1) * unitCount / 6) - 1)]?.mainlineBeat || "推进主线",
      visualStrategy: ["危机近景", "动作加压", "关系撕裂", "证据插入", "主反转与行动回收", "商品自然使用与结局"][index],
      exitState: plans[Math.min(unitCount - 1, Math.floor((index + 1) * unitCount / 6) - 1)]?.stateAfter || "形成下一幕不可逆入口"
    }))
  };
  return { storyBible, plans, rawShots, productStartNumber: productStartIndex + 1, reversalNumber: reversalIndex + 1 };
}

module.exports = {
  assertDirectFastSegment,
  assertDirectFastStorySpine,
  directFastBeatForRange,
  directFastResponseSchema,
  directFastStorySpineSchema,
  directFastStorySpinePrompt,
  directFastSemanticSchedulePrompt,
  directFastSemanticScheduleRangePrompt,
  directFastSemanticScheduleSchema,
  directFastSemanticScheduleDiagnostics,
  directFastSemanticScheduleRangeDiagnostics,
  recoverDirectFastSemanticUnitsFromRaw,
  normalizeDirectFastSemanticSpeakerUnits,
  assertDirectFastSemanticSchedule,
  buildDirectFastFallbackSegment,
  buildDirectFastFallbackSemanticUnit,
  buildDirectFastSemanticSegment,
  buildDirectFastFallbackSpine,
  directFastProductStartIndex,
  directFastReversalIndex,
  directFastSegmentRanges,
  directFastSpineFromLegacyPayload,
  directFastUserPrompt,
  fitDialogueLines,
  materializeDirectFastScript
};
