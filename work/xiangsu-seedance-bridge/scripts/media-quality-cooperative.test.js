"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { hashSimilarity, countRepeatedFrames } = require("../app/media-quality");
const { withLocalMediaSignal } = require("../app/local-media-context");
function hashes(count) {
  let value = 17;
  return Array.from({ length: count }, () => Array.from({ length: 64 }, () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return (value >>> 28).toString(16);
  }).join(""));
}

test("cooperative duplicate scan retains legacy results, including repeated nonadjacent frames", async () => {
  const input = hashes(90);
  input[30] = input[3]; input[80] = input[3]; input[7] = input[6];
  for (const fps of [1, 2, 4]) {
    const expected = input.filter((current, index) => input.some((other, j) => Math.abs(j-index) > Math.max(3, fps*3) && hashSimilarity(current, other) >= 0.984375)).length;
    assert.equal(await countRepeatedFrames(input, fps), expected);
  }
});

test("2400-frame film scan yields to the event loop and can be cancelled during JS statistics", async () => {
  const controller = new AbortController();
  const input = hashes(2400);
  const started = performance.now();
  let timerRan = false;
  const pending = withLocalMediaSignal(controller.signal, () => countRepeatedFrames(input, 4));
  const timer = setTimeout(() => { timerRan = true; controller.abort(); }, 20);
  try { await assert.rejects(pending, error => error.code === "LOCAL_MEDIA_CANCELLED"); }
  finally { clearTimeout(timer); }
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(timerRan, true);
  assert.ok(elapsedMs < 1000, `cancel handler was blocked for ${elapsedMs} ms`);
  console.log(JSON.stringify({ frames: 2400, cancelledAfterMs: elapsedMs }));
});
