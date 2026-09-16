"use strict";

/**
 * Provider duration contracts for narrative shot units.
 * Values are integers in seconds; planning clamps shot.duration into these bounds.
 */

function durationContract(providerKind = "", options = {}) {
  void providerKind;
  void options;
  // Final H3 narrative units are complete acted beats, not single-line fragments.
  // Hooks, reactions, inserts and transitions live inside those units.
  return Object.freeze({ min: 10, max: 15, preferred: 12, fixed: false, step: 1 });
}

function durationBounds(providerKind, options = {}) {
  const contract = durationContract(providerKind, options);
  return Object.freeze({ min: contract.min, max: contract.max, preferred: contract.preferred, fixed: contract.fixed });
}

function normalizeFilmTotalSeconds(value, fallback, minimum) {
  const raw = Math.round(Number(value));
  return Math.max(minimum, Number.isFinite(raw) && raw > 0 ? raw : fallback);
}

function normalizeTargetDurationSeconds(value, providerKind = "", options = {}) {
  const contract = typeof providerKind === "object" && providerKind
    ? providerKind
    : durationContract(providerKind, options);
  const preferred = Number(contract.preferred) || Number(contract.min) || 12;
  const raw = Number(value);
  if (contract.fixed) return Math.round(Number(contract.min) || preferred);
  if (!Number.isFinite(raw) || raw <= 0) return preferred;
  if (Array.isArray(contract.allowed) && contract.allowed.length) {
    return contract.allowed.slice().sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw) || a - b)[0];
  }
  const rounded = Math.round(raw);
  const min = Number(contract.min) || 10;
  const max = Number(contract.max) || min;
  return Math.max(min, Math.min(max, rounded));
}

/** Split a total narrative length into contiguous batch ranges of `batchSize` shots. */
function batchRanges(totalCount, batchSize = 10) {
  const total = Math.max(0, Math.floor(Number(totalCount) || 0));
  const size = Math.max(1, Math.floor(Number(batchSize) || 10));
  const ranges = [];
  for (let start = 0; start < total; start += size) {
    const end = Math.min(total, start + size);
    ranges.push(Object.freeze({ start, end, count: end - start, batchIndex: ranges.length }));
  }
  return ranges;
}

/** Plan per-shot durations from requested values without randomness. */
function planShotDurations(shots = [], providerKind = "", options = {}) {
  const contract = durationContract(providerKind, options);
  const fallback = Number(options.defaultDuration) || contract.preferred;
  return (Array.isArray(shots) ? shots : []).map((shot) => {
    const requested = Number(shot?.duration) || fallback;
    return normalizeTargetDurationSeconds(requested, contract);
  });
}

