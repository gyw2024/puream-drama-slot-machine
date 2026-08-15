"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  compactGeneratedSeedanceVideoPrompt
} = require("../app/workbench-workflow");

test("overlong generated video prompts are compacted before the 2000-character provider limit", () => {
  const project = {
    product: { name: "护膝", sellingPoints: "支撑膝关节" },
    characters: [
      { id: "C01", name: "林梅" },
      { id: "C02", name: "周建国" }
    ],
    scenes: [{ id: "SC01", name: "客厅", description: "傍晚暖光客厅" }]
  };
  const shot = {
    id: "S29",
    sceneId: "SC01",
    action: "林梅推门进来，把护膝放在桌上并直视周建国。",
    emotion: "压着怒火到坚定",
    performance: "林梅眼眶发红、手指发抖；周建国先躲闪再愣住",
    dialogueTurns: [
      {
        speakerId: "C01",
        listenerIds: ["C02"],
        sourceTone: "压着怒火、字字加重",
        text: "这不是钱的问题，是你从来没把我的疼当回事。",
        metadata: { body: "攥紧护膝后松手", listenerBeat: "周建国闭嘴并避开视线" }
      },
      {
        speakerId: "C02",
        listenerIds: ["C01"],
        sourceTone: "后悔、声音发紧",
        text: "我错了，这次我陪你把膝盖治好。",
        metadata: { body: "慢慢抬眼", listenerBeat: "林梅没有立刻原谅" }
      }
    ]
  };
  const overlong = "重复的系统约束。".repeat(500);
  const result = compactGeneratedSeedanceVideoPrompt(project, shot, {
    imageRoles: [{ type: "character", label: "林梅身份图" }, { type: "product", label: "护膝商品图" }],
    audios: [{ characterName: "林梅" }, { characterName: "周建国" }]
  }, "keyframe", overlong);

  assert.ok(result.length <= 1900, `expected <=1900 chars, got ${result.length}`);
  assert.match(result, /角色“林梅”面对周建国/);
  assert.match(result, /角色“周建国”面对林梅/);
  assert.match(result, /压着怒火、字字加重/);
  assert.match(result, /后悔、声音发紧/);
  assert.match(result, /这不是钱的问题，是你从来没把我的疼当回事。/);
  assert.match(result, /我错了，这次我陪你把膝盖治好。/);
  assert.match(result, /周建国闭嘴并避开视线/);
  assert.match(result, /林梅没有立刻原谅/);
});

test("the shot compiler applies compaction only to generated Seedance prompts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(source, /shotUsesManualVideoPrompt\(shot\)\s*\? rawCompiledPrompt\s*:\s*compactGeneratedSeedanceVideoPrompt/);
  assert.match(source, /const GENERATED_VIDEO_PROMPT_LIMIT = 1900/);
});
