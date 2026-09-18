"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION,
  promptReviewSettingsFingerprint,
  promptReviewSourceFingerprint
} = require("../app/workbench-workflow");

test("editing the Chinese review copy recompiles and stores the English execution prompt", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-bilingual-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("双语提示词确认", { engine: "seedance", mode: "storyboard_sheet" });
  const project = store.getProject(created.id);
  project.characters = [{ id: "C01", name: "林婉", promptOverrides: {} }];
  project.promptReview = {
    version: PROMPT_REVIEW_BUNDLE_VERSION,
    status: "ready",
    productionRevision: String(project.productionRevision || ""),
    generatedAt: new Date().toISOString(),
    counts: { characters: 1, scenes: 0, objects: 0, assets: 1, storyboards: 0, videos: 0, confirmed: 0, total: 1 },
    items: [{
      id: "character:C01:character_sheet",
      group: "characters",
      entityType: "character",
      entityId: "C01",
      stage: "character_sheet",
      label: "林婉 · 人物四视图",
      prompt: "A four-view identity sheet for Lin Wan in a dark coat.",
      displayPrompt: "林婉深色外套人物四视图，身份完全一致。",
      language: "en",
      executionLanguage: "en",
      displayLanguage: "zh-CN",
      translationStatus: "translated",
      mode: "system",
      status: "pending",
      confirmedAt: ""
    }]
  };
  project.automation = { status: "awaiting_prompt_review", stage: "prompt_review" };
  project.promptReview.sourceFingerprint = promptReviewSourceFingerprint(project);
  project.promptReview.settingsFingerprint = promptReviewSettingsFingerprint(store.getSettings());
  store.saveProject(project);

  const calls = [];
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async (_config, messages) => {
      calls.push(messages);
      return { translation: "A complete four-view identity sheet for Lin Wan wearing a dark blue coat; preserve the same face in every view." };
    }
  });
  const editedChinese = "林婉改穿深蓝外套；四个视图必须保持同一张脸和同一身份。";
  const approved = await workflow.confirmPromptReviewItem(created.id, "character:C01:character_sheet", editedChinese);
  const item = approved.promptReview.items[0];
  assert.equal(calls.length, 1);
  assert.equal(approved.promptReview.status, "approved");
  assert.equal(item.displayPrompt, editedChinese);
  assert.match(item.prompt, /dark blue coat/);
  assert.equal(approved.characters[0].promptOverrides.character_sheet.manual, item.prompt);
  assert.equal(approved.characters[0].promptOverrides.character_sheet.mode, "manual");
  assert.doesNotMatch(approved.characters[0].promptOverrides.character_sheet.manual, /改穿/);
});

test("unchanged English-backed review item reuses its approved execution prompt without a model call", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-bilingual-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("双语提示词无改动", { engine: "seedance", mode: "storyboard_sheet" });
  const project = store.getProject(created.id);
  project.shots = [{ id: "S01", promptMode: "system", promptOverrides: {} }];
  project.promptReview = {
    version: PROMPT_REVIEW_BUNDLE_VERSION,
    status: "ready",
    productionRevision: String(project.productionRevision || ""),
    generatedAt: new Date().toISOString(),
    counts: { characters: 0, scenes: 0, objects: 0, assets: 0, storyboards: 0, videos: 1, confirmed: 0, total: 1 },
    items: [{ id: "shot:S01:shot_video", group: "videos", entityType: "shot", entityId: "S01", stage: "shot_video", label: "镜头1", prompt: "Keep the camera steady.", displayPrompt: "保持镜头稳定。", language: "en", executionLanguage: "en", displayLanguage: "zh-CN", translationStatus: "translated", mode: "system", status: "pending", confirmedAt: "" }]
  };
  project.automation = { status: "awaiting_prompt_review", stage: "prompt_review" };
  project.promptReview.sourceFingerprint = promptReviewSourceFingerprint(project);
  project.promptReview.settingsFingerprint = promptReviewSettingsFingerprint(store.getSettings());
  store.saveProject(project);
  let translationCalls = 0;
  let auditCalls = 0;
  const workflow = new WorkbenchWorkflow({
    store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root,
    textGenerator: async (_config, _messages, options) => {
      // confirmAllPromptReview legitimately re-audits any item the caller
      // edited (agentStage "review"; it is the third callback argument, not
      // part of the provider config). This case is about the *translation*
      // layer: an unchanged Chinese review copy must not be re-translated, so
      // only count calls that are actually translation work.
      if (String(options?.agentStage || "") === "review") auditCalls += 1;
      else translationCalls += 1;
      return { translation: "unexpected" };
    }
  });
  const approved = await workflow.confirmAllPromptReview(created.id, [{ id: "shot:S01:shot_video", prompt: "保持镜头稳定。" }]);
  assert.equal(translationCalls, 0);
  assert.equal(approved.shots[0].manualVideoPrompt || "", "");
  assert.equal(approved.shots[0].systemVideoPrompt, "Keep the camera steady.");
  // The edited item is still audited; the reuse guarantee is about not
  // re-translating the already-approved English execution prompt.
  assert.equal(auditCalls, 1);
});
