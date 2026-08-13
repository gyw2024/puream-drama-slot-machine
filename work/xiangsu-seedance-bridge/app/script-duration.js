"use strict";

const { durationContract, normalizeTargetDurationSeconds } = require("./duration-contract");

const FAST_PACE = /飞快|急促|语速加快|抢话|连珠炮|快速|激动地说/;
const SLOW_PACE = /缓慢|一字一顿|哽咽|结巴|迟疑|颤抖|虚弱|低声|耳语|停顿/;
const LONG_BEAT = /长久沉默|沉默良久|停顿良久|愣住|僵住|泪流|痛哭|跪下|转身离开|走到|拿起|递出|放下|推开门|关上门|拥抱/;
const SHORT_BEAT = /停顿|沉默|吸气|呼气|叹气|哽咽|抬头|低头|看向|回头|点头|摇头|皱眉|冷笑|苦笑|擦泪|握紧|松手/;

function spokenUnitCount(value = "") {
  const source = String(value || "");
  const cjk = (source.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (source.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + words * 1.6;
}

function punctuationPauseSeconds(value = "") {
  const source = String(value || "");
  const commas = (source.match(/[，、,；;]/g) || []).length;
  const terminals = (source.match(/[。！？!?]/g) || []).length;
  const ellipses = (source.match(/……|\.{3,}|…/g) || []).length;
  const dashes = (source.match(/——|—/g) || []).length;
  return commas * 0.12 + terminals * 0.24 + ellipses * 0.48 + dashes * 0.28;
}

function performanceBeatSeconds(tone = "") {
  const source = String(tone || "");
  if (!source) return 0.18;
  let seconds = 0.22;
  if (SHORT_BEAT.test(source)) seconds += 0.42;
  if (LONG_BEAT.test(source)) seconds += 0.75;
  if (/大喊|吼|声嘶力竭|爆发|痛哭/.test(source)) seconds += 0.22;
  return Math.min(1.8, seconds);
}

function estimateSpokenTurnSeconds(turn = {}) {
  const text = String(turn.text || turn.spokenText || "").trim();
  const tone = [turn.tone, turn.sourceTone, turn.delivery, turn.emotion, turn.body].filter(Boolean).join("；");
  const paceMultiplier = FAST_PACE.test(tone) ? 1.2 : SLOW_PACE.test(tone) ? 0.78 : 1;
  const speechSeconds = spokenUnitCount(text) / (3.7 * paceMultiplier);
  const total = speechSeconds + punctuationPauseSeconds(text) + performanceBeatSeconds(tone) + 0.16;
  return Number(Math.max(0.85, total).toFixed(3));
}

function estimateFallbackNarrationSeconds(script = "") {
  const source = String(script || "").trim();
  if (!source) return 0;
  const spoken = spokenUnitCount(source) / 3.7;
  const lineBeats = Math.max(0, source.split(/\r?\n/).filter(line => line.trim()).length - 1) * 0.18;
  return spoken + punctuationPauseSeconds(source) + lineBeats;
}

function representableTargetSeconds(rawSeconds, providerKind = "", options = {}) {
  const contract = durationContract(providerKind, options);
  const min = Number(contract.min) || 5;
  let target = Math.max(min, Math.round(Number(rawSeconds) || min));
  if (Array.isArray(contract.allowed) && contract.allowed.length) {
    const allowed = [...new Set(contract.allowed.map(Number).filter(Number.isFinite))];
    const candidates = [];
    const allowedMin = Math.min(...allowed);
    const allowedMax = Math.max(...allowed);
    // Search only counts whose possible sums are close to the requested total.
    // This remains bounded per request even when the uploaded script is hours long.
    const minCount = Math.max(1, Math.floor((target - allowedMax) / allowedMax));
    const maxCount = Math.max(minCount, Math.ceil((target + allowedMax) / allowedMin));
    for (let count = minCount; count <= maxCount; count += 1) {
      const low = Math.min(...allowed) * count;
      const high = Math.max(...allowed) * count;
      if (target >= low && target <= high) {
        for (let value = low; value <= high; value += 1) {
          if (value % 2 === 0 || allowed.some(item => item % 2 !== 0)) candidates.push(value);
        }
      }
      if (low > target + allowedMax) break;
    }
    if (candidates.length) target = candidates.sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right)[0];
    else target = normalizeTargetDurationSeconds(target, contract);
  }
  return target;
}

function explicitShotDurationTarget(shots = [], providerKind = "", options = {}) {
  const source = Array.isArray(shots) ? shots : [];
  if (!source.length || source.some(shot => !Number.isFinite(Number(shot?.duration)) || Number(shot.duration) <= 0)) return null;
  const contract = durationContract(providerKind, options);
  const durations = source.map(shot => normalizeTargetDurationSeconds(Number(shot.duration), contract));
  return {
    targetSeconds: durations.reduce((sum, value) => sum + value, 0),
    requestedDurations: source.map(shot => Number(shot.duration)),
    normalizedDurations: durations
  };
}

function estimateUploadedScriptDuration(script, dialogueLedger = [], providerKind = "", options = {}) {
  const ledger = Array.isArray(dialogueLedger) ? dialogueLedger : [];
  const turnSeconds = ledger.map(estimateSpokenTurnSeconds);
  const spokenSeconds = turnSeconds.reduce((sum, value) => sum + value, 0);
  const transitionSeconds = ledger.length
    ? Math.max(1.2, Math.min(18, 1.2 + Math.max(0, ledger.length - 1) * 0.24))
    : 0;
  const fallbackSeconds = ledger.length ? 0 : estimateFallbackNarrationSeconds(script);
  const estimatedSeconds = Math.max(0, spokenSeconds + transitionSeconds + fallbackSeconds);
  const targetSeconds = representableTargetSeconds(estimatedSeconds, providerKind, options);
  return {
    mode: "uploaded-script-adaptive",
    targetSeconds,
    estimatedSeconds: Number(estimatedSeconds.toFixed(3)),
    dialogueTurns: ledger.length,
    spokenSeconds: Number(spokenSeconds.toFixed(3)),
    transitionSeconds: Number(transitionSeconds.toFixed(3)),
    turnSeconds
  };
}

module.exports = {
  estimateSpokenTurnSeconds,
  estimateUploadedScriptDuration,
  explicitShotDurationTarget,
  performanceBeatSeconds,
  punctuationPauseSeconds,
  representableTargetSeconds,
  spokenUnitCount
};
