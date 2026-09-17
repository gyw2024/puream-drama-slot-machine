"use strict";
// T16: 下一步按钮与引导修复（§12.2）——静态源码合同。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const guide = read("app/renderer/workbench.js");

test("引导不再代替用户点击真实按钮（含付费操作）", () => {
  assert.doesNotMatch(guide, /setTimeout\(\s*\(\)\s*=>\s*liveTarget\.click/, "禁止 setTimeout 自动点击引导目标");
  const goBlock = guide.slice(guide.indexOf('$("#goNextAction")?.addEventListener'), guide.indexOf("function renderAll"));
  assert.ok(goBlock.length > 0 && goBlock.length < 2000, "goNextAction 处理器应保持独立可审");
  assert.doesNotMatch(goBlock, /\.click\(\s*\)/, "带我去操作处理器内不得调用 click()");
  assert.match(goBlock, /scrollIntoView/);
  assert.match(goBlock, /focus\(/);
  assert.match(goBlock, /switchStage\(/, "只允许切换到对应 tab");
});

test("引导目标必须通过可见性与可用性校验", () => {
  assert.match(guide, /function guideTargetVisible\(/);
  const check = guide.slice(guide.indexOf("function guideTargetVisible("), guide.indexOf("function guideTargetVisible(") + 700);
  assert.match(check, /disabled/);
  assert.match(check, /hidden/);
  assert.match(check, /aria-hidden/);
  assert.match(check, /display === "none"/);
  assert.match(check, /visibility === "hidden"/);
  assert.match(check, /parentElement/, "必须检查祖先隐藏");
});

test("弹窗打开时暂停背景高亮；找不到目标只给文字导航", () => {
  assert.match(guide, /dialog\[open\]|role='dialog'\]\[aria-modal='true'/, "必须识别打开中的弹窗");
  assert.match(guide, /openModal\.contains\(node\)/, "弹窗打开时只允许弹窗内目标");
  const block = guide.slice(guide.indexOf("function renderNextActionGuide"), guide.indexOf("function renderAll"));
  assert.match(block, /target \? `<button/, "无可见目标时不得渲染跳转按钮（纯文字导航）");
});

test("prefers-reduced-motion 下关闭动效", () => {
  assert.match(guide, /prefers-reduced-motion: reduce/);
  const css = read("app/renderer/workbench.css");
  assert.match(css, /prefers-reduced-motion:reduce\)\s*\{\s*\.guided-next-action\s*\{\s*animation:none/, "CSS 必须在 reduced-motion 下关闭动画");
});

test("渲染端统一消费 read-model（T15+T16 汇合点）", () => {
  assert.match(guide, /window\.ProductionView\?\.buildProductionView/, "workbench 必须消费统一视图");
  assert.match(read("app/renderer/simple-mode.js"), /window\.ProductionView\?\.buildProductionView/, "simple-mode 必须消费统一视图");
});
