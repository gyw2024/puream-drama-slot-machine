"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseSourceDialogueLedger } = require("../app/dialogue-parser");
const {
  conformImportedAnalysisToDurationContract,
  localUploadedAnalysisChunk
} = require("../app/workbench-workflow");

test("uploaded dialogue source-ledger compiler preserves source truth for zero-cost structural recovery", () => {
  const raw = [
    "【场景】客厅",
    "林梅（压低声音，忍着火）：你把那张单子给我。",
    "周兰（哽咽，手指发抖）：我没有想瞒你。",
    "林梅（提高音量）：那你为什么一个人扛？"
  ].join("\n");
  const ledger = parseSourceDialogueLedger(raw);
  const data = localUploadedAnalysisChunk({
    index: 0,
    text: raw,
    unitCount: 3,
    durations: [10, 10, 10],
    sourceDialogueLedger: ledger
  }, { generation: { engine: "hailuo-h3", mode: "keyframe" } });
  const normalized = conformImportedAnalysisToDurationContract(data, {
    product: { name: "", description: "", sellingPoints: "" },
    script: { raw },
    productionPlan: { inputMode: "manual" },
    generation: { engine: "hailuo-h3", mode: "keyframe", targetDurationSeconds: 300 }
  }, { adaptiveTargetSeconds: 30 });
  assert.equal(normalized.shots.length, 3);
  assert.equal(normalized.durationContract.plannedSeconds, 30);
  assert.deepEqual(normalized.shots.flatMap(shot => shot.dialogueTurns).map(turn => turn.text), ledger.map(item => item.text));
  assert.deepEqual(normalized.shots.flatMap(shot => shot.dialogueTurns).map(turn => turn.sourceTone), ledger.map(item => item.tone));
  assert.deepEqual(normalized.shots.flatMap(shot => shot.dialogueTurns).map(turn => {
    const character = normalized.characters.find(item => item.id === turn.speakerId);
    return character?.name;
  }), ledger.map(item => item.speaker));
  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.equal((workflowSource.match(/localUploadedAnalysisChunk\(/g) || []).length, 1, "production analysis prepares local evidence before Agent enhancement");
  assert.doesNotMatch(workflowSource, /local-uploaded-script-compiler/);
  assert.doesNotMatch(workflowSource, /agent-plus-local-auto-repair/);
  assert.match(workflowSource, /without spending another model/);
  assert.match(workflowSource, /localUploadedAnalysisChunk/);
  assert.match(workflowSource, /localFallbackCount:\s*0/);
});

test("local fallback preserves explicit characters but promotes only causal props", () => {
  const raw = [
    "【场景】旧宅客厅",
    "人物：@林梅 @周兰 @沉默保镖",
    "物品：@离婚协议书 @手机",
    "林梅（压低声音）：把协议给我。",
    "周兰（发抖）：我没有骗你。"
  ].join("\n");
  const data = localUploadedAnalysisChunk({
    index: 0,
    text: raw,
    unitCount: 2,
    durations: [10, 10],
    sourceDialogueLedger: parseSourceDialogueLedger(raw)
  });
  assert.deepEqual(data.characters.map(item => item.name), ["林梅", "周兰", "沉默保镖"]);
  assert.deepEqual(data.props.map(item => item.name), ["离婚协议书"]);
  assert.ok(data.props.every(item => item.coreStory === true && item.units.length >= 1 && item.units.length <= data.shots.length));
});
