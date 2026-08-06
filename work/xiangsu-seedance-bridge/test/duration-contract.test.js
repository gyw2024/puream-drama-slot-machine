"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  batchRanges,
  durationBounds,
  durationContract,
  normalizeTargetDurationSeconds,
  planShotDurations
} = require("../app/duration-contract");

test("puream-seedance allows 5-15 narrative units", () => {
  const contract = durationContract("puream-seedance");
  assert.equal(contract.min, 5);
  assert.equal(contract.max, 15);
  assert.equal(contract.fixed, false);
  assert.equal(normalizeTargetDurationSeconds(12, "puream-seedance"), 12);
  assert.equal(normalizeTargetDurationSeconds(3, "puream-seedance"), 5);
  assert.equal(normalizeTargetDurationSeconds(20, "puream-seedance"), 15);
});

test("hailuo H3 and local xiangsu keep their bounds", () => {
  assert.deepEqual(durationBounds("puream-hailuo-h3"), { min: 5, max: 15, preferred: 10, fixed: false });
  assert.equal(normalizeTargetDurationSeconds(10, "local-xiangsu"), 10);
  assert.equal(normalizeTargetDurationSeconds(15, "local-xiangsu"), 10);
});

test("grok and gemini character video durations stay fixed", () => {
  assert.equal(normalizeTargetDurationSeconds(10, "puream-grok"), 6);
  assert.equal(normalizeTargetDurationSeconds(10, "puream-gemini"), 4);
});

test("batchRanges and planShotDurations are deterministic", () => {
  assert.deepEqual(batchRanges(30, 10).map(item => item.count), [10, 10, 10]);
  const planned = planShotDurations([{ duration: 7 }, { duration: 99 }, {}], "puream-seedance", { defaultDuration: 10 });
  assert.deepEqual(planned, [7, 15, 10]);
});

test("planFilmSchedule sums exactly to target duration", () => {
  const { planFilmSchedule } = require("../app/duration-contract");
  const schedule = planFilmSchedule(300, "puream-seedance", { preferredUnit: 10 });
  assert.equal(schedule.totalSeconds, 300);
  assert.equal(schedule.unitCount, 30);
  assert.equal(schedule.unitDurations.reduce((a, b) => a + b, 0), 300);
  assert.equal(schedule.productEntryIndex, 19);
  const odd = planFilmSchedule(125, "puream-seedance", { preferredUnit: 10 });
  assert.equal(odd.unitDurations.reduce((a, b) => a + b, 0), 125);
});
