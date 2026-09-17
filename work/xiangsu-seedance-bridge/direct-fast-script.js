"use strict";

const crypto = require("node:crypto");
const { storyDensityTargets } = require("./script-craft");
const { dialogueUnitBudget, dialogueUnitPrompt } = require("./drama-writing-contract");

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

function sourceArray(value) {
  return Array.isArray(value) ? value : [];
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
  const seconds = Math.max(5, Math.min(15, Number(duration) || 10));
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
      const allowance = Math.max(5, Math.min(desired, remaining - minimumRemaining));
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
      a: "唯一可见动作与结果",
      bf: "开始状态",
      af: "结束后的不可逆状态",
      em: "起始情绪→触发→峰值→余震",
      f: 1,
      v: [1, 2],
      d: [[1, "完整口语台词", "压着火气，重音落在关键事实，句尾留气口", "下颌绷紧，手指扣住道具", "听者闭口，眼神躲开并后退半步"], [2, "回应台词", "先防御后松动，尾音发虚", "肩膀收紧，视线短暂回避", "前一说话人闭口，盯住对方等待回应"]]
    }]
  };
}

function directFastSemanticScheduleSchema() {
  return {
    u: [{ i: 1, duration: 8, beat: "本镜唯一新增事实或动作结果", before: "承接上一镜状态", after: "不可逆新状态", dialogueLines: [[1, "完整台词。"], [2, "完整回应。"]], cutAfter: "末句说完，听者反应0.6秒后在动作落点切镜", dialogueContinuesToNext: false }]
  };
}

