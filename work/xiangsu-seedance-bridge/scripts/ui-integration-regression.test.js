"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { defaultPromptTemplates } = require("../app/workbench-store");

const root = path.resolve(__dirname, "..");
const source = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

function functionSource(script, name) {
  const start = script.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = script.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === "{") depth += 1;
    else if (script[index] === "}" && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

test("every settings prompt has an exact key example and a non-generic module explanation", () => {
  const renderer = source("app/renderer/workbench.js");
  const sandbox = { promptLabels: {}, promptExampleSamples: {}, JSON };
  vm.createContext(sandbox);
  vm.runInContext(`${functionSource(renderer, "promptDefinitionForKey")}\n${functionSource(renderer, "promptExampleForKey")}\nthis.definition = promptDefinitionForKey; this.example = promptExampleForKey;`, sandbox);
  for (const key of Object.keys(defaultPromptTemplates())) {
    const definition = sandbox.definition(key);
    const example = JSON.parse(sandbox.example(key));
    assert.equal(definition.key, key);
    assert.notEqual(definition.module, "通用生产", `${key} needs a mapped production module`);
    for (const field of ["screen", "purpose", "input", "output"]) assert.ok(String(definition[field] || "").trim(), `${key}.${field} must explain its role`);
    assert.equal(example.promptKey, key);
    assert.equal(example.module, definition.module);
    assert.equal(example.screen, definition.screen);
    assert.equal(example.purpose, definition.purpose);
  }
  assert.equal(sandbox.definition("storyboardSheetVideo").module, "分镜视频");
  assert.equal(sandbox.definition("docxFusionShotPlan").module, "故事规划");
  assert.equal(sandbox.definition("referenceParityUnits").module, "剧本写作");
});

test("right inspector has the requested two-by-four summary and a larger run detail area", () => {
  const renderer = source("app/renderer/workbench.js");
  const html = source("app/renderer/workbench.html");
  const css = source("app/renderer/workbench.css");
  const labels = ["人物", "场景", "分镜", "视频", "文案费", "图片费", "视频费", "合计"];
  for (const label of labels) assert.match(renderer, new RegExp(`\\["${label}"`));
  assert.match(html, /id="runDetailSummary"/);
  assert.match(css, /\.progress-overview\s*\{[^}]*grid-template-columns:\s*repeat\(4/i);
  assert.match(css, /\.candidate-history\s*\{[^}]*min-height:\s*300px/i);
});

test("button help is attached to the control itself and visible exclamation dots are disabled", () => {
  const renderer = source("app/renderer/workbench.js");
  const css = source("app/renderer/workbench.css");
  const main = source("app/main.js");
  assert.match(renderer, /document\.querySelectorAll\("button"\)/);
  assert.match(renderer, /node\.dataset\.tooltip\s*=\s*tip/);
  assert.match(renderer, /closest\?\.\("\[data-tooltip\]"\)/);
  assert.match(css, /\.info-dot\s*\{\s*display:\s*none\s*!important/);
  assert.match(main, /document\.querySelector\('button\[data-tooltip\]'\)/);
  assert.doesNotMatch(main, /const firstHelp = document\.querySelector\('button \.info-dot'\)/);
});

test("all reusable media categories and direct voice binding are exposed globally", () => {
  const html = source("app/renderer/workbench.html");
  const renderer = source("app/renderer/workbench.js");
  const main = source("app/main.js");
  const store = source("app/workbench-store.js");
  for (const kind of ["character", "scene", "prop", "wardrobe", "product", "image", "video", "audio", "voice"]) {
    assert.match(html, new RegExp(`data-kind=["']${kind}["']`));
  }
  assert.match(renderer, /data-action="bind-voice-card"/);
  assert.match(main, /kind:\s*"voice"/);
  assert.match(store, /"character", "scene", "prop", "wardrobe", "product", "image", "video", "audio"/);
  assert.match(renderer, /人物、场景、道具、服装、商品、图片、视频、音频和音色均在本机全局保存/);
});

test("installed users can check, download, verify and launch an in-place update from the version button", () => {
  const html = source("app/renderer/workbench.html");
  const renderer = source("app/renderer/workbench.js");
  const preload = source("app/preload.js");
  const main = source("app/main.js");
  assert.match(html, /id="appVersionUpdate"/);
  assert.match(preload, /app:check-update/);
  assert.match(preload, /app:install-update/);
  assert.match(main, /https:\/\/puream\.cn\/api\/drama-slot\/version/);
  assert.match(main, /actualHash !== manifest\.sha256/);
  assert.match(main, /spawn\(ready\.installerPath, \["\/S"\]/);
  assert.match(renderer, /handleAppUpdateClick/);
  assert.match(renderer, /项目和全局资产不会删除/);
});
