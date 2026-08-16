"use strict";

// Production work has no wall-clock deadline. Zero is the public contract used
// by every provider adapter: an operation ends only after a terminal provider
// result, an explicit user cancellation, or a non-recoverable validation error.
const NO_TOTAL_DEADLINE_MS = 0;
const UNLIMITED_ATTEMPTS = 0;

function resolveAttemptLimit(value, fallback = 1) {
  const parsed = Number(value);
  if (parsed === UNLIMITED_ATTEMPTS) return Infinity;
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.floor(parsed));
  const fallbackValue = Number(fallback);
  if (fallbackValue === UNLIMITED_ATTEMPTS) return Infinity;
  return Math.max(1, Math.floor(fallbackValue) || 1);
}

function attemptLimitLabel(limit) {
  return Number.isFinite(limit) ? String(limit) : "不限";
}

function abortError(signal, message = "生产任务已取消") {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error(message), { code: "PROVIDER_REQUEST_ABORTED" });
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Number(milliseconds) || 0));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = {
  NO_TOTAL_DEADLINE_MS,
  UNLIMITED_ATTEMPTS,
  abortError,
  abortableDelay,
  attemptLimitLabel,
  resolveAttemptLimit
};