function directFastSemanticSchedulePrompt({ topic, product, totalSeconds, durationMin = 5, durationMax = 15 }) {
  const minimumCount = Math.ceil(totalSeconds / durationMax);
  const maximumCount = Math.floor(totalSeconds / durationMin);
  return [
    `先为一部${totalSeconds}秒写实竖屏短剧做语义切镜。镜数只能由剧情决定，可在${minimumCount}-${maximumCount}镜之间，禁止用总秒数除以10预设镜数。`,
    `题材：${JSON.stringify(topic)}`,
    `商品：${product.name}；只使用事实：${product.sellingPoints || product.description || "用户未提供额外卖点"}。`,
    `只输出JSON根对象u。每项i从1连续；duration为${durationMin}-${durationMax}整数，全部duration之和精确等于${totalSeconds}。`,
    "先按完整对白回合、动作结果、场景任务、人物进出和情绪落点划分语义单元，再决定duration。短过场可5-7秒，常规攻防8-12秒，主反转或复杂动作可13-15秒；禁止整批同秒数。",
    "dialogueLines写本镜最终锁定的0-3句完整台词，每项为[说话人序号,完整台词]。同一镜最多两名说话人；典型10秒1-2轮/12-24字，15秒1-3轮/18-36字；每句必须以。！？!?…结束，任何一句都不得跨镜续说。",
    "每镜先给台词完整说完所需时间，再留35%-55%给动作、换气、0.3-0.8秒停顿和听者反应；最后一句后固定留0.4-0.8秒可见反应。若一句加动作超过15秒，必须在写作阶段改成两句完整短句，切点仍放在句号之后。",
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
      dialogueLines: sourceArray(unit.dialogueLines),
      cutAfter: compact(unit.cutAfter, "", 160),
      dialogueContinuesToNext: false
    }));
  const lockedIndexes = new Set(locked.map(unit => unit.i));
  const requestedAllocation = allocation.filter(item => !lockedIndexes.has(item.i));
  const dialogueBudgets = requestedAllocation.map(item => {
    const solo = dialogueUnitBudget(item.duration, { solo: true });
    const exchange = dialogueUnitBudget(item.duration, { solo: false });
    return `S${String(item.i).padStart(2, "0")}:无台词，或单人${solo.minTurns}-${solo.maxTurns}句/${solo.minChars}-${solo.maxChars}字，双人${exchange.minTurns}-${exchange.maxTurns}句/${exchange.minChars}-${exchange.maxChars}字`;
  });
  return [
    `[SEMANTIC_RANGE start=${first} end=${last}]`,
    `为一部 ${Number(totalSeconds) || 0} 秒竖屏短剧只编写 S${String(first).padStart(2, "0")}–S${String(last).padStart(2, "0")} 的语义切镜。不要输出范围外的镜头，不要解释。`,
    `题材：${JSON.stringify(topic || {})}`,
    `商品：${String(product?.name || "")}；只使用事实：${String(product?.sellingPoints || product?.description || "用户未提供额外卖点")}`,
    `本段已锁定时长分配（i 和 duration 必须逐项完全一致）：${JSON.stringify(allocation)}`,
    last < finalUnit
      ? `全剧最后一镜固定为 S${String(finalUnit).padStart(2, "0")}。当前 S${String(first).padStart(2, "0")}–S${String(last).padStart(2, "0")} 不是结尾：禁止解决主冲突、宣布结局、写“全剧收束/完结/落幕”，也禁止用定格画面结束故事；必须留下可被下一段承接的未完成动作、问题或压力。`
      : `这是全剧最后范围 S${String(first).padStart(2, "0")}–S${String(last).padStart(2, "0")}，只允许在 S${String(finalUnit).padStart(2, "0")} 完成最终收束。`,
    previousAfter ? `上一镜已锁定的结束状态：${String(previousAfter).slice(0, 180)}。本段首镜 before 必须自然承接。` : "这是开场段，S01 必须立刻呈现可见冲突或伤害钩子。",
    locked.length ? `本段已锁定、绝不可重写的语义单元（只作上下文，不要在本次 u 中重复输出）：${JSON.stringify(locked)}` : "本段暂无已锁定单元。",
    `只输出 JSON 根对象 {\"u\":[...]}。u 必须恰好包含本次未锁定编号：${requestedAllocation.map(item => item.i).join(",") || "无"}；每项依次填写 i、duration、beat、before、after、dialogueLines、cutAfter、dialogueContinuesToNext。`,
    `每项 0–3 句完整台词；同一镜最多两名说话人；每句必须在本镜说完并以 。！？… 结束；dialogueContinuesToNext 必须为 false。台词预算：${dialogueBudgets.join("；") || "无新增台词"}。beat 只写本镜新增事实、权力变化或行动结果；cutAfter 必须是完整句末后的可见动作或反应切点。`,
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
  if (lines.length > 3) failures.push("dialogueLineCount");
  if (lines.some(line => !Array.isArray(line) || Number(line[0]) < 1 || Number(line[0]) > 5
    || spokenLength(line[1]) < 2 || !/[。！？!?…]$/.test(String(line[1] || "").trim()))) failures.push("dialogueLines");
  const speakers = [...new Set(lines.map(line => Number(Array.isArray(line) ? line[0] : 0)).filter(Number.isFinite))];
  if (speakers.length > 2) failures.push("dialogueSpeakers");
  const dialogueBudget = dialogueUnitBudget(Number(unit?.duration) || 10, { solo: speakers.length <= 1 });
  const dialogueChars = lines.reduce((sum, line) => sum + spokenLength(line?.[1]), 0);
  if (lines.length && (lines.length < dialogueBudget.minTurns || lines.length > dialogueBudget.maxTurns
    || dialogueChars < dialogueBudget.minChars || dialogueChars > dialogueBudget.maxChars)) failures.push("dialogueBudget");
  const totalUnitCount = Math.max(0, Math.floor(Number(options.totalUnitCount) || 0));
  const authoredText = `${String(unit?.beat || "")} ${String(unit?.after || "")} ${String(unit?.cutAfter || "")}`;
  if (totalUnitCount > 1 && index + 1 < totalUnitCount
    && /(?:全剧|本剧|故事).{0,8}(?:收束|结束|完结)|(?:大结局|最终结局)|(?:画面|故事).{0,8}(?:定格|落幕).{0,10}(?:收束|结束|全剧|故事)/.test(authoredText)) {
    failures.push("prematureFinale");
  }
  return failures;
}

