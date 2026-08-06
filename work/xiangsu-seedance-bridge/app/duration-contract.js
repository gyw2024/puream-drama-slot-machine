"use strict";

/**
 * Provider duration contracts for narrative shot units.
 * Values are integers in seconds; planning clamps shot.duration into these bounds.
 */

function durationContract(providerKind = "", options = {}) {
  const kind = String(providerKind || options.providerKind || "");
  if (kind === "puream-seedance") {
    return Object.freeze({ min: 5, max: 15, preferred: 10, fixed: false, step: 1 });
  }
  if (kind === "puream-hailuo-h3") {
    return Object.freeze({ min: 5, max: 15, preferred: 10, fixed: false, step: 1 });
  }
  if (kind === "puream-grok") {
    return Object.freeze({ min: 6, max: 6, preferred: 6, fixed: true, step: 1 });
  }
  if (kind === "puream-gemini") {
    return Object.freeze({ min: 4, max: 4, preferred: 4, fixed: true, step: 1 });
  }
  if (kind === "local-xiangsu") {
    return Object.freeze({ min: 5, max: 10, preferred: 10, fixed: false, step: 1 });
  }
  // Engine-level fallbacks when only engine name is known.
  if (options.engine === "hailuo-h3") {
    return Object.freeze({ min: 5, max: 15, preferred: 10, fixed: false, step: 1 });
  }
  if (options.engine === "seedance") {
    return Object.freeze({ min: 5, max: 15, preferred: 10, fixed: false, step: 1 });
  }
  return Object.freeze({ min: 5, max: 15, preferred: 10, fixed: false, step: 1 });
}

function durationBounds(providerKind, options = {}) {
  const contract = durationContract(providerKind, options);
  return Object.freeze({ min: contract.min, max: contract.max, preferred: contract.preferred, fixed: contract.fixed });
}

function normalizeTargetDurationSeconds(value, providerKind = "", options = {}) {
  const contract = typeof providerKind === "object" && providerKind
    ? providerKind
    : durationContract(providerKind, options);
  const preferred = Number(contract.preferred) || Number(contract.min) || 5;
  const raw = Number(value);
  if (contract.fixed) return Math.round(Number(contract.min) || preferred);
  if (!Number.isFinite(raw) || raw <= 0) return preferred;
  const rounded = Math.round(raw);
  const min = Number(contract.min) || 5;
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
  return (Array.isArray(shots) ? shots : []).map((shot, index) => {
    const requested = Number(shot?.duration) || fallback;
    return normalizeTargetDurationSeconds(requested, contract);
  });
}

/**
 * Plan a whole film so unit durations sum exactly to targetTotalSeconds.
 * Returns unitCount, unitDuration list, and the first shot index allowed for product (65%).
 */
function planFilmSchedule(targetTotalSeconds, providerKind = "", options = {}) {
  const contract = durationContract(providerKind, options);
  const preferred = Number(options.preferredUnit) || contract.preferred || 10;
  const min = Number(contract.min) || 5;
  const max = Number(contract.max) || 15;
  const rawTotal = Math.round(Number(targetTotalSeconds) || 300);
  const totalSeconds = Math.max(min, Math.min(3600, rawTotal));
  let unitCount = Math.max(1, Math.round(totalSeconds / preferred));
  // Prefer counts that keep units near preferred while summing exactly.
  while (unitCount > 1 && Math.floor(totalSeconds / unitCount) < min) unitCount -= 1;
  while (Math.ceil(totalSeconds / unitCount) > max) unitCount += 1;
  const base = Math.floor(totalSeconds / unitCount);
  const remainder = totalSeconds - base * unitCount;
  const unitDurations = Array.from({ length: unitCount }, (_, index) => {
    const value = base + (index < remainder ? 1 : 0);
    return Math.max(min, Math.min(max, value));
  });
  // If clamping broke the sum, redistribute from the end.
  let sum = unitDurations.reduce((a, b) => a + b, 0);
  let cursor = unitCount - 1;
  while (sum > totalSeconds && cursor >= 0) {
    if (unitDurations[cursor] > min) {
      unitDurations[cursor] -= 1;
      sum -= 1;
    } else cursor -= 1;
  }
  cursor = unitCount - 1;
  while (sum < totalSeconds && cursor >= 0) {
    if (unitDurations[cursor] < max) {
      unitDurations[cursor] += 1;
      sum += 1;
    } else cursor -= 1;
  }
  const productEntryIndex = Math.max(0, Math.floor(unitCount * 0.65));
  return Object.freeze({
    totalSeconds,
    unitCount,
    unitDurations: Object.freeze(unitDurations),
    preferredUnit: preferred,
    productEntryIndex,
    batchCount: Math.ceil(unitCount / 10)
  });
}

module.exports = {
  batchRanges,
  durationBounds,
  durationContract,
  normalizeTargetDurationSeconds,
  planFilmSchedule,
  planShotDurations
};
