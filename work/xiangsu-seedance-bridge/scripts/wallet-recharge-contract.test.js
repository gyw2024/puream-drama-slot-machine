"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("desktop wallet uses the official website as the only authority", () => {
  const license = read("app/license-gate.js");
  const preload = read("app/preload.js");
  const main = read("app/main.js");
  assert.match(license, /https:\/\/puream\.cn/);
  assert.match(license, /\/api\/desktop\/account\/balance/);
  assert.match(license, /\/api\/desktop\/payments\/create/);
  assert.match(license, /puream-desktop:\$\{activationCode\}/);
  assert.match(preload, /walletStatus/);
  assert.match(preload, /createRechargeOrder/);
  assert.match(main, /license:payment-status/);
});

test("balance and recharge controls are globally available in the top bar", () => {
  const html = read("app/renderer/workbench.html");
  const renderer = read("app/renderer/workbench.js");
  assert.match(html, /id="walletShortcut"/);
  assert.match(html, /id="rechargeDialog"/);
  assert.match(renderer, /refreshWallet\(true\)/);
  assert.match(renderer, /rechargeOrderStatus/);
  assert.match(renderer, /order\.status === "PAID"/);
});

test("desktop recharge starts at 50 yuan while explicitly preserving the website 30-yuan policy", () => {
  const license = read("app/license-gate.js");
  const html = read("app/renderer/workbench.html");
  const renderer = read("app/renderer/workbench.js");
  assert.match(license, /rechargeCents < 5000/);
  assert.match(license, /软件内充值金额最低 50 元；官网充值仍为 30 元起/);
  assert.match(html, /id="rechargeAmount"[^>]+min="50"/);
  assert.match(html, /软件内最低充值 50 元；纯梦官网充值仍为 30 元起/);
  assert.match(renderer, /amountYuan < 50/);
  assert.doesNotMatch(renderer, /amountYuan < 30/);
});
