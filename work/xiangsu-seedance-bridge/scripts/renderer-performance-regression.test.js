"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { configureRendererAcceleration, recordGpuCrash } = require("../app/rendering-policy");

function fakeApp(root) {
  return {
    disabled: false,
    getPath: name => name === "userData" ? root : "",
    disableHardwareAcceleration() { this.disabled = true; }
  };
}

test("image-heavy workbench uses hardware composition by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-renderer-hardware-"));
  try {
    const app = fakeApp(root);
    const selected = configureRendererAcceleration(app, { env: {}, now: 1000 });
    assert.equal(selected.mode, "hardware");
    assert.equal(app.disabled, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a GPU crash creates a bounded software fallback for the next launch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-renderer-fallback-"));
  try {
    const firstApp = fakeApp(root);
    const first = configureRendererAcceleration(firstApp, { env: {}, now: 1000 });
    recordGpuCrash(first, { reason: "crashed", exitCode: 34 }, { now: 2000, fallbackMs: 60_000 });
    const nextApp = fakeApp(root);
    const next = configureRendererAcceleration(nextApp, { env: {}, now: 3000 });
    assert.equal(next.mode, "software");
    assert.equal(nextApp.disabled, true);
    assert.equal(next.reason, "gpu-crashed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("idle workbench avoids permanent decorative animation and hot polling", () => {
  const root = path.resolve(__dirname, "..");
  const css = fs.readFileSync(path.join(root, "app", "renderer", "workbench.css"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "app", "renderer", "workbench.js"), "utf8");
  const simple = fs.readFileSync(path.join(root, "app", "renderer", "simple-mode.js"), "utf8");
  assert.doesNotMatch(css.match(/\.draw-button\s*\{[^}]+\}/)?.[0] || "", /animation\s*:/);
  assert.doesNotMatch(css.match(/\.guided-next-action\s*\{[^}]+\}/)?.[0] || "", /animation\s*:/);
  assert.match(workbench, /backgroundLastWalletAt >= 60_000/);
  assert.match(workbench, /queryableVideo \? 6_000 : 45_000/);
  assert.match(simple, /isActive\(\) \? 2500 : document\.hidden \? 30_000 : 15_000/);
});

test("packaged integrity checks reuse an unchanged file digest", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "integrity-guard.js"), "utf8");
  assert.match(source, /state\.metadata\.get\(filePath\) === metadata\)[\s\S]*?continue/);
});
