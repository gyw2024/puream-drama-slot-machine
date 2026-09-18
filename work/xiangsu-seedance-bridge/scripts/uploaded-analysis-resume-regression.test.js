"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, productionDialogueLedgerFromScript } = require("../app/workbench-workflow");
const { buildSourceSceneLedger } = require("../app/script-scene-ledger");

// --- single-intake helpers (agent-analysis-entry architecture) ---
function intakeDoc(sourceLines, options = {}) {
  const lines = sourceLines.map((text, index) => ({
    speaker: index % 2 ? "C02" : "C01",
    listener: index % 2 ? "C01" : "C02",
    text
  }));
  const perShot = options.perShot || 3;
  const shotCount = Math.ceil(lines.length / perShot);
  return {
    format: "compact-screenplay-v2",
    story: { title: options.title || "上传稿", synopsis: "周岚和陈立在客厅把多年误会逐句说清", ending: "双方听懂彼此并作出决定" },
    characters: [
      { id: "C01", name: "周岚", description: "三十多岁女性，短发，站姿挺直", assetRequired: false, role: "周岚", voiceDescription: "清晰女中音" },
      { id: "C02", name: "陈立", description: "四十岁男性，方脸，微驼背", assetRequired: false, role: "陈立", voiceDescription: "低沉男声" }
    ],
    scenes: [{ id: "SC01", name: (options.sceneName || "客厅"), description: "木桌、布沙发、东侧窗和固定门口轴线", assetRequired: false }],
    props: [],
    shots: Array.from({ length: shotCount }, (_, k) => {
      const local = lines.slice(k * perShot, (k + 1) * perShot);
      return {
        id: "S" + String(k + 1).padStart(2, "0"),
        sceneId: "SC01",
        duration: 12,
        characterIds: ["C01", "C02"],
        visibleCharacterIds: ["C01", "C02"],
        propIds: [],
        productVisible: false,
        productAction: "",
        opening: k === 0 ? "两人在客厅对坐" : "上一镜对白刚结束",
        action: "两人隔桌对话并逐步说清事实",
        dialogue: local.map((l, di) => ({ id: "D" + (k * perShot + di + 1), speakerId: l.speaker, listenerIds: [l.listener], addressMode: "person", onScreen: true, text: l.text, delivery: "克制", action: "说话人开口，听者注视对方" })),
        ending: k === shotCount - 1 ? "双方听懂彼此并作出决定" : "对话继续"
      };
    })
  };
}
function intakeMock(calls, doc) {
  return async (_config, messages, options) => {
    const stage = String(options?.stage || "");
    calls.push(stage);
    if (stage === "shot_screenplay_draft") return "完整中文剧本首稿";
    assert.equal(stage, "shot_screenplay_structure");
    return typeof doc === "function" ? doc() : doc;
  };
}

