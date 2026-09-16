"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadMaskFunction() {
  const source = fs.readFileSync(path.resolve(__dirname, "../app/renderer/workbench.js"), "utf8");
  const start = source.indexOf("function maskSpecificModelText(value) {");
  const end = source.indexOf("\nfunction escapePublicText", start);
  assert.ok(start >= 0 && end > start, "maskSpecificModelText must remain extractable for its idempotency contract");
  return vm.runInNewContext(`(${source.slice(start, end)})`);
}

test("productized cloud-video labels remain byte-stable across repeated renderer passes", () => {
  const mask = loadMaskFunction();
  const once = mask("资产直投 H3（无分镜图）与纯梦 H3 视频算力");
  let repeated = once;
  for (let index = 0; index < 100; index += 1) repeated = mask(repeated);
  assert.equal(repeated, once);
  assert.equal((repeated.match(/纯梦云端视频/g) || []).length, 2);
  assert.doesNotMatch(repeated, /(?:纯梦\s+){2,}H3/);
});

test("retired upstream branding is masked once without multiplying the product name", () => {
  const mask = loadMaskFunction();
  for (const input of ["hailuo h3", "海螺 H3", "minimax-h3", "puream-hailuo-h3", "H3"]) {
    const result = mask(input);
    assert.equal(result, "纯梦云端视频");
    assert.equal(mask(result), result);
  }
});

test("ordinary connection labels are not mistaken for network failures", () => {
  const mask = loadMaskFunction();
  for (const label of ["连接方式", "网络设置", "MCP 连接配置"]) {
    assert.equal(mask(label), label);
  }
  assert.equal(mask("连接超时"), "网络短暂中断，软件会从原任务断点自动恢复，不会重复创建付费任务");
  assert.equal(mask("network error"), "网络短暂中断，软件会从原任务断点自动恢复，不会重复创建付费任务");
});
