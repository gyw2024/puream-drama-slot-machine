"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createVideoJobRecoveryScheduler } = require("../app/video-job-recovery");

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeoutImpl(callback, delay) {
      const handle = { id: ++id, delay, unref() {} };
      pending.set(handle.id, { handle, callback });
      return handle;
    },
    clearTimeoutImpl(handle) {
      pending.delete(handle?.id);
    },
    next() {
      const entry = [...pending.values()][0];
      if (!entry) return null;
      pending.delete(entry.handle.id);
      return entry;
    },
    count: () => pending.size
  };
}

test("main-process video recovery starts without a renderer and polls active jobs faster", async () => {
  const timers = fakeTimers();
  let active = true;
  let reconciles = 0;
  const scheduler = createVideoJobRecoveryScheduler({
    ...timers,
    initialDelayMs: 0,
    activeIntervalMs: 6_000,
    idleIntervalMs: 45_000,
    reconcile: async () => { reconciles += 1; return { ok: true }; },
    hasActiveJobs: () => active
  });

  scheduler.start();
  const initial = timers.next();
  assert.equal(initial.handle.delay, 0);
  await initial.callback();
  assert.equal(reconciles, 1);
  assert.equal(scheduler.state().lastDelayMs, 6_000);

  active = false;
  const activeTick = timers.next();
  await activeTick.callback();
  assert.equal(reconciles, 2);
  assert.equal(scheduler.state().lastDelayMs, 45_000);
  scheduler.stop();
  assert.equal(timers.count(), 0);
});

test("manual and scheduled recovery share one in-flight query", async () => {
  const timers = fakeTimers();
  let release;
  let reconciles = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const scheduler = createVideoJobRecoveryScheduler({
    ...timers,
    initialDelayMs: 1,
    reconcile: async () => { reconciles += 1; await gate; return { ok: true }; },
    hasActiveJobs: () => true
  });

  scheduler.start();
  const first = scheduler.runNow("renderer");
  const second = scheduler.runNow("background");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reconciles, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(reconciles, 1);
  assert.equal(scheduler.state().lastDelayMs, 6_000);
  scheduler.stop();
});

test("recovery errors are retried in the background and never create a second loop", async () => {
  const timers = fakeTimers();
  const errors = [];
  const scheduler = createVideoJobRecoveryScheduler({
    ...timers,
    initialDelayMs: 0,
    activeIntervalMs: 6_000,
    errorIntervalMs: 15_000,
    reconcile: async () => { throw Object.assign(new Error("temporary query failure"), { code: "QUERY_FAILED" }); },
    hasActiveJobs: () => true,
    onError: error => errors.push(error.code)
  });

  scheduler.start();
  const initial = timers.next();
  await initial.callback();
  assert.deepEqual(errors, ["QUERY_FAILED"]);
  assert.equal(scheduler.state().lastDelayMs, 15_000);
  assert.equal(timers.count(), 1);
  scheduler.stop();
});