function adaptationInputFor(messages) {
  const text=String(messages.find(message=>message.role==='user')?.content||'');
  try {const parsed=JSON.parse(text);if(parsed.completeSource)return 'UPLOADED_TEXT_TO_STANDARDIZE:\n'+parsed.completeSource;if(Array.isArray(parsed.lines))return 'UPLOADED_TEXT_TO_STANDARDIZE:\n'+parsed.lines.map(r=>r.text).join('\n');}catch{}
  return text;
}
function responseFor(messages) {
  let whole;try{whole=JSON.parse(messages.find(m=>m.role==='user')?.content||'null');}catch{}
  if(whole?.completeSource)return require('./whole-script-test-fixture')(whole.completeSource);
  const adaptationInput = adaptationInputFor(messages);
  if (adaptationInput.includes("UPLOADED_TEXT_TO_STANDARDIZE:\n")) {
    const uploaded = adaptationInput.split("UPLOADED_TEXT_TO_STANDARDIZE:\n").at(-1) || "";
    const rawSceneLedger = buildSourceSceneLedger(uploaded);
    const rawDialogue = productionDialogueLedgerFromScript(uploaded, null, rawSceneLedger);
    const sceneOccurrences = rawSceneLedger.occurrences?.length
      ? rawSceneLedger.occurrences.map((item, index) => ({
        order: index + 1,
        physicalSceneName: item.sceneName || item.rawName || rawSceneLedger.catalogue[0]?.name || "客厅"
      }))
      : [{ order: 1, physicalSceneName: "客厅" }];
    const sceneName = sceneOccurrences[0].physicalSceneName;
    const actionLines = uploaded.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !rawDialogue.some(item => String(item.text || "").trim() && line.includes(String(item.text).trim())))
      .map(line => /^【\s*动作\s*】/u.test(line) ? line : `【动作】${line}`);
    return {
      productionScript: [
        `### S01｜场景：${sceneName}`,
        ...(actionLines.length ? actionLines : ["【动作】严格保留并按原稿顺序执行全部动作与事件。"]),
        ...(rawDialogue.length
          ? rawDialogue.map(item => `【对白】${item.speaker}${item.tone ? `（${item.tone}）` : ""}：${item.text}`)
          : ["【对白】无对白"]),
        "【承接】保持原稿事件顺序进入下一制作环节。"
      ].join("\n"),
      sourceAudit: {
        sceneOccurrenceCount: 1,
        dialogueCount: rawDialogue.length,
        sceneOccurrences: [{ order: 1, physicalSceneName: sceneName }],
        preservedAllDialogue: true,
        preservedAllScenes: true,
        preservedAllActions: true,
        preservedEventOrder: true,
        noInventedDialogue: true
      }
    };
  }
  if (adaptationInput.includes("IMMUTABLE_DIALOGUE_CHECKLIST:\n")) {
    const sceneJson = adaptationInput.split("IMMUTABLE_SCENE_CHECKLIST:\n")[1]?.split("\n\nIMMUTABLE_DIALOGUE_CHECKLIST:")[0] || "[]";
    const dialogueJson = adaptationInput.split("IMMUTABLE_DIALOGUE_CHECKLIST:\n")[1]?.split("\n\nIMMUTABLE_NARRATIVE_CHECKLIST:")[0] || "[]";
    const scenes = JSON.parse(sceneJson);
    const dialogue = JSON.parse(dialogueJson);
    const uploaded = adaptationInput.split("\n\nUPLOADED_TEXT:\n")[1] || "";
    const sceneName = String(scenes[0]?.name || "未标场景");
    const narrative = uploaded.split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line => {
      if (/^(?:#{1,6}\s*)?(?:场景|地点|内景|外景)\s*[：:]/u.test(line)) return false;
      return !dialogue.some(item => String(item?.text || "").trim() && line.includes(String(item.text).trim()));
    }).map(line => /^【\s*(?:动作|画面|声音|承接)\s*】/u.test(line) ? line : `【动作】${line}`);
    return {
      productionScript: [
        `### S01｜场景：${sceneName}`,
        ...(narrative.length ? narrative : ["【动作】保持原稿人物、位置与事件顺序。"]),
        ...dialogue.map(item => `【对白】${item.speaker}${item.tone ? `（${item.tone}）` : ""}：${item.text}`),
        "【承接】按原稿进入下一事件。"
      ].join("\n")
    };
  }
  if (adaptationInput.includes("TXT:\n") || adaptationInput.includes("Uploaded TXT:\n")) {
    const marker = adaptationInput.includes("Uploaded TXT:\n") ? "Uploaded TXT:\n" : "TXT:\n";
    return { productionScript: adaptationInput.split(marker).at(-1) };
  }
  const system = String(messages.find(message => message.role === "system")?.content || "");
  const ledgerText = system.split("【上传剧本逐句事实账本·最高优先级】\n")[1]?.split("\n每个ID必须")[0] || "[]";
  const ledger = JSON.parse(ledgerText);
  const contract = system.match(/当前片段必须恰好输出 (\d+) 个 shots，duration 依次严格写为 ([^\n]+) 秒/);
  const count = Number(contract?.[1]) || 1;
  const durations = String(contract?.[2] || "10").split("、").map(Number);
  // The current intake schema is compact-screenplay-v2; emit a conforming
  // structured document so the budgeted intake/repair loop accepts the first
  // captured draft instead of exhausting the repair budget.
  return {
    format: "compact-screenplay-v2",
    story: { title: "事实推进", synopsis: "周岚和陈立在客厅把多年误会逐句说清", ending: "双方听懂彼此并作出决定" },
    characters: [
      { id: "C01", name: "周岚", description: "三十多岁女性，短发，站姿挺直", assetRequired: false, role: "周岚", voiceDescription: "清晰女中音" },
      { id: "C02", name: "陈立", description: "四十岁男性，方脸，微驼背", assetRequired: false, role: "陈立", voiceDescription: "低沉男声" }
    ],
    scenes: [{ id: "SC01", name: "客厅", description: "木桌、布沙发、东侧窗和固定门口轴线", assetRequired: false }],
    props: [],
    shots: Array.from({ length: count }, (_, shotIndex) => {
      const local = ledger.filter((_, index) => index % count === shotIndex);
      const duration = durations[shotIndex] || 10;
      return {
        id: `S${String(shotIndex + 1).padStart(2, "0")}`,
        sceneId: "SC01",
        duration,
        characterIds: ["C01", "C02"],
        visibleCharacterIds: ["C01", "C02"],
        propIds: [],
        productVisible: false,
        productAction: "",
        opening: "上一句刚结束",
        action: "两人隔桌对话并逐步说清事实",
        dialogue: local.map((item, di) => ({
          id: `${String(shotIndex + 1).padStart(2, "0")}-${di + 1}`,
          speakerId: item.speaker === "周岚" ? "C01" : "C02",
          listenerIds: [item.speaker === "周岚" ? "C02" : "C01"],
          addressMode: "person",
          onScreen: true,
          text: String(item.text || ""),
          delivery: item.tone || "平静",
          action: "说话人开口，听者反应"
        })),
        ending: "新事实被听懂"
      };
    })
  };
}

