"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseSourceDialogueLedger } = require("../app/dialogue-parser");
const {
  conformImportedAnalysisToDurationContract,
  localUploadedAnalysisChunk
} = require("../app/workbench-workflow");

test("uploaded dialogue fallback preserves every speaker, tone and sentence without an upstream JSON result", () => {
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
});
