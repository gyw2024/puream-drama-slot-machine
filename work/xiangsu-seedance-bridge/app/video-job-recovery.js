"use strict";

function createVideoJobRecoveryScheduler(options = {}) {
  if (typeof options.reconcile !== "function") {
    throw new TypeError("video job recovery requires a reconcile function");
  }
  const reconcile = options.reconcile;
  const hasActiveJobs = typeof options.hasActiveJobs === "function" ? options.hasActiveJobs : () => false;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs) || 0);
  const activeIntervalMs = Math.max(1, Number(options.activeIntervalMs) || 6_000);
  const idleIntervalMs = Math.max(activeIntervalMs, Number(options.idleIntervalMs) || 45_000);
  const errorIntervalMs = Math.max(activeIntervalMs, Number(options.errorIntervalMs) || 15_000);

  let timer = null;
  let running = null;
  let stopped = true;
  let lastDelayMs = null;

  function clearScheduled() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(delayMs) {
    if (stopped) return;
    clearScheduled();
    lastDelayMs = Math.max(0, Number(delayMs) || 0);
    timer = setTimer(() => {
      timer = null;
      return run("scheduled").catch(() => {});
    }, lastDelayMs);
    timer?.unref?.();
  }

  async function run(reason = "manual") {
    clearScheduled();
    if (running) return running;
    running = (async () => {
      let failed = false;
      try {
        return await reconcile(reason);
      } catch (error) {
        failed = true;
        try { onError(error, reason); } catch {}
        throw error;
      } finally {
        if (!stopped) {
          let nextDelay = errorIntervalMs;
          if (!failed) {
            try { nextDelay = hasActiveJobs() ? activeIntervalMs : idleIntervalMs; }
            catch { nextDelay = errorIntervalMs; }
          }
          schedule(nextDelay);
        }
      }
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    schedule(initialDelayMs);
  }

  function stop() {
    stopped = true;
    clearScheduled();
  }

  return {
    start,
    stop,
    runNow: reason => run(reason || "manual"),
    state: () => ({ stopped, running: Boolean(running), scheduled: timer !== null, lastDelayMs })
  };
}

module.exports = { createVideoJobRecoveryScheduler };