test("uploaded legacy-flagged source runs one Agent intake and preserves the complete uploaded dialogue", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-analysis-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const dialogueSource = Array.from({ length: 24 }, (_, index) => {
    const speaker = index % 2 ? "陈立" : "周岚";
    const listener = index % 2 ? "周岚" : "陈立";
    return `${speaker}（${index % 3 ? "克制但坚定，直视对方" : "压低声音，停顿后开口"}）：第${index + 1}句，${listener}，这句话必须完整保留。`;
  }).join("\n");
  // Free-form uploads are chunked by actual source size, never by a target
  // duration or an assumed number of shots.  Keep this fixture above 6,000
  // chars so it exercises three independently checkpointed transport chunks.
  const source = `${dialogueSource}\n${Array.from({ length: 120 }, (_, index) => `【动作】第${index + 1}段补充舞台调度：两人保持既有位置，先听后说，用停顿和目光完成情绪承接，不增加任何新对白或剧情。`).join("\n")}`;
  const project = store.createProject("上传剧本拆镜断点", { inputMode: "ai" });
  store.patchProject(project.id, {
    // Simulate a project imported by an older client that forgot to persist
    // inputMode=manual even though the source is a user upload.
    productionPlan: { inputMode: "ai", executionMode: "step" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart" },
    script: { raw: source }
  });

  let intakeHandler = async () => { throw new Error("intake mock installed below"); };
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: (...args) => intakeHandler(...args)
  });

  const intakeCalls = [];
  intakeHandler = intakeMock(intakeCalls, () => intakeDoc(Array.from({ length: 24 }, (_, i) => `第${i + 1}句，${i % 2 ? "周岚" : "陈立"}，这句话必须完整保留。`)));
  const analyzed = await workflow.analyzeScript(project.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(intakeCalls, ["shot_screenplay_draft", "shot_screenplay_structure"], "analysis is exactly one Agent intake; no chunk or repair requests may follow");
  assert.equal(analyzed.currentStage, "assets");
  assert.equal(analyzed.script.analysisCheckpoint, null);
  assert.ok(["shot-screenplay-direct-delivery-v1", "uploaded-ai-standardized-local-compiler-v1"].includes(analyzed.script.analysisMethod));
  assert.equal(analyzed.shots.flatMap(shot => shot.dialogueTurns || []).length, 24, "every uploaded dialogue line must survive the intake delivery");
});