function directFastSemanticScheduleDiagnostics(payload, totalSeconds) {
  const units = sourceArray(payload?.u);
  const actualTotal = units.reduce((sum, unit) => sum + (Number(unit?.duration) || 0), 0);
  const invalidUnits = units.map((unit, index) => ({ i: index + 1, failures: directFastSemanticUnitFailures(unit, index) }))
    .filter(item => item.failures.length);
  const failures = [];
  if (!units.length) failures.push("empty");
  if (actualTotal !== Number(totalSeconds)) failures.push(`total:${actualTotal}/${Number(totalSeconds)}`);
  invalidUnits.forEach(item => failures.push(`S${String(item.i).padStart(2, "0")}:${item.failures.join(",")}`));
  return { units, actualTotal, expectedTotal: Number(totalSeconds), invalidUnits, failures, ok: failures.length === 0 };
}

function directFastSemanticScheduleRangeDiagnostics(payload, start, end, durations = []) {
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
    const failures = directFastSemanticUnitFailures(unit, index - 1, { totalUnitCount: durations.length });
    const expectedDuration = Number(durations[index - 1]);
    if (Number.isFinite(expectedDuration) && Number(unit.duration) !== expectedDuration) failures.push("durationPlan");
    if (failures.length) invalidUnits.push({ i: index, failures });
  }
  const outOfRange = units.map(unit => Number(unit?.i)).filter(index => !expected.includes(index));
  const expectedTotal = expected.reduce((sum, index) => sum + (Number(durations[index - 1]) || 0), 0);
  const actualTotal = expected.reduce((sum, index) => sum + (Number(byIndex.get(index)?.duration) || 0), 0);
  const failures = [];
  if (units.length !== expected.length) failures.push(`count:${units.length}/${expected.length}`);
  if (duplicateIndexes.length) failures.push(`duplicate:${duplicateIndexes.join(",")}`);
  if (outOfRange.length) failures.push(`outOfRange:${outOfRange.join(",")}`);
  if (actualTotal !== expectedTotal) failures.push(`total:${actualTotal}/${expectedTotal}`);
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

