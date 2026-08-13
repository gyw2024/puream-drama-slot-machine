"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  WorkbenchStore,
  defaultProject
} = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  assertAiScriptFormatConfirmed,
  ideaSignature,
  renderDialogueScript,
  scriptFormatDirective,
  viewerComprehensionPriorityDirective
} = require("../app/workbench-workflow");

const root = path.resolve(__dirname, "..");
const source = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

test("new AI projects require an explicit script format while manual projects bypass the prompt contract", () => {
  const aiProject = defaultProject("AI项目");
  assert.equal(aiProject.productionPlan.scriptFormat, "production");
  assert.equal(aiProject.productionPlan.scriptFormatConfirmed, false);
  assert.throws(() => assertAiScriptFormatConfirmed(aiProject), error => error.code === "SCRIPT_FORMAT_SELECTION_REQUIRED");

  const manualProject = defaultProject("上传项目", { inputMode: "manual" });
  assert.equal(assertAiScriptFormatConfirmed(manualProject), "production");
});

test("legacy populated projects migrate to confirmed original format without interrupting history", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-script-format-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const store = new WorkbenchStore(temp);
  const project = store.createProject("旧项目");
  const diskPath = store.projectPath(project.id);
  const legacy = JSON.parse(fs.readFileSync(diskPath, "utf8"));
  legacy.version = 9;
  legacy.productionPlan = { executionMode: "step", inputMode: "ai" };
  legacy.script.raw = "旧版本已经写好的完整剧本";
  fs.writeFileSync(diskPath, JSON.stringify(legacy, null, 2));

  const migrated = store.getProject(project.id);
  assert.equal(migrated.version, 11);
  assert.equal(migrated.productionPlan.scriptFormat, "production");
  assert.equal(migrated.productionPlan.scriptFormatConfirmed, true);
  assert.equal(migrated.script.raw, legacy.script.raw);
});

test("script format is part of the checkpoint signature", () => {
  const project = defaultProject("签名");
  project.ideation.selectedTopicId = "topic-1";
  project.product = { name: "商品", sellingPoints: "真实卖点", imagePath: "D:/product.png" };
  const production = ideaSignature(project);
  project.productionPlan.scriptFormat = "dialogue";
  const dialogue = ideaSignature(project);
  assert.notEqual(dialogue, production);
  assert.match(dialogue, /dialogue/);
});

test("backend refuses an unconfirmed AI format before any provider or settings access", async () => {
  let settingsReads = 0;
  const project = defaultProject("未确认");
  const workflow = new WorkbenchWorkflow({
    store: {
      getProject: () => structuredClone(project),
      getSettings: () => { settingsReads += 1; return {}; }
    },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: ""
  });
  await assert.rejects(
    workflow.generateCompleteScript(project.id, { track: false }),
    error => error.code === "SCRIPT_FORMAT_SELECTION_REQUIRED"
  );
  assert.equal(settingsReads, 0);
});