test("identical uploads each complete one Agent intake and reach assets across H3 modes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-standard-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const source = [
    "场景：社区礼堂门口",
    "梁玉芬（受伤却稳住声线）：这是我自己的舞台。",
    "沈岚（压低声音）：妈，我听你唱完。"
  ].join("\n");
  const first = store.createProject("资产直驱上传稿", { inputMode: "manual", mode: "asset_direct" });
  const second = store.createProject("分镜合图上传稿", { inputMode: "manual", mode: "storyboard_sheet" });
  for (const project of [first, second]) {
    store.patchProject(project.id, {
      productionPlan: { inputMode: "manual", executionMode: "step" },
      generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: project.id === first.id ? "asset_direct" : "storyboard_sheet" },
      script: { raw: source }
    });
  }
  let intakeHandler = async () => { throw new Error("intake mock installed below"); };
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: (...args) => intakeHandler(...args)
  });
  const intakeCalls = [];
  intakeHandler = intakeMock(intakeCalls, () => intakeDoc([
    "这是我自己的舞台。",
    "妈，我听你唱完。"
  ]));
  const firstAnalyzed = await workflow.analyzeScript(first.id);
  const secondAnalyzed = await workflow.analyzeScript(second.id);
  assert.equal(intakeCalls.length, 4, "each upload pays exactly one intake (draft + structure); no shared or extra requests");
  assert.equal(firstAnalyzed.currentStage, "assets");
  assert.equal(secondAnalyzed.currentStage, "assets");
  assert.equal(firstAnalyzed.shots.flatMap(shot => shot.dialogueTurns || []).length, 2);
  assert.equal(secondAnalyzed.shots.flatMap(shot => shot.dialogueTurns || []).length, 2);
});

test("uploaded analysis runs exactly one creative intake without redundant draft requests", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-analysis-no-progress-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const project = store.createProject("蓝图关闭空分镜恢复", { inputMode: "manual" });
  const source = [
    "场景：客厅",
    "周岚（压低声音）：你先听我说完。",
    "陈立（克制）：我在听，你继续。"
  ].join("\n");
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "step" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart", targetDurationSeconds: 60 },
    script: { raw: source }
  });
  let intakeHandler = async () => { throw new Error("intake mock installed below"); };
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: (...args) => intakeHandler(...args)
  });
  const intakeCalls = [];
  intakeHandler = intakeMock(intakeCalls, () => intakeDoc([
    "你先听我说完。",
    "我在听，你继续。"
  ]));
  const analyzed = await workflow.analyzeScript(project.id);
  assert.deepEqual(intakeCalls, ["shot_screenplay_draft", "shot_screenplay_structure"], "exactly one creative intake; no redundant draft requests");
  assert.equal(analyzed.currentStage, "assets");
  assert.ok(analyzed.shots.length >= 1);
  assert.ok(["shot-screenplay-direct-delivery-v1", "uploaded-ai-standardized-local-compiler-v1"].includes(analyzed.script.analysisMethod));
  assert.notEqual(analyzed.status, "script_needs_revision");
});

test("balance or authorization errors stop immediately and never enter structural recovery", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-analysis-balance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const project = store.createProject("余额错误保持可操作", { inputMode: "manual" });
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "step" },
    script: { raw: "场景：客厅\n周岚（克制）：你听我说完。" }
  });
  let calls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => {
      calls += 1;
      throw Object.assign(new Error("insufficient balance"), { code: "PROVIDER_BALANCE_REQUIRED", retryable: false });
    }
  });
  await assert.rejects(workflow.analyzeScript(project.id), error => error?.code === "PROVIDER_BALANCE_REQUIRED");
  assert.equal(calls, 1);
  assert.notEqual(store.getProject(project.id).currentStage, "assets");
});

