"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  matrixGlobalPrompt,
  matrixRuntimeVideoPromptForProject
} = require("../app/production-mode-matrix");
const {
  viewerComprehensionPriorityDirective,
  productionHardContractFailures
} = require("../app/workbench-workflow");

const modes = ["production_package", "asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"];

test("every H3 mode inherits the same opening, dialogue and three-layer gate", () => {
  for (const mode of modes) {
    const globalPrompt = matrixGlobalPrompt("cloud", mode);
    const runtimePrompt = matrixRuntimeVideoPromptForProject({ generation: { mode } });
    assert.match(globalPrompt, /前30秒/u, mode);
    assert.match(globalPrompt, /禁止零对白/u, mode);
    assert.match(globalPrompt, /三层校验/u, mode);
    assert.match(runtimePrompt, /every final video generation unit contains an explicit dialogue table with complete Chinese dialogue lines assigned by the validated speech and action windows/i, mode);
    assert.match(runtimePrompt, /three passed gates/i, mode);
    assert.match(runtimePrompt, /must never paraphrase speech/i, mode);
  }
});

test("top-level authoring directive makes the first 30 seconds self-explanatory", () => {
  const prompt = viewerComprehensionPriorityDirective();
  for (const fact of ["主角是谁", "人物关系", "刚发生了什么", "当前核心冲突", "失败会失去什么", "不可逆冲突"]) {
    assert.match(prompt, new RegExp(fact), fact);
  }
  assert.match(prompt, /每个最终视频生成单元必须有对白表并按实际语音时窗安排完整台词/u);
});

test("local production hard gate rejects an empty dialogue table and an unexplained first 30 seconds", () => {
  const shots = [1, 2, 3].map(number => ({
    id: `S0${number}`,
    number,
    duration: 10,
    mainlineStage: number === 1 ? "hook" : number === 3 ? "main_reversal" : "setup",
    stateAfter: `state ${number}`,
    dialogueTurns: number === 1 ? [] : [{ speakerId: "C01", text: `台词${number}` }]
  }));
  const failures = productionHardContractFailures({ shots }, { requireHook: false, requireProduct: false });
  assert.ok(failures.some(item => item.code === "DIALOGUE_TABLE_EMPTY"));
  assert.ok(failures.some(item => item.code === "OPENING_30S_DIALOGUE_CLARITY"));
  assert.ok(failures.some(item => item.code === "OPENING_30S_CONFLICT_TURN_MISSING"));
});

test("final stitch uses an FFmpeg filter script so a 70-shot graph never enters the Windows command line", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const assemble = source.slice(source.indexOf("const filter = h3ExactStitchFilter(finalStreams"), source.indexOf("// Final assembled media is also a delivery boundary"));
  assert.match(assemble, /-filter_complex_script/);
  assert.doesNotMatch(assemble, /"-filter_complex",\s*filter/);
  assert.match(assemble, /fs\.rmSync\(filterScriptPath/);
});

test("atomic subshot conversion never executes next-shot continuation as the current action", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const conversion = source.slice(source.indexOf("const subshots = boundaries.map"), source.indexOf("const ratio = blocks.length"));
  assert.doesNotMatch(conversion, /action:\s*subIndex[^\n]+continuation\s*\|\|\s*action/);
  assert.match(conversion, /localBodyActions/);
  assert.match(conversion, /不提前执行后续动作/u);
});