test("dialogue renderer keeps exact lines, speaker, listener and acting tone while hiding production-heavy sections", () => {
  const project = defaultProject("对白稿", { scriptFormat: "dialogue", scriptFormatConfirmed: true });
  project.product = { name: "用户商品", sellingPoints: "真实卖点" };
  const blueprint = {
    title: "门口的真相",
    logline: "母女在门口因一份证据正面对质。",
    story: { synopsis: "女儿误解母亲，证据迫使两人正面说清。", ending: "女儿接过证据，决定补救。" },
    characters: [
      { id: "C01", name: "林梅", role: "母亲" },
      { id: "C02", name: "秦添", role: "女儿" }
    ]
  };
  const normalized = {
    characters: [
      { id: "C01", name: "林梅", description: "母亲" },
      { id: "C02", name: "秦添", description: "女儿" }
    ],
    scenes: [{ id: "SC01", name: "家门口", description: "狭窄门厅，证据散落在地。" }],
    shots: [{
      id: "S01",
      number: 1,
      duration: 8,
      sceneName: "家门口",
      action: "林梅按住即将关上的门，把证据递到秦添眼前。",
      emotion: "压着委屈质问",
      dialogueTurns: [
        { speakerId: "C01", listenerIds: ["C02"], text: "你先看完，再说我骗你。", sourceTone: "压着委屈", delivery: "先低后重", body: "手指发抖但不后退" },
        { speakerId: "C02", listenerIds: ["C01"], text: "这些年，你为什么一句都不说？", delivery: "震惊转愧疚", body: "眼神躲闪后重新看向母亲" }
      ]
    }]
  };
  const raw = renderDialogueScript(blueprint, normalized, project, { title: blueprint.title });
  assert.match(raw, /## 简单背景情节/);
  assert.match(raw, /林梅（对秦添说；压着委屈/);
  assert.match(raw, /你先看完，再说我骗你。/);
  assert.match(raw, /秦添（对林梅说；震惊转愧疚/);
  assert.match(raw, /这些年，你为什么一句都不说？/);
  assert.doesNotMatch(raw, /人物圣经|场景圣经|道具与商品圣经|subshot/);
});

test("format and audience-priority directives preserve the full downstream production contract", () => {
  const project = defaultProject("简易", { scriptFormat: "dialogue", scriptFormatConfirmed: true });
  assert.match(scriptFormatDirective(project), /内部仍必须完整填写/);
  assert.match(scriptFormatDirective(project), /资产、分镜图或视频提示词质量/);
  const priority = viewerComprehensionPriorityDirective();
  for (const phrase of ["观众看懂并看进去", "对白原文必须完整保留", "正确说话人", "明确听者", "面部微表情", "禁止对镜念稿"]) {
    assert.match(priority, new RegExp(phrase));
  }
});

test("renderer wires the modal into every empty AI-writing entry and packaged UI audit", () => {
  const html = source("app/renderer/workbench.html");
  const renderer = source("app/renderer/workbench.js");
  const audit = source("scripts/audit-packaged.js");
  for (const id of ["scriptFormatDialog", "scriptFormatForm", "projectScriptFormat", "confirmScriptFormat", "cancelScriptFormat"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(renderer, /ensureScriptFormatBeforeWriting/);
  assert.match(renderer, /scriptFormatDialog/);
  assert.match(html, /SCRIPT FORMAT|简易对白稿|完整制作稿/);
  assert.match(audit, /scriptFormatDialog/);
});

test("all projects expose three persistent script examples with preview and TXT download", () => {
  const html = source("app/renderer/workbench.html");
  const renderer = source("app/renderer/workbench.js");
  assert.match(html, /id="scriptExampleLibrary"/);
  for (const format of ["production", "dialogue", "timed_storyboard"]) {
    assert.match(html, new RegExp(`data-script-format-preview=["']${format}["']`));
    assert.match(html, new RegExp(`data-script-format-example=["']${format}["']`));
  }
  for (const phrase of ["# 完整制作稿示例", "# 简易对白稿示例", "# 秒级分镜成片稿示例", "说话人", "听者", "语气", "商品"]) {
    assert.match(renderer, new RegExp(phrase));
  }
  assert.match(renderer, /previewScriptFormatExample/);
  assert.match(renderer, /纯梦老虎机-\$\{names\[normalized\]\}-示例\.txt/);
});

test("script writing has a bounded request deadline while image and video polling stay unchanged", () => {
  const workflow = source("app/workbench-workflow.js");
  const provider = source("app/ai-provider.js");
  const bridge = source("app/bridge-client.js");
  assert.doesNotMatch(workflow, /SCRIPT_FAST_DEADLINE_REACHED/);
  assert.doesNotMatch(workflow, /scriptFastRequestBudgetMs/);
  assert.doesNotMatch(workflow, /const maxAttempts = providerLabel\(\)/);
  assert.match(provider, /const timeoutMs = Math\.max\(0, Number\(options\.timeoutMs\) \|\| 0\)/);
  assert.match(provider, /const maxAttempts = Math\.max\(1, Math\.min\(3, Number\(options\.maxReconnectAttempts\) \|\| 3\)\)/);
  assert.match(workflow, /timeoutMs: Math\.max\(1_000, Number\(options\.timeoutMs\) \|\| SCRIPT_TEXT_REQUEST_TIMEOUT_MS\)/);
  assert.doesNotMatch(provider, /Date\.now\(\) - startedAt < 600_000/);
  assert.doesNotMatch(provider, /纯梦 GPT Image 2 生成超时/);
  assert.doesNotMatch(provider, /纯梦清波视频等待超时/);
  assert.match(bridge, /timeoutMs: 0/);
});
