"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultSettings } = require("../app/workbench-store");
const { parseSourceDialogueLedger } = require("../app/dialogue-parser");
const {
  WorkbenchWorkflow,
  dialogueRewriteNameMap,
  validateDialogueRewriteLines,
  renderDialogueRewriteScript
} = require("../app/workbench-workflow");

function projectFixture() {
  return {
    id: "dialogue-rewrite-project",
    title: "对白稿测试",
    status: "draft",
    currentStage: "script",
    productionRevision: "",
    productionPlan: { inputMode: "manual", executionMode: "step", scriptFormat: "production", scriptFormatConfirmed: false },
    generation: { engine: "hailuo-h3", mode: "keyframe", targetDurationSeconds: 300 },
    script: { raw: "", generationCheckpoint: null, analysisCheckpoint: null, generationLive: null },
    product: { name: "", description: "", sellingPoints: "" },
    characters: [],
    scenes: [],
    shots: [],
    candidates: [],
    jobs: [],
    activity: []
  };
}

function workflowFixture(project) {
  const store = {
    getProject: id => {
      assert.equal(id, project.id);
      return project;
    },
    saveProject: saved => {
      Object.assign(project, saved);
      return project;
    },
    getSettings: () => defaultSettings()
  };
  return new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: "" });
}

test("A/B dialogue names are reconstructed while explicit character names stay stable", () => {
  const ledger = parseSourceDialogueLedger("A：你把账本给我。\nB（压低声音）：现在还不是时候。\n王姨：门外有人。 ");
  const map = dialogueRewriteNameMap(ledger);
  assert.deepEqual(map.map(item => item.sourceName), ["A", "B", "王姨"]);
  assert.notEqual(map[0].newName, "A");
  assert.notEqual(map[1].newName, "B");
  assert.equal(map[2].newName, "王姨");
  assert.equal(new Set(map.map(item => item.newName)).size, 3);
});

test("light rewrite accepts close wording but rejects missing amounts and line reordering", () => {
  const ledger = parseSourceDialogueLedger("A：这30000元是给母亲治病的。\nB：我今天就把钱还给你。 ");
  const nameMap = dialogueRewriteNameMap(ledger);
  const accepted = validateDialogueRewriteLines(ledger, [
    { sourceId: "D001", dialogue: "这30000元，本来就是给母亲治病用的。", tone: "克制解释" },
    { sourceId: "D002", dialogue: "我今天就会把钱还给你。", tone: "坚定" }
  ], nameMap);
  assert.equal(accepted.length, 2);
  assert.match(accepted[0].rewrittenText, /30000元/);
  assert.throws(() => validateDialogueRewriteLines(ledger, [
    { sourceId: "D001", dialogue: "这笔钱我不要了。" },
    { sourceId: "D002", dialogue: "我今天就把钱还给你。" }
  ], nameMap), error => error.code === "DIALOGUE_REWRITE_SEMANTIC_DRIFT");
  assert.throws(() => validateDialogueRewriteLines(ledger, [
    { sourceId: "D002", dialogue: ledger[1].text },
    { sourceId: "D001", dialogue: ledger[0].text }
  ], nameMap), error => error.code === "DIALOGUE_REWRITE_ORDER_MISMATCH");
});

test("complete dialogue script keeps background anchors, order and lineage", () => {
  const raw = "【场景】旧客厅，雨夜。\nA（忍着火）：你为什么瞒着我？\nB（哽咽）：我只是不想拖累你。";
  const ledger = parseSourceDialogueLedger(raw);
  const nameMap = dialogueRewriteNameMap(ledger);
  const lines = validateDialogueRewriteLines(ledger, [
    { sourceId: "D001", dialogue: "你为什么一直瞒着我？", action: "攥紧账本" },
    { sourceId: "D002", dialogue: "我只是不想再拖累你。", action: "低下头" }
  ], nameMap);
  const script = renderDialogueRewriteScript(raw, ledger, lines, nameMap);
  assert.match(script, /旧客厅，雨夜/);
  assert.ok(script.indexOf(lines[0].rewrittenText) < script.indexOf(lines[1].rewrittenText));
  assert.match(script, /故事事实、事件顺序、人物关系、结局和商品出现节点保持不变/);
});

test("upstream rewrite failure preserves the original and never substitutes a local creative rewrite", async () => {
  const project = projectFixture();
  const workflow = workflowFixture(project);
  workflow.generateText = async () => { throw Object.assign(new Error("upstream unavailable"), { code: "UPSTREAM_NETWORK_ERROR" }); };
  const original = "A（焦急）：妈，你怎么一个人来了？\nB（喘着气）：我怕你又把药忘在家里。";
  await assert.rejects(
    workflow.rewriteDialogueScript(project.id, original, { track: false }),
    error => error?.code === "DIALOGUE_REWRITE_AGENT_RESULT_REQUIRED"
      && error?.agentRequired === true
      && error?.localCreativeFallbackUsed === false
  );
  assert.equal(project.script.raw, "");
  assert.equal(project.script.dialogueRewrite, undefined);
  assert.equal(project.currentStage, "script");
});

test("dialogue rewrite UI and IPC expose a direct non-destructive entry", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "app/renderer/workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "app/renderer/workbench.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "app/preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "app/main.js"), "utf8");
  assert.match(html, /id="importDialogueRewrite"/);
  assert.match(renderer, /rewriteDialogueScript/);
  assert.match(renderer, /故事事实、事件顺序、人物关系、结局、数字和商品出现节点保持不变/);
  assert.match(preload, /workbench:rewrite-dialogue-script/);
  assert.match(main, /workbench:rewrite-dialogue-script/);
});
