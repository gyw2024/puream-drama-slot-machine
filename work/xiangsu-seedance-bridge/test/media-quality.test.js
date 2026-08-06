"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  audibleIntervalsFromSilence,
  selectVoiceExtractPlan
} = require("../app/media-quality");

test("voice extract plans keep only audible segments and can concatenate short bursts", () => {
  const audible = audibleIntervalsFromSilence([
    { start: 0, end: 1.2, duration: 1.2 },
    { start: 2.8, end: 4.6, duration: 1.8 },
    { start: 5.4, end: 6, duration: 0.6 }
  ], 6);
  assert.deepEqual(audible.map(item => [item.start, item.end]), [[1.2, 2.8], [4.6, 5.4]]);
  const single = selectVoiceExtractPlan([
    { start: 1.0, end: 4.2, duration: 3.2 },
    { start: 4.8, end: 5.3, duration: 0.5 }
  ]);
  assert.equal(single.mode, "single");
  assert.equal(single.start, 1);
  assert.equal(single.duration, 3.2);
  const concat = selectVoiceExtractPlan([
    { start: 0.4, end: 1.1, duration: 0.7 },
    { start: 2.0, end: 2.8, duration: 0.8 },
    { start: 3.5, end: 4.2, duration: 0.7 }
  ]);
  assert.equal(concat.mode, "concat");
  assert.ok(concat.duration >= 1.5);
  assert.equal(concat.segments.length, 3);
  assert.equal(selectVoiceExtractPlan([{ start: 1, end: 1.4, duration: 0.4 }]), null);
});
