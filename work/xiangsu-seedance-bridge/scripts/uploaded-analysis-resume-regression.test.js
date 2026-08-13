"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function responseFor(messages) {
  const system = String(messages.find(message => message.role === "system")?.content || "");
  const ledgerText = system.split("【上传剧本逐句事实账本·最高优先级】\n")[1]?.split("\n每个ID必须")[0] || "[]";
  const ledger = JSON.parse(ledgerText);
  const contract = system.match(/当前片段必须恰好输出 (\d+) 个 shots，duration 依次严格写为 ([^\n]+) 秒/);
  const count = Number(contract?.[1]) || 1;
  const durations = String(contract?.[2] || "10").split("、").map(Number);
  return {
    story: { premise: "周岚和陈立在客厅把多年误会逐句说清", ending: "双方听懂彼此并作出决定" },
    characters: [
      { id: "C01", name: "周岚", description: "三十多岁女性，短发，站姿挺直", identitySignature: "短发、左眉小痣、挺直站姿", voiceDescription: "清晰女中音", signatureLine: "你听我说完" },
      { id: "C02", name: "陈立", description: "四十岁男性，方脸，微驼背", identitySignature: "方脸、眼袋、微驼背", voiceDescription: "低沉男声", signatureLine: "我现在明白了" }
    ],
    scenes: [{ id: "SC01", name: "客厅", description: "木桌、布沙发、东侧窗和固定门口轴线", time: "夜" }],
    shots: Array.from({ length: count }, (_, shotIndex) => {
      const local = ledger.filter((_, index) => index % count === shotIndex);
      const duration = durations[shotIndex] || 10;
      return {
        id: `S${String(shotIndex + 1).padStart(2, "0")}`,
        title: `事实推进${shotIndex + 1}`,
        duration,
        characters: ["周岚", "陈立"],
        scenePresenceCharacterIds: ["C01", "C02"],
        visibleCharacterIds: ["C01", "C02"],
        scene: "客厅",
        action: "两人隔桌对话并逐步说清事实",
        visualBeat: "说话人开口、听者反应、关系推进",
        stateBefore: "上一句刚结束",
        stateAfter: "新事实被听懂",
        startFrame: "说话人准备开口",
        endFrame: "听者消化信息",
        sourceDialogueBindings: local.map(item => ({
          sourceDialogueId: item.id,
          listenerIds: [item.speaker === "周岚" ? "C02" : "C01"],
          subshotNumber: 1,
          intent: "说明事实",
          emotion: item.tone,
          body: item.tone,
          listenerBeat: "准确接住信息"
        })),
        subshots: [
          { start: 0, end: duration / 3, visibleCharacterIds: ["C01", "C02"], action: "说话人开口", sourceDialogueIds: local.map(item => item.id) },
          { start: duration / 3, end: duration * 2 / 3, visibleCharacterIds: ["C01", "C02"], action: "听者反应" },
          { start: duration * 2 / 3, end: duration, visibleCharacterIds: ["C01", "C02"], action: "关系推进" }
        ],
        productMention: false,
        productShotType: "none"
      };
    })
  };
}

test("uploaded-script analysis resumes only the failed bounded chunk", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-analysis-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const source = Array.from({ length: 24 }, (_, index) => {
    const speaker = index % 2 ? "陈立" : "周岚";
    const listener = index % 2 ? "周岚" : "陈立";
    return `${speaker}（${index % 3 ? "克制但坚定，直视对方" : "压低声音，停顿后开口"}）：第${index + 1}句，${listener}，这句话必须完整保留。`;
  }).join("\n");
  const project = store.createProject("上传剧本拆镜断点", { inputMode: "manual" });
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "step" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart" },
    script: { raw: source }
  });

  const calls = new Map();
  const sessions = new Map();
  let failSecondChunk = true;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async (_config, messages, options) => {
      const user = String(messages.find(message => message.role === "user")?.content || "");
      const chunkNumber = Number(user.match(/第 (\d+)\/\d+ 段/)?.[1]) || 1;
      calls.set(chunkNumber, (calls.get(chunkNumber) || 0) + 1);
      sessions.set(chunkNumber, [...(sessions.get(chunkNumber) || []), String(options?.sessionId || "")]);
      await new Promise(resolve => setTimeout(resolve, chunkNumber === 2 ? 2 : 8));
      if (chunkNumber === 2 && failSecondChunk) {
        failSecondChunk = false;
        throw Object.assign(new Error("模拟长连接中断"), { code: "PUREAM_TRANSPORT_INTERRUPTED", noAutomaticRetry: true });
      }
      return responseFor(messages);
    }
  });

  await assert.rejects(workflow.analyzeScript(project.id), error => error?.code === "PUREAM_TRANSPORT_INTERRUPTED");
  const failed = store.getProject(project.id);
  const totalChunks = failed.script.analysisCheckpoint.totalChunks;
  assert.ok(totalChunks >= 2);
  assert.equal(failed.script.analysisCheckpoint.chunks.length, totalChunks - 1);
  assert.equal(failed.automation.recoverableFailure, true);
  const completedCalls = new Map(calls);

  const analyzed = await workflow.analyzeScript(project.id);
  assert.equal(calls.get(2), 2);
  for (const [chunkNumber, count] of completedCalls) {
    if (chunkNumber !== 2) assert.equal(calls.get(chunkNumber), count, `chunk ${chunkNumber} should be reused`);
  }
  assert.equal(sessions.get(2)[0], sessions.get(2)[1]);
  assert.equal(analyzed.script.analysisCheckpoint, null);
  assert.equal(analyzed.currentStage, "assets");
  assert.equal(analyzed.script.sourceDialogueLedger.length, 24);
});
