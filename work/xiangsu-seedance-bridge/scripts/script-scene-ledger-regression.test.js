"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { detectUploadedScriptFormat, parseSourceDialogueLedger } = require("../app/dialogue-parser");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const {
  assertSourceSceneParity,
  bindDialogueLedgerToScenes,
  buildSourceSceneLedger,
  enforceSourceSceneLedger,
  sceneContextForRange,
  splitCompoundSceneName
} = require("../app/script-scene-ledger");

const CUSTOMER_PATTERN = `【场景】高档公寓客厅
秦深（平静）：今天怎么有空过来了？

【场景】大平层公寓走廊 -> 集团总裁办
秦深（边走边打电话）：小李，通知中介来我办公室。
（转场：宽大的总裁办公桌前）
小李（递上房产证）：秦总，房产证取出来了。

【场景】机场免税店 / 豪华公寓门口
（转场：免税店收银台前）
林娜（拍卡）：刷卡！
（转场：公寓大门前）
林娜（踹门）：开门！

【场景】集团总部 / 总裁办公室
林娜（冲进大厅）：秦深呢！
（林娜猛地推开总裁办公室的大门）
秦深（冷静）：站那，别出声。`;

test("bracketed Chinese scripts are classified as screenplay before dialogue", () => {
  assert.equal(detectUploadedScriptFormat(CUSTOMER_PATTERN), "chinese_screenplay");
});

test("compound headings and inline transitions become six concrete reusable scenes", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  assert.deepEqual(ledger.catalogue.map(item => item.name), [
    "高档公寓客厅",
    "大平层公寓走廊",
    "总裁办公室",
    "机场免税店",
    "豪华公寓门口",
    "集团总部"
  ]);
  assert.deepEqual(ledger.occurrences.map(item => item.sceneName), [
    "高档公寓客厅",
    "大平层公寓走廊",
    "总裁办公室",
    "机场免税店",
    "豪华公寓门口",
    "集团总部",
    "总裁办公室"
  ]);
  assert.equal(ledger.report.declaredSceneCount, 6);
  assert.equal(ledger.report.unresolvedSceneCount, 0);
});

test("dialogue remains bound to the scene active at its source offset", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  const dialogue = bindDialogueLedgerToScenes(parseSourceDialogueLedger(CUSTOMER_PATTERN), ledger);
  assert.equal(dialogue.find(item => item.text.includes("通知中介"))?.sourceSceneName, "大平层公寓走廊");
  assert.equal(dialogue.find(item => item.text.includes("房产证取出来"))?.sourceSceneName, "总裁办公室");
  assert.equal(dialogue.find(item => item.text === "刷卡！")?.sourceSceneName, "机场免税店");
  assert.equal(dialogue.find(item => item.text === "开门！")?.sourceSceneName, "豪华公寓门口");
});

test("model placeholders and compound scene inventions are overridden by source truth", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  const dialogue = bindDialogueLedgerToScenes(parseSourceDialogueLedger(CUSTOMER_PATTERN), ledger);
  const corrupted = {
    scenes: [
      { id: "SC01", name: "剧情主要空间" },
      { id: "SC02", name: "机场免税店 / 豪华公寓门口" }
    ],
    shots: dialogue.map((item, index) => ({
      id: `U${index + 1}`,
      scene: index % 2 ? "剧情主要空间" : "机场免税店 / 豪华公寓门口",
      sourceDialogueIds: [item.id],
      sourceDialogueBindings: [{ sourceDialogueId: item.id }]
    }))
  };
  const fixed = enforceSourceSceneLedger(corrupted, ledger, dialogue);
  assert.deepEqual(fixed.scenes.map(item => item.name), ledger.catalogue.map(item => item.name));
  assert.ok(fixed.shots.every(item => !/[\/→]|剧情主要空间/.test(item.scene)));
  assert.equal(fixed.shots.find(item => item.sourceDialogueIds.includes("D002"))?.scene, "大平层公寓走廊");
  assert.doesNotThrow(() => assertSourceSceneParity(fixed, ledger));
});

test("chunk context carries the active scene across a split without inventing placeholders", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  const office = ledger.occurrences.find(item => item.sceneName === "总裁办公室");
  const context = sceneContextForRange(ledger, office.sourceStart + 4, office.sourceEnd - 1);
  assert.equal(context.explicit, true);
  assert.ok(context.catalogue.some(item => item.name === "总裁办公室"));
});

test("supported heading matrix remains deterministic", () => {
  const cases = [
    ["第1场 医院走廊\n甲：来了。", "chinese_screenplay", "医院走廊"],
    ["场景：学校操场\n甲：来了。", "chinese_screenplay", "学校操场"],
    ["INT. KITCHEN - NIGHT\nALICE\nHello.", "fountain", "KITCHEN"],
    ["SC01 客厅\n甲：来了。", "structured_production", "客厅"],
    ["地点：老街门口\n甲：来了。", "chinese_screenplay", "老街门口"]
  ];
  for (const [source, format, scene] of cases) {
    assert.equal(detectUploadedScriptFormat(source), format);
    assert.equal(buildSourceSceneLedger(source).catalogue[0]?.name, scene);
  }
  assert.deepEqual(splitCompoundSceneName("A → B / C"), ["A", "B", "C"]);
});

test("explicit source scenes fail closed when a later stage drops them", () => {
  const ledger = buildSourceSceneLedger("【场景】客厅\n甲：一。\n【场景】门口\n乙：二。");
  assert.throws(
    () => assertSourceSceneParity({ scenes: [{ id: ledger.catalogue[0].id, name: "客厅" }], shots: [] }, ledger),
    error => error?.code === "SOURCE_SCENE_PARITY_FAILED" && error.missingScenes.includes("门口")
  );
});

test("real manual analysis preserves the six-scene source contract and stops when the Agent fails", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-scene-ledger-flow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const project = store.createProject("复合场景剧本全流程", { targetDurationSeconds: 90, inputMode: "manual" });
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "full" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart", targetDurationSeconds: 90, shotDuration: 10 },
    script: { raw: CUSTOMER_PATTERN }
  });
  let calls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => {
      calls += 1;
      throw Object.assign(new Error("simulated invalid upstream result"), { code: "TEXT_RESULT_INVALID" });
    }
  });
  await assert.rejects(
    workflow.analyzeScript(project.id),
    error => error?.code === "UPLOADED_SCRIPT_AGENT_RESULT_REQUIRED"
      && error?.agentRequired === true
      && error?.localCreativeFallbackUsed === false
  );
  assert.ok(calls >= 1);
  const preserved = store.getProject(project.id);
  assert.equal(preserved.currentStage, "script");
  assert.equal(preserved.script.raw, CUSTOMER_PATTERN);
  assert.equal(preserved.automation.errorCode, "UPLOADED_SCRIPT_AGENT_RESULT_REQUIRED");
  const ledger = buildSourceSceneLedger(preserved.script.raw);
  assert.deepEqual(ledger.catalogue.map(item => item.name), [
    "高档公寓客厅",
    "大平层公寓走廊",
    "总裁办公室",
    "机场免税店",
    "豪华公寓门口",
    "集团总部"
  ]);
  assert.equal(ledger.catalogue.length, 6);
});
