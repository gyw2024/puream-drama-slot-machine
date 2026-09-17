"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MATRIX, matrixGlobalPrompt, matrixRuntimeVideoPromptForProject } = require("../app/production-mode-matrix");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");

test("every production mode inherits entrance, clean-onset and actor-held-product prevention contracts", () => {
  for (const entry of Object.values(MATRIX)) {
    const global = matrixGlobalPrompt("cloud", entry.mode);
    const runtime = matrixRuntimeVideoPromptForProject({ generation: { mode: entry.mode } });
    assert.match(global, /0\.30\/0\.35秒/);
    assert.match(global, /可见入场/);
    assert.match(global, /具名人物/);
    assert.match(runtime, /lip smack/);
    assert.match(runtime, /continuous authored support or surface contact/);
  }
});

test("asset-reference prompts fail closed before submission when the visible speaker identity is not bound", () => {
  assert.throws(() => buildApprovedHailuoPrompt({
    project: { generation: { mode: "asset_direct" }, characters: [{ id: "C01", name: "甲" }, { id: "C02", name: "乙" }] },
    shot: { id: "S01", duration: 6, characterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"] },
    references: { promptMode: "asset_direct", hailuoApiMode: "reference_to_video", images: ["c02.png"], imageRoles: [{ type: "character", entityId: "C02" }], audios: [] },
    dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "你终于来了。", onScreen: true }]
  }), error => error?.code === "HAILUO_CHARACTER_REFERENCE_BIJECTION_FAILED" && error.missingVisibleSpeakerReferences.includes("C01"));
});

test("a globally off-screen-only voice never requires a character identity image", () => {
  assert.doesNotThrow(() => buildApprovedHailuoPrompt({
    project: {
      generation: { mode: "production_package" },
      characters: [
        { id: "C01", name: "Listener" },
        { id: "C05", name: "Caller", offscreenOnly: true, assetRequired: false }
      ]
    },
    shot: { id: "S15", duration: 12, characterIds: ["C01"], visibleCharacterIds: ["C01"] },
    references: {
      promptMode: "production_package",
      hailuoApiMode: "reference_to_video",
      images: ["c01.png"],
      imageRoles: [{ type: "character", entityId: "C01" }],
      audios: []
    },
    dialogueTurns: [{ speakerId: "C05", listenerIds: ["C01"], text: "电话里的一句画外音。", onScreen: true }]
  }));
});