function assertDirectFastSemanticSchedule(payload, totalSeconds) {
  const diagnostics = directFastSemanticScheduleDiagnostics(payload, totalSeconds);
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
    c: [{ n: "姓名", a: "年龄段", r: "身份、关系与本剧立场", d: "外貌体态" }],
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
    "人物编号全剧不变：1=主角，2=核心冲突方，3=关键见证人；每人身份、关系、立场和外貌必须具体，人物不能跨段改名或互换身份。",
    `每个b只含a/z/sc/en/g/ex/h。en是本段进入时已成立的事实；g是本段唯一新增事实和可见行动；ex是不可逆结果；h是下一段第一镜可直接承接的动作、物件、末句或悬念。相邻段必须满足上一段ex/h能够因果承接下一段en，禁止重复争吵和同义复述。`,
    `唯一主反转固定在约72%位置；${product.name}及任何俗称在S${String(productStartNumber).padStart(2, "0")}之前不得出现，之后只用真实需求→自然操作→可见合规结果→人物决定完成植入。`,
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
  const validBeats = beats.length === expected.length && expected.every(([start, end], index) => {
    const beat = beats[index] || {};
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
    throw Object.assign(new Error("全剧人物、场景与分段因果骨架不完整"), {
      code: "SCRIPT_DIRECT_SPINE_CONTRACT_FAILED",
      noAutomaticRetry: true,
      retryRequiresExplicitResume: true
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
    const duration = Math.max(5, Math.min(15, Number(options.durations?.[shotNumber - 1]) || 10));
    const semanticUnit = sourceArray(options.semanticUnits).find(unit => Number(unit?.i) === shotNumber);
    const lockedDialogue = sourceArray(semanticUnit?.dialogueLines);
    // A product-introduction unit can still contain a locked spoken turn. It
    // is then a natural-use shot, not a silent packshot. Do not demand both
    // exact locked dialogue and an empty dialogue array from the same unit.
    const productPackshot = shotNumber === Number(options.productStartNumber) && lockedDialogue.length === 0;
    const dialogueSpeakers = dialogue.map(line => Number(Array.isArray(line) ? line[0] : 0));
    const uniqueSpeakers = [...new Set(dialogueSpeakers.filter(Number.isFinite))];
    const budget = dialogueUnitBudget(duration, { solo: visible.length <= 1, productPackshot });
    const spoken = dialogue.map(line => Array.isArray(line)
      ? String(line[1] || "").replace(/[\s，。！？!?、；;：:…]/g, "")
      : "");
    const totalSpoken = spoken.reduce((sum, value) => sum + spokenLength(value), 0);
    const firstSpoken = String(dialogue[0]?.[1] || "");
    const firstSpokenLength = spokenLength(firstSpoken);
    const semanticDialogue = !semanticUnit || (
      dialogue.length === lockedDialogue.length
      && dialogue.every((line, index) => Array.isArray(line)
        && Number(line[0]) === Number(lockedDialogue[index]?.[0])
        && String(line[1] || "").trim() === String(lockedDialogue[index]?.[1] || "").trim())
    );
    const checks = {
      title: compact(item?.t, "", 80).length >= 2,
      action: compact(item?.a, "", 160).length >= 4,
      before: compact(item?.bf, "", 160).length >= 4,
      after: compact(item?.af, "", 160).length >= 4,
      emotion: compact(item?.em, "", 120).split("→").length >= 3,
      focus: focus >= 1 && focus <= characters.length,
      visible: visible.length >= 1 && visible.length <= 2 && visible.every(value => value >= 1 && value <= characters.length),
      turns: dialogue.length >= budget.minTurns && dialogue.length <= budget.maxTurns,
      dialogue: dialogue.every(line => Array.isArray(line) && Number(line[0]) >= 1 && Number(line[0]) <= characters.length && spokenLength(line[1]) >= 3 && (options.requireCompleteDialogue !== true || /[。！？!?…]$/.test(String(line[1] || "").trim()))),
      semanticDialogue,
      dialogueBudget: totalSpoken >= budget.minChars && totalSpoken <= budget.maxChars,
      speakers: uniqueSpeakers.length <= 2 && dialogueSpeakers.every(value => visible.includes(value)),
      unique: dialogue.length === 0 || new Set(spoken).size >= Math.max(1, dialogue.length - 1),
      opening: Number(item?.i) !== 1 || (firstSpokenLength >= 6 && firstSpokenLength <= 12 && /[？?!！]|凭什么|还敢|住手|滚|你也配|谁让|别碰|放开|跪下/.test(firstSpoken))
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
    const seconds = Math.max(5, Math.min(15, Number(unitDurations[number - 1]) || Math.round(totalSeconds / unitCount) || 10));
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
    "每个s只允许t/a/bf/af/em/f/v/d字段：f和v使用c的1起始序号；v最多2人，f只是本单元开场焦点，不是全段唯一说话人；d每项严格为[说话人序号,完整台词,语气与气口,面部/身体动作,听者反应]，说话人序号必须来自v，同一S可由两人自然问答。说话人变化时按对白顺序形成明确正反打切点；商品整体干净镜d为空。",
    `每镜d严格按本镜时长写自然可演对白：${durationContract}。每句约4-12个可说汉字，必须完整且改变信息、权力或行动，不能同义复述；语气、情绪、身体动作必须逐句不同并随冲突升级。em写清起始情绪、触发、峰值和余震；a写唯一可见动作结果。`,
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
    { n: "周桂兰", a: "58岁", r: `${relationship}中的母亲，也是长期承担者`, d: "偏瘦、肩背微驼、手指有旧茧" },
    { n: "林晓梅", a: "32岁", r: `${relationship}中的女儿，也是误解者`, d: "利落短发、体态紧绷、动作急" },
    { n: "陈阿姨", a: "61岁", r: "邻居与关键见证人", d: "圆阔脸、灰白短发、步态稳" }
  ];
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
  const seconds = Math.max(5, Math.min(15, Number(duration) || 10));
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
  const completeExtensions = ["你现在说清楚", "请你当面回答", "这次别再回避"];
  const extensionOrder = number === 1 ? [1, 0] : selected.map((_, index) => index);
  for (const index of extensionOrder) {
    if (totalSpoken >= budget.targetChars || index >= selected.length) break;
    const extension = completeExtensions[(number + index) % completeExtensions.length];
    selected[index] = `${selected[index]}，${extension}`;
    totalSpoken += spokenLength(extension);
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
  return selected.map((text, index) => [
    solo || index % 2 === 0 ? focus : other,
    `${text}${number === 1 && index === 0 ? "！" : "。"}`,
    deliveries[index % deliveries.length],
    bodies[index % bodies.length],
    reactions[index % reactions.length]
  ]);
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
      const duration = Math.max(5, Math.min(15, Number(unitDurations[number - 1]) || 10));
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
        d: number === Number(productStartNumber) ? [] : fallbackDialogue(number, duration, focus, other, solo, { stage, beat, topic })
      };
    }),
    c: characters,
    sc: scenes
  };
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
  const units = new Map(sourceArray(semanticUnits).map(unit => [Number(unit?.i), unit]));
  return {
    ...base,
    s: base.s.map(shot => {
      const unit = units.get(Number(shot.i));
      if (!unit) return shot;
      const lockedDialogue = sourceArray(unit.dialogueLines)
        .filter(line => Array.isArray(line) && Number.isInteger(Number(line[0])) && String(line[1] || "").trim())
        .map(line => [Number(line[0]), String(line[1]).trim()]);
      const speakingIds = [...new Set(lockedDialogue.map(line => line[0]))];
      const visible = speakingIds.length ? speakingIds : sourceArray(shot.v).map(Number).filter(Number.isFinite).slice(0, 2);
      const focus = visible[0] || Number(shot.f) || 1;
      return {
        ...shot,
        t: compact(unit.beat, shot.t, 80),
        a: compact(`${unit.beat || "推进事实"}；${unit.cutAfter || "人物完成动作并形成反应"}`, shot.a, 160),
        bf: compact(unit.before, shot.bf, 160),
        af: compact(unit.after, shot.af, 160),
        em: `克制→${compact(unit.beat, "事实推进", 28)}→${compact(unit.after, "关系改变", 28)}→余震`,
        f: focus,
        v: visible,
        d: lockedDialogue.map(([speaker, text], index) => [
          speaker,
          text,
          index % 2 ? "语速放缓，关键事实落重音，句尾留出回应空间" : "语气贴合当前冲突，关键事实落重音",
          index % 2 ? "说完停顿半拍，视线留在对方脸上" : "身体动作跟随台词落点，不遮挡听者反应",
          index === lockedDialogue.length - 1 ? "听者先停住动作，再给出可见反应" : "前一位说话人闭口等待回应"
        ])
      };
    })
  };
}

function materializeCharacters(payload, topic) {
  const authored = sourceArray(payload?.c).slice(0, 5);
  const fallbacks = characterFallbacks(topic);
  const merged = [...authored];
  while (merged.length < 3) merged.push(fallbacks[merged.length]);
  const voiceProfiles = [
    "中老年女声；中低音；略带沙哑和慢起气口；常态偏慢，受辱时尾字轻颤，落锤时压低重读",
    "青年女声；中高音；清亮偏紧；防御时语速偏快，心虚时气短，认错时降速并带哭腔",
    "老年女声；中音；圆润厚实；叙事实事求是、停顿清楚，作证落锤时字头有力",
    "成年男声；低音；干燥克制；平时短句慢说，利益受损时突然加速并咬紧尾音",
    "青年男声；中音；清晰利落；平时稳，冲突时音量抬高但不嘶喊"
  ];
  return merged.slice(0, 5).map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    const fallback = fallbacks[index] || fallbacks.at(-1);
    const name = compact(source.n || source.name, fallback.n, 12);
    const age = compact(source.a || source.age, fallback.a, 12);
    const role = compact(source.r || source.role, fallback.r, 40);
    const description = compact(source.d || source.description, fallback.d, 70);
    const digest = crypto.createHash("sha256").update(`${name}|${age}|${role}`).digest("hex");
    return {
      id: `C${String(index + 1).padStart(2, "0")}`,
      name,
      age,
      role,
      description,
      identitySignature: `${description}；脸部固定识别码${digest.slice(0, 6)}`,
      desire: index === 0 ? "让家人过得体面并守住尊严" : index === 1 ? "弄清真相并弥补旧伤" : "把亲眼见证的事实说清楚",
      fear: index === 0 ? "自己的牺牲拖累家人" : index === 1 ? "发现自己曾伤害最亲的人" : "真话说晚后再也来不及",
      arc: index === 0 ? "从隐忍承担到被行动看见" : index === 1 ? "从误判伤人到承担现实代价并行动修复" : "从旁观到公开作证",
      voiceDescription: voiceProfiles[index] || "成年声线；音高、质感、常态语速和压力态变化必须与其他角色不同",
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
    { n: "旧家缝纫间", d: "旧木桌、缝纫机、窗边工作区，承担伤害钩子与牺牲行动" },
    { n: "婚礼后厅与旧物房", d: "衣架、纸箱、桌面物证区，承担证据递进和主反转" },
    { n: "社区缝纫工作室", d: "裁剪台、低柜、通道与工作垫，承担行动回收和商品自然使用" }
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
    const visibleIndexes = [...new Set([...authoredSpeakers, authoredFocus, ...authoredVisible])].slice(0, 2);
    const productMention = index >= productStartIndex && index < productStartIndex + 3;
    const productRole = productMention ? ["product_packshot", "product_use", "product_result"][index - productStartIndex] : "none";
    const visibleCharacterIds = visibleIndexes.map(value => characters[value - 1]?.id).filter(Boolean);
    const focus = characters[authoredFocus - 1] || characters[0];
    const authoredDialogue = sourceArray(source.d);
    const authoredSpeakerCount = new Set(authoredSpeakers).size;
    const intendedSolo = authoredDialogue.length ? authoredSpeakerCount <= 1 : visibleIndexes.length <= 1;
    const authoredDialogueBudget = dialogueUnitBudget(duration, { solo: intendedSolo, productPackshot: productRole === "product_packshot" });
    // New spine-based responses are validated against the exact per-shot
    // duration and arrive ready to perform. Legacy payloads are still fitted
    // locally so old paused tasks remain resumable without rewriting them.
    let dialogueSource = authoredDialogue.length >= authoredDialogueBudget.minTurns && authoredDialogue.length <= authoredDialogueBudget.maxTurns && payload?.spineLocked === true
      ? authoredDialogue.map(item => Array.isArray(item) ? item : [item?.s, item?.x || item?.text, item?.delivery, item?.body, item?.listenerBeat])
        .map(([speaker, text, delivery, body, listenerBeat]) => ({ speaker: Math.max(1, Number(speaker) || 1), text: authoredSpeech(text), delivery: compact(delivery, "按当前冲突自然起伏", 120), body: compact(body, "面部和手部随台词发生可见变化", 120), listenerBeat: compact(listenerBeat, "听者闭口并给出可见反应", 120) }))
        .filter(item => spokenLength(item.text) >= 2)
      : fitDialogueLines(authoredDialogue, index === 0, duration, { solo: intendedSolo, productPackshot: productRole === "product_packshot" });
    if (index === 0 && dialogueSource.length && payload?.spineLocked !== true) {
      dialogueSource[0].text = openingSentenceFromSource(dialogueSource[0].text);
    }
    const dialogueVisibleIds = productRole === "product_packshot" ? [] : visibleCharacterIds;
    const action = index === 0
      ? compact(source.a || source.action || topic.hook, "对方踢开跪地劳作的人，婚纱裙摆从手中滑落", 88)
      : productRole === "product_packshot"
        ? `${product.name}整体、包装与用户图片中可见的真实外观细节在干净承载面上清晰呈现，不出现人物脸部`
      : productMention
        ? productBridge(product, focus, index).action
        : compact(source.a || source.action, `${focus.name}完成第${index + 1}个不可逆动作，现场关系随之改变`, 88);
    const before = compact(source.bf, `上一镜结果压到${focus.name}面前`, 65);
    const after = compact(source.af, `${focus.name}用可见动作把关系推进到无法退回的状态`, 65);
    const emotion = compact(source.em, stage === "main_reversal" ? "压抑→看清证据→崩溃→决定承担" : "克制→受刺激→情绪抬升→压住余震", 65);
    const dialogueTurns = (productRole === "product_packshot" ? [] : dialogueSource).map((turn, turnIndex) => {
      const speaker = characters[Math.max(0, Math.min(characters.length - 1, turn.speaker - 1))] || focus;
      const listener = dialogueVisibleIds.map(characterId => characters.find(item => item.id === characterId)).find(item => item && item.id !== speaker.id) || null;
      return {
        speakerId: speaker.id,
        listenerIds: listener ? [listener.id] : [],
        text: turn.text,
        beat: ["attack", "deflect", "counter", "reveal", "counter", "decision"][turnIndex % 6],
        delivery: turn.delivery || deliveryFor(emotion, turnIndex),
        body: turn.body || `${speaker.name}第${turnIndex + 1}句时${turnIndex < 2 ? "手指收紧并稳住重心" : turnIndex < 4 ? "下颌绷住、身体向前半步" : "呼吸停半拍后完成决定动作"}`,
        listenerBeat: turn.listenerBeat || (listener ? `${listener.name}听见后眼神一顿，肩颈和手部出现可见反应` : "画外听者屏住呼吸，下一镜承接其反应"),
        subshotNumber: Math.min(3, Math.floor(turnIndex * 3 / Math.max(1, dialogueSource.length)) + 1),
        onScreen: dialogueVisibleIds.includes(speaker.id)
      };
    });
    const planVisibleIds = productRole === "product_packshot" ? [] : visibleCharacterIds;
    const openingSpeakerId = dialogueTurns[0]?.speakerId || planVisibleIds[0] || "";
    const counterpart = characters.find(item => planVisibleIds.includes(item.id) && item.id !== openingSpeakerId) || null;
    const dialogueSpeakerIds = [...new Set(dialogueTurns.map(turn => turn.speakerId).filter(Boolean))];
    const dialogueIsSolo = dialogueSpeakerIds.length <= 1;
    const bridge = productMention ? productBridge(product, focus, index) : { situationNeed: "", whyNow: "", action: "", observableOutcome: "", relationOrDecisionShift: "" };
    if (productRole === "product_packshot") bridge.relationOrDecisionShift = "";
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
      mouthOwnerId: productRole === "product_packshot" ? "" : openingSpeakerId,
      shotFunction: productMention ? productRole : (planVisibleIds.length > 1 ? "two_shot" : "speaker_closeup"),
      scene: scene.name,
      sceneObjective: mainlineBeat,
      transitionReason: index === 0 ? "冷开场直接砸入危机" : "承接上一镜末句、视线与手部动作",
      mainlineStage: stage,
      mainlineBeat,
      kindnessCost: stage === "cost_kindness" ? `${focus.name}为保护家人失去时间、尊严或现实机会` : "无",
      reversalSetup: stage === "evidence" ? compact(topic.proofChain, "可见物证进入画面", 70) : "无",
      action,
      stateBefore: before,
      stateAfter: after,
      causalLink: index === 0 ? "伤害动作发生，所以首句制止立刻引爆母女冲突" : `因为S${String(index).padStart(2, "0")}留下未解决的动作和事实，所以${action}导致${after}`,
      visualBeat,
      compositionPlan: dialogueIsSolo
        ? `${index % 3 === 0 ? "说话人单人近景" : index % 3 === 1 ? "说话人中近景缓推" : "侧向说话人近景"}；说话人看听者而非镜头`
        : "双人对白按dialogueTurns时间顺序执行说话人近景↔听者反打；换speakerId即硬切机位并切换唯一嘴型，保持180度轴线",
      audioPlan: `0-${duration}秒连续室内环境底噪；对白清晰；脚步、衣料摩擦、纸张或器物动作特效声同步；只保留现场声`,
      dialogueGoal: `${dialogueUnitPrompt(duration, { solo: dialogueIsSolo, productPackshot: productRole === "product_packshot" })}；按轮次完成攻防，只新增一条关键信息并由末句或末动作触发可见后果`,
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
      subshotTarget: 3
    };

    const splitA = Math.max(1, Math.round(duration * 0.3));
    const splitB = Math.max(splitA + 1, Math.round(duration * 0.7));
    const subshotRoles = productMention && index === productStartIndex
      ? ["product_packshot", "product_detail", "product_packshot"]
      : productMention && index === productStartIndex + 1
        ? ["product_use", "product_use", "product_use"]
        : productMention
          ? ["product_result", "product_reaction", "product_reaction"]
          : dialogueIsSolo
            ? ["speaker_hold", "speaker_hold", "speaker_hold"]
            : ["dialogue_exchange", "dialogue_exchange", "dialogue_exchange"];
    const boundaries = [[0, splitA], [splitA, splitB], [splitB, duration]];
    const subshots = boundaries.map(([start, end], subIndex) => {
      const role = subshotRoles[subIndex];
      const cleanProduct = /product_(?:packshot|detail)/.test(role);
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
        framing: cleanProduct ? "无脸商品干净特写" : dialogueIsSolo ? (subIndex === 0 ? "说话人中近景" : subIndex === 1 ? "同一说话人缓推近景" : "同一说话人余震近景") : "当前说话人近景；轮次变化时切回应者反打",
        camera: cleanProduct ? "稳定商品机位" : dialogueIsSolo ? (subIndex === 1 ? "同一机位轻微推进" : subIndex === 2 ? "同一机位停止并保持" : "稳定机位开始缓推") : "保持180度轴线；speakerId变化处使用无转场硬切",
        action: cleanProduct ? `${product.name}整体与用户图片中可见的真实外观细节在干净承载面上清晰呈现` : `${action}；第${subIndex + 1}段完成可见状态变化`,
        dialogueTurns: turns,
        sound: `连续室内环境底噪；${subIndex === 0 ? "衣料摩擦" : subIndex === 1 ? "脚步与急促呼吸" : "纸张或器物轻响"}动作特效声`,
        transition: subIndex === 2 ? "以末句和动作结果桥接下一镜" : "台词与视线接力",
        visibleCharacterIds: cleanProduct ? [] : planVisibleIds,
        cameraOwnerId,
        mouthOwnerId,
        speakerIds: cleanProduct ? [] : segmentSpeakerIds,
        offscreenSpeakerIds: cleanProduct ? [] : segmentOffscreenSpeakerIds,
        listenerIds: cleanProduct ? [] : segmentListenerIds,
        speakerFacing: cleanProduct ? "无人脸" : `${cameraOwner.name}朝向听者眼睛`,
        listenerFacing: counterpart ? `${counterpart.name}看向当前说话人` : "听者位于画外轴线方向",
        eyelineDirection: "保持180度轴线，禁止对镜头念词",
        emotionBeat: ["情绪起始", "触发与峰值", "余震和决定"][subIndex],
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
      stateBefore: before,
      stateAfter: after,
      causalLink: plan.causalLink,
      visualBeat,
      compositionPlan: plan.compositionPlan,
      audioPlan: plan.audioPlan,
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
  assertDirectFastSemanticSchedule,
  buildDirectFastFallbackSegment,
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