test("uploaded AI-first standardization checkpoints a first-byte timeout without four fresh drafts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-first-byte-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const project = store.createProject("长剧本首字节恢复", { inputMode: "manual" });
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "step" },
    script: { raw: "客厅里，周岚抬头。\n周岚（克制）：你先听我说完。" }
  });
  let calls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => {
      calls += 1;
      throw Object.assign(new Error("UPSTREAM_TIMEOUT_RETRY"), {
        code: "PUREAM_TEXT_STREAM_ERROR",
        upstreamCode: "CHAT_FIRST_BYTE_TIMEOUT",
        noAutomaticRetry: false,
        partialText: ""
      });
    }
  });
  await assert.rejects(workflow.analyzeScript(project.id), error => error?.upstreamCode === "CHAT_FIRST_BYTE_TIMEOUT");
  const saved = store.getProject(project.id);
  assert.equal(calls, 1, "validation retries must not reopen independent full requests after a transport timeout");
  assert.equal(saved.automation.status, "paused_remote");
  assert.equal(saved.automation.autoResume, true);
  assert.equal(saved.automation.recoverableFailure, true);
  assert.ok(saved.automation.retryAt);
});

test("Agent intake compound shot fields reach assets without phantom speakers", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-analysis-compound-fields-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const project = store.createProject("自由稿先标准化再解析", { inputMode: "manual" });
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "step" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart" },
    script: { raw: "雨夜，周岚推门进屋，压低声音对陈立说：‘你先听我把今天看到的事情完整说完，别急着走，等你看清这些收据上的日期，就会知道我为什么来找你。’" }
  });
  let intakeHandler = async () => { throw new Error("intake mock installed below"); };
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: (...args) => intakeHandler(...args)
  });
  const intakeCalls = [];
  intakeHandler = intakeMock(intakeCalls, () => {
    const doc = intakeDoc(["你先听我把今天看到的事情完整说完，别急着走，等你看清这些收据上的日期，就会知道我为什么来找你。"], { perShot: 1 });
    doc.shots[0].characterIds = ["C01"];
    doc.shots[0].visibleCharacterIds = ["C01"];
    return doc;
  });
  const analyzed = await workflow.analyzeScript(project.id);
  assert.deepEqual(intakeCalls, ["shot_screenplay_draft", "shot_screenplay_structure"], "one intake delivers the compound fields directly");
  assert.equal(analyzed.currentStage, "assets");
  assert.deepEqual(analyzed.script.sourceDialogueLedger.map(item => `${item.speaker}:${item.text}`), [
    "周岚:你先听我把今天看到的事情完整说完，别急着走，等你看清这些收据上的日期，就会知道我为什么来找你。"
  ]);
  assert.ok(analyzed.characters.every(item => !["分镜名称", "镜头时长", "画面与动作", "景别与运镜"].includes(item.name)));
  assert.ok(analyzed.shots[0].dialogueTurns.every(turn => turn.speaker === "周岚"), "no phantom speakers");
});


test("time-range scene header in source is delivered as authored scene data without a paid re-draft", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-analysis-scene-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const project = store.createProject("客户时间轴剧本", { inputMode: "manual", targetDurationSeconds: 30 });
  const source = [
    "场景：客厅",
    "0-10秒",
    "周岚（克制）：你先听我说完。",
    "陈立（低声）：我在听。"
  ].join("\n");
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "step" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart", targetDurationSeconds: 30 },
    script: { raw: source }
  });
  let intakeHandler = async () => { throw new Error("intake mock installed below"); };
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: (...args) => intakeHandler(...args)
  });
  const intakeCalls = [];
  intakeHandler = intakeMock(intakeCalls, () => intakeDoc([
    "你先听我说完。",
    "我在听。"
  ], { perShot: 2, sceneName: "客厅" }));
  const analyzed = await workflow.analyzeScript(project.id);
  assert.deepEqual(intakeCalls, ["shot_screenplay_draft", "shot_screenplay_structure"], "the source time-range header never triggers a second paid pass");
  assert.deepEqual(analyzed.scenes.map(item => item.name), ["客厅"]);
  assert.ok(analyzed.scenes.every(item => !/秒|第\d+镜/.test(item.name)));
  assert.equal(analyzed.currentStage, "assets");
});
