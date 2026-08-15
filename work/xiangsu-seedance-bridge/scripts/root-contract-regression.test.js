"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.join(__dirname, "..");
const {
  buildLocalTopicOptions,
  splitUploadedScriptSections,
  criticalTextOverlayFilters,
  finalCriticalTextOverlayFilter,
  h3ExactStitchFilter
} = require(path.join(repo, "app", "workbench-workflow"));

test("each explicit local topic refresh replaces the previous ten titles", () => {
  const first = buildLocalTopicOptions({}, 1);
  const second = buildLocalTopicOptions({}, 2);
  const third = buildLocalTopicOptions({}, 3);
  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.equal(new Set(first.map(item => item.title)).size, 10);
  assert.equal(first.some(item => second.some(next => next.title === item.title)), false);
  assert.equal(second.some(item => third.some(next => next.title === item.title)), false);
});

test("uploaded character bios are context only and never enter the dramatic timeline", () => {
  const source = `# 七分钟剧本\n## 人物介绍\n- 李桂兰：63岁，母亲。\n## 故事简介\n母女因账本产生误会。\n## S01｜0-10秒｜调解室\n李桂兰：你先看日期。\n## S02｜10-20秒｜调解室\n周敏：我会一笔笔核对。`;
  const split = splitUploadedScriptSections(source);
  assert.match(split.metadata, /人物介绍/);
  assert.match(split.metadata, /故事简介/);
  assert.doesNotMatch(split.dramaticBody, /人物介绍|故事简介/);
  assert.match(split.dramaticBody, /S01/);
  assert.match(split.dramaticBody, /S02/);
});

test("final stitch never renders authored text overlays", () => {
  const shot = { duration: 10, criticalOnScreenText: [{ text: "人物介绍", start: 0, end: 3 }] };
  assert.deepEqual(criticalTextOverlayFilters(shot), []);
  assert.equal(finalCriticalTextOverlayFilter([shot]), "");
  assert.doesNotMatch(h3ExactStitchFilter([shot], 10, 24), /drawtext|人物介绍/);
});

test("installer and durable storage are user-selectable without deleting old data", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
  const main = fs.readFileSync(path.join(repo, "app", "main.js"), "utf8");
  const relocation = fs.readFileSync(path.join(repo, "app", "foundry", "storage-relocation.js"), "utf8");
  assert.match(main, /workbench:choose-storage-location/);
  assert.match(main, /纯梦短剧老虎机数据/);
  assert.match(main, /fs\.cpSync/);
  assert.match(main, /relocateCopiedWorkbenchData/);
  assert.match(main, /criticalSkippedJson/);
  assert.match(relocation, /kernel\.runtime\.checkpoint/);
  assert.match(relocation, /rebaseString/);
  assert.doesNotMatch(main.slice(main.indexOf('ipcMain.handle("workbench:choose-storage-location"'), main.indexOf('ipcMain.handle("workbench:save-settings"')), /rmSync|unlinkSync/);
});

test("all three downloadable examples are complete seven-minute scripts", () => {
  const renderer = fs.readFileSync(path.join(repo, "app", "renderer", "workbench.js"), "utf8");
  assert.match(renderer, /420秒（42个10秒生产单元）/);
  assert.match(renderer, /Array\.from|sevenMinuteExampleUnits/);
  assert.match(renderer, /production: buildSevenMinuteScriptExample\("production"\)/);
  assert.match(renderer, /dialogue: buildSevenMinuteScriptExample\("dialogue"\)/);
  assert.match(renderer, /timed_storyboard: buildSevenMinuteScriptExample\("timed_storyboard"\)/);
});

test("character assets use one exact solid background contract", () => {
  const prompts = fs.readFileSync(path.join(repo, "app", "prompt-library.js"), "utf8");
  const workflow = fs.readFileSync(path.join(repo, "app", "workbench-workflow.js"), "utf8");
  for (const source of [prompts, workflow]) {
    assert.match(source, /#E9E9E9/);
    assert.match(source, /禁止渐变、烟雾、云纹/);
  }
  assert.match(prompts, /正面、左侧 90 度、右侧 90 度、背面/);
  assert.match(prompts, /禁止肖像大头、半身插图/);
  assert.match(workflow, /画面四边不得出现黑色填充/);
});