function allowedDurationPlan(requested, targetTotalSeconds, allowed) {
  const target = Math.round(Number(targetTotalSeconds));
  const choices = [...new Set((allowed || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const count = requested.length;
  if (!choices.length || !count || !Number.isFinite(target)) return null;
  if (target < choices[0] * count || target > choices[choices.length - 1] * count) return null;

  const normalized = requested.map(value => choices
    .slice()
    .sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b)[0]);
  const layers = [new Map([[0, { cost: 0, previous: null, value: null }]])];
  for (let index = 0; index < count; index += 1) {
    const next = new Map();
    for (const [sum, state] of layers[index]) {
      for (const value of choices) {
        const nextSum = sum + value;
        if (nextSum > target) continue;
        const cost = state.cost + Math.abs(value - normalized[index]);
        const existing = next.get(nextSum);
        if (!existing || cost < existing.cost || (cost === existing.cost && value < existing.value)) {
          next.set(nextSum, { cost, previous: sum, value });
        }
      }
    }
    layers.push(next);
  }
  if (!layers[count].has(target)) return null;
  const values = Array(count);
  let sum = target;
  for (let index = count; index > 0; index -= 1) {
    const state = layers[index].get(sum);
    values[index - 1] = state.value;
    sum = state.previous;
  }
  return values;
}

/**
 * Keep relative variation from requested durations while summing exactly to targetTotalSeconds.
 * Prefer trimming/growing longer units first so short beats stay short.
 */
function reconcileUnitDurations(requested = [], targetTotalSeconds, providerKind = "", options = {}) {
  const contract = typeof providerKind === "object" && providerKind
    ? providerKind
    : durationContract(providerKind, options);
  const min = Number(contract.min) || 10;
  const max = Number(contract.max) || 15;
  const preferred = Number(contract.preferred) || 10;
  const count = Math.max(1, (Array.isArray(requested) ? requested : []).length || Number(options.unitCount) || 1);
  const totalSeconds = normalizeFilmTotalSeconds(targetTotalSeconds, count * preferred, min);
  const values = Array.from({ length: count }, (_, index) => {
    const raw = Number(requested?.[index]);
    return normalizeTargetDurationSeconds(Number.isFinite(raw) && raw > 0 ? raw : preferred, contract);
  });
  if (Array.isArray(contract.allowed) && contract.allowed.length) {
    const exact = allowedDurationPlan(values, totalSeconds, contract.allowed);
    if (!exact) {
      throw Object.assign(new Error(`目标时长 ${totalSeconds} 秒无法由供应商允许的单元时长 ${contract.allowed.join("/")} 秒精确组成`), {
        code: "DURATION_TOTAL_UNREPRESENTABLE",
        targetTotalSeconds: totalSeconds,
        unitCount: count,
        allowed: [...contract.allowed]
      });
    }
    return Object.freeze(exact);
  }
  let sum = values.reduce((a, b) => a + b, 0);
  const orderByLengthDesc = () => [...values.keys()].sort((a, b) => values[b] - values[a] || b - a);
  const orderByLengthAsc = () => [...values.keys()].sort((a, b) => values[a] - values[b] || a - b);
  let guard = 0;
  while (sum > totalSeconds && guard < 10000) {
    const idxs = orderByLengthDesc().filter((i) => values[i] > min);
    if (!idxs.length) break;
    values[idxs[0]] -= 1;
    sum -= 1;
    guard += 1;
  }
  guard = 0;
  while (sum < totalSeconds && guard < 10000) {
    const idxs = orderByLengthAsc().filter((i) => values[i] < max);
    if (!idxs.length) break;
    values[idxs[0]] += 1;
    sum += 1;
    guard += 1;
  }
  if (sum !== totalSeconds) {
    throw Object.assign(new Error(`目标时长 ${totalSeconds} 秒无法由 ${count} 个 ${min}-${max} 秒的生成单元精确组成`), {
      code: "DURATION_TOTAL_UNREPRESENTABLE",
      targetTotalSeconds: totalSeconds,
      unitCount: count,
      min,
      max
    });
  }
  return Object.freeze(values);
}

/**
 * Soft narrative rhythm weights (not hard locks). Longer for confrontation / reversal / slap;
 * shorter for silence / transitions / motif holds.
 */
function narrativeDurationWeight(index, unitCount, stageHint = "") {
  const ratio = unitCount <= 1 ? 0 : index / (unitCount - 1);
  const stage = String(stageHint || "").toLowerCase();
  if (/silence|抽音|静默/.test(stage)) return 0.55;
  if (/main_reversal|face.?slap|打脸|主反转|climax/.test(stage)) return 1.45;
  if (/evidence|对质|摊牌|cost_kindness/.test(stage)) return 1.2;
  if (/hook|开场/.test(stage)) return 0.8;
  if (/ending|payoff|回收|结局/.test(stage)) return 1.05;
  if (/transition|过场|转场/.test(stage)) return 0.65;
  // Soft act anchors when stage hints are absent: short silence before mid-late peak, longer climax cluster.
  const silenceAt = Math.max(1, Math.floor(unitCount * 0.52));
  const climaxAt = Math.max(2, Math.floor(unitCount * 0.58));
  const slapAt = Math.min(unitCount - 2, climaxAt + 2);
  if (index === silenceAt) return 0.55;
  if (index === climaxAt || index === slapAt) return 1.4;
  if (Math.abs(index - climaxAt) <= 1) return 1.25;
  // Curve: slightly shorter early, peak mid-late, settle at end.
  if (ratio < 0.12) return 0.8;
  if (ratio < 0.45) return 0.95;
  if (ratio < 0.72) return 1.15;
  if (ratio < 0.88) return 1.05;
  return 0.9;
}

/**
 * Plan a whole film so unit durations can vary by beat while summing exactly to targetTotalSeconds.
 * `unitDurations` is a soft suggested rhythm (for empty LLM output fallback), NOT a hard per-slot lock.
 */
function planFilmSchedule(targetTotalSeconds, providerKind = "", options = {}) {
  const contract = durationContract(providerKind, options);
  const min = Number(contract.min) || 10;
  const max = Number(contract.max) || 15;
  const preferredRaw = Number(options.preferredUnit) || contract.preferred || 10;
  const preferred = Math.max(min, Math.min(max, preferredRaw));
  const totalSeconds = normalizeFilmTotalSeconds(targetTotalSeconds, 300, min);
  const semanticUnitCount = Math.round(Number(options.semanticUnitCount));
  const semanticDurations = Array.isArray(options.semanticDurations)
    ? options.semanticDurations.map(Number).filter(value => Number.isFinite(value) && value > 0)
    : [];
  let unitCount = semanticDurations.length
    || (Number.isFinite(semanticUnitCount) && semanticUnitCount > 0 ? semanticUnitCount : Math.max(1, Math.round(totalSeconds / preferred)));
  const minimumCount = Math.max(1, Math.ceil(totalSeconds / max));
  const maximumCount = Math.max(minimumCount, Math.floor(totalSeconds / min));
  const semanticPlanFitsContract = unitCount >= minimumCount && unitCount <= maximumCount;
  if (!semanticPlanFitsContract) unitCount = Math.max(minimumCount, Math.min(maximumCount, Math.round(totalSeconds / preferred)));
  if (Array.isArray(contract.allowed) && contract.allowed.length) {
    const minCount = Math.max(1, Math.ceil(totalSeconds / max));
    const maxCount = Math.max(minCount, Math.floor(totalSeconds / min));
    const candidates = Array.from({ length: Math.max(0, maxCount - minCount + 1) }, (_, index) => minCount + index)
      .sort((a, b) => Math.abs(a - unitCount) - Math.abs(b - unitCount) || a - b);
    const viable = candidates.find(count => allowedDurationPlan(Array(count).fill(preferred), totalSeconds, contract.allowed));
    if (!viable) {
      throw Object.assign(new Error(`目标时长 ${totalSeconds} 秒无法由供应商允许的单元时长 ${contract.allowed.join("/")} 秒精确组成`), {
        code: "DURATION_TOTAL_UNREPRESENTABLE",
        targetTotalSeconds: totalSeconds,
        allowed: [...contract.allowed]
      });
    }
    unitCount = viable;
  } else {
    // Prefer counts that keep units near preferred while summing exactly.
    while (unitCount > 1 && Math.floor(totalSeconds / unitCount) < min) unitCount -= 1;
    while (Math.ceil(totalSeconds / unitCount) > max) unitCount += 1;
  }

  const stageHints = Array.isArray(options.stageHints) ? options.stageHints : [];
  const weighted = Array.from({ length: unitCount }, (_, index) => {
    const weight = narrativeDurationWeight(index, unitCount, stageHints[index]);
    return Math.max(0.5, weight);
  });
  const weightSum = weighted.reduce((a, b) => a + b, 0) || unitCount;
  const rough = semanticPlanFitsContract && semanticDurations.length === unitCount
    ? semanticDurations
    : weighted.map((w) => (totalSeconds * w) / weightSum);
  const suggested = reconcileUnitDurations(rough, totalSeconds, contract, { unitCount });

  const productEntryIndex = Math.max(0, Math.floor(unitCount * 0.65));
  return Object.freeze({
    totalSeconds,
    unitCount,
    unitDurations: suggested,
    suggestedDurations: suggested,
    preferredUnit: preferred,
    durationMin: min,
    durationMax: max,
    variableDurations: true,
    productEntryIndex,
    planBatchSize: 4,
    batchCount: Math.ceil(unitCount / 4)
  });
}

function completeDialogueBoundary(value) {
  const text = String(value || "").trim();
  return !text || /[。！？!?…]$/.test(text);
}

function validateSemanticShotSchedule(units = [], targetTotalSeconds, providerKind = "", options = {}) {
  const list = Array.isArray(units) ? units : [];
  const contract = durationContract(providerKind, options);
  const totalSeconds = Math.round(Number(targetTotalSeconds));
  const failures = [];
  list.forEach((unit, index) => {
    const id = `S${String(index + 1).padStart(2, "0")}`;
    if (String(unit?.id || id) !== id) failures.push(`${id}:镜号不连续`);
    const duration = Number(unit?.duration);
    if (!Number.isInteger(duration) || duration < contract.min || duration > contract.max) failures.push(`${id}:时长超出${contract.min}-${contract.max}秒`);
    const lines = Array.isArray(unit?.dialogueLines) ? unit.dialogueLines : [];
    if (lines.some(line => !completeDialogueBoundary(typeof line === "string" ? line : line?.text))) failures.push(`${id}:存在未说完的半句`);
    if (!String(unit?.cutAfter || "").trim()) failures.push(`${id}:缺少句末/动作切点`);
    if (unit?.dialogueContinuesToNext === true) failures.push(`${id}:禁止跨镜续说半句`);
  });
  const sum = list.reduce((total, unit) => total + (Number(unit?.duration) || 0), 0);
  if (sum !== totalSeconds) failures.push(`总时长${sum}秒不等于${totalSeconds}秒`);
  if (!list.length) failures.push("语义切镜计划为空");
  if (failures.length) throw Object.assign(new Error(`语义切镜计划不完整：${failures.join("；")}`), { code: "SEMANTIC_SHOT_SCHEDULE_INVALID", failures });
  return list;
}

module.exports = {
  batchRanges,
  durationBounds,
  durationContract,
  narrativeDurationWeight,
  normalizeTargetDurationSeconds,
  planFilmSchedule,
  planShotDurations,
  reconcileUnitDurations,
  completeDialogueBoundary,
  validateSemanticShotSchedule
};
