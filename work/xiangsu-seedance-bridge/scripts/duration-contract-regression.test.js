"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { reconcileUnitDurations } = require("../app/duration-contract");
const { estimateUploadedScriptDuration, explicitShotTimelinePlan, explicitTimelineDurationTarget } = require("../app/script-duration");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  h3ExactStitchFilter,
  conformImportedAnalysisToDurationContract,
  parseStructuredProductionScript,
  scriptPipelineEntryRoute
} = require("../app/workbench-workflow");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function importedAnalysis(count = 3) {
  return {
    story: { premise: "原稿故事", ending: "保留原稿结尾" },
    characters: [
      { id: "C01", name: "母亲", description: "五十岁母亲", identitySignature: "圆脸、短发、微驼背" },
      { id: "C02", name: "女儿", description: "二十八岁女儿", identitySignature: "长脸、马尾、高个" }
    ],
    scenes: [{ id: "SC01", name: "客厅", description: "固定沙发和窗户" }],
    shots: Array.from({ length: count }, (_, index) => ({
      id: `legacy-${index + 1}`,
      title: `原稿镜头${index + 1}`,
      duration: 10,
      characters: ["母亲", "女儿"],
      scene: "客厅",
      action: index === count - 1 ? "女儿理解母亲并拥抱她，原稿结尾完整落地" : `推进原稿冲突${index + 1}`,
      startFrame: "两人对峙",
      endFrame: "关系发生变化",
      subshots: [
        { start: 0, end: 3, framing: "中景", action: "母亲说话" },
        { start: 3, end: 7, framing: "近景", action: "女儿反应" },
        { start: 7, end: 10, framing: "双人景", action: "关系推进" }
      ]
    }))
  };
}

test("an impossible fixed shot count never pretends to satisfy the film duration", () => {
  assert.throws(
    () => reconcileUnitDurations([10, 10], 100, "puream-hailuo-h3"),
    error => error.code === "DURATION_TOTAL_UNREPRESENTABLE"
      && error.targetTotalSeconds === 100
      && error.unitCount === 2
  );
});

test("uploaded structured analysis keeps semantic timing without losing the authored ending", () => {
  const project = {
    generation: {
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      targetDurationSeconds: 45,
      shotDuration: 10
    },
    productionPlan: { inputMode: "manual" }
  };
  const conformed = conformImportedAnalysisToDurationContract(importedAnalysis(3), project, { adaptiveTargetSeconds: 30 });
  assert.equal(conformed.shots.reduce((sum, shot) => sum + shot.duration, 0), 30);
  assert.deepEqual(conformed.shots.map(shot => shot.id), ["S01", "S02", "S03"]);
  assert.equal(conformed.shots.at(-1).action.includes("原稿结尾完整落地"), true);
  assert.equal(conformed.shots.every(shot => shot.subshots.at(-1).end === shot.duration), true);
  assert.equal(conformed.durationContract.locked, false);
  assert.equal(conformed.durationContract.source, "uploaded-script-adaptive");
});

test("AI generated projects treat configured duration as an authoring reference", () => {
  const conformed = conformImportedAnalysisToDurationContract(importedAnalysis(3), {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", targetDurationSeconds: 45 },
    productionPlan: { inputMode: "ai" }
  });
  assert.equal(conformed.durationContract.targetSeconds, 30);
  assert.equal(conformed.durationContract.requestedTargetSeconds, 45);
  assert.equal(conformed.shots.reduce((sum, shot) => sum + shot.duration, 0), 30);
  assert.equal(conformed.durationContract.source, "ai-authoring-reference");
  assert.equal(conformed.durationContract.locked, false);
});

test("uploaded dialogue duration responds to exact speech, punctuation, pace and action beats", () => {
  const script = "母亲（缓慢地擦泪，停顿）：这些年，我一直没有告诉你……\n女儿（急促）：那张收据到底是谁留下的？";
  const ledger = require("../app/dialogue-parser").parseSourceDialogueLedger(script);
  const estimate = estimateUploadedScriptDuration(script, ledger, "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(estimate.dialogueTurns, 2);
  assert.ok(estimate.targetSeconds >= 8);
  assert.equal(estimate.mode, "uploaded-script-adaptive");
  const faster = estimateUploadedScriptDuration("母亲（飞快）：这些年我一直没有告诉你", require("../app/dialogue-parser").parseSourceDialogueLedger("母亲（飞快）：这些年我一直没有告诉你"), "puream-hailuo-h3");
  const slower = estimateUploadedScriptDuration("母亲（缓慢，一字一顿，停顿）：这些年我一直没有告诉你……", require("../app/dialogue-parser").parseSourceDialogueLedger("母亲（缓慢，一字一顿，停顿）：这些年我一直没有告诉你……"), "puream-hailuo-h3");
  assert.ok(slower.estimatedSeconds > faster.estimatedSeconds);
});

test("compact authored shot timelines override prose-length estimation without a project duration cap", () => {
  const script = [
    "全片20秒，9:16竖屏现实短剧。",
    "S01【0-10秒｜旧宅客厅】林娜带哭腔质问：‘我妈等了你整整三十年！’",
    "S02【10-20秒｜同一客厅】秦添声音发颤承认：‘是我错怪了她。’"
  ].join("\n");
  const explicit = explicitTimelineDurationTarget(script, "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(explicit.targetSeconds, 20);
  assert.equal(explicit.rangeCount, 2);
  const estimate = estimateUploadedScriptDuration(script, [], "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(estimate.mode, "uploaded-script-explicit-timeline");
  assert.equal(estimate.targetSeconds, 20);

  const sevenMinutes = explicitTimelineDurationTarget("剧总时长约420秒。S01【0-10秒】开场。", "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(sevenMinutes.targetSeconds, 420);
});

test("explicit per-shot ranges remain authoritative when Agent rhythm returns 14 plus 6", () => {
  const script = [
    "全片20秒。",
    "S01【0-10秒｜客厅】林娜带哭腔质问。",
    "S02【10-20秒｜同一客厅】秦添发颤承认。"
  ].join("\n");
  const plan = explicitShotTimelinePlan(script, "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(plan.complete, true);
  assert.equal(plan.providerCompatible, true);
  assert.deepEqual(plan.normalizedDurations, [10, 10]);
  const estimate = estimateUploadedScriptDuration(script, [], "puream-hailuo-h3", { engine: "hailuo-h3" });
  const agentResult = importedAnalysis(2);
  agentResult.shots[0].duration = 14;
  agentResult.shots[1].duration = 6;
  const normalized = conformImportedAnalysisToDurationContract(agentResult, {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", targetDurationSeconds: 20 },
    productionPlan: { inputMode: "manual" }
  }, { adaptiveTargetSeconds: 20, durationEstimate: estimate });
  assert.deepEqual(normalized.shots.map(shot => shot.duration), [10, 10]);
  assert.equal(normalized.durationContract.authoredShotDurationsLocked, true);
  assert.deepEqual(normalized.durationContract.authoredShotDurations, [10, 10]);
});

test("scripts without complete shot ranges preserve adaptive rhythm inside the 10-15 second production contract", () => {
  const estimate = estimateUploadedScriptDuration("全片20秒。林娜质问，秦添承认。", [], "puream-hailuo-h3", { engine: "hailuo-h3" });
  const agentResult = importedAnalysis(2);
  agentResult.shots[0].duration = 14;
  agentResult.shots[1].duration = 6;
  const normalized = conformImportedAnalysisToDurationContract(agentResult, {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", targetDurationSeconds: 20 },
    productionPlan: { inputMode: "manual" }
  }, { adaptiveTargetSeconds: 20, durationEstimate: estimate });
  assert.deepEqual(normalized.shots.map(shot => shot.duration), [14, 10]);
  assert.equal(normalized.durationContract.authoredShotDurationsLocked, false);
});

test("JSON script imports use the same local structured path as markdown imports", () => {
  const source = importedAnalysis(3);
  assert.deepEqual(parseStructuredProductionScript(JSON.stringify(source)), source);
});

test("the local uploaded-script workflow reaches assets with one persisted adaptive-duration revision", async () => {
  const root = temporaryDirectory("puream-local-script-duration-");
  try {
    const store = new WorkbenchStore(root);
    const settings = store.getSettings();
    settings.generation.qualityGatesEnabled = false;
    store.saveSettings(settings);
    const created = store.createProject("本地上传剧本", { targetDurationSeconds: 45, inputMode: "manual" });
    const imported=importedAnalysis(3);imported.shots.forEach((shot,i)=>shot.dialogueTurns=[{speaker:'母亲',sourceDialogueId:'D'+i,text:'你先听我把今天发生的事情讲清楚，这些原始收据我一直完整地留着，等你看过日期再做决定。'}]);
    store.patchProject(created.id, { script: { raw: JSON.stringify(imported) } });
     let paidTextCalls = 0;
    const workflow = new WorkbenchWorkflow({
      store,
      bridge: {},
      locateFfmpeg: () => "",
      stagingRoot: root,
    textGenerator: async (_config, messages) => {
      paidTextCalls += 1;
      const user = String(messages.find(item => item.role === "user")?.content || "");
      if(user.startsWith('{"completeSource":'))return require('./whole-script-test-fixture')(JSON.parse(user).completeSource);
      if (user.includes("UPLOADED_TEXT_TO_STANDARDIZE:\n") || user.startsWith('{"lines":')) return {
        productionScript: "### S01｜场景：客厅\n【人物】母亲、女儿\n【核心物品】无\n【动作】母亲挡在女儿面前，女儿停步并抬眼。\n【对白】母亲（克制而坚定）：你先听我把话说完。\n【声音】连续安静室内环境声。\n【承接】女儿闭口看向母亲，冲突继续。",
        sourceAudit: {
          sceneOccurrenceCount: 1,
          dialogueCount: 1,
          sceneOccurrences: [{ order: 1, physicalSceneName: "客厅" }],
          preservedAllDialogue: true,
          preservedAllScenes: true,
          preservedAllActions: true,
          preservedEventOrder: true,
          noInventedDialogue: true
        }
      };
      return { ...importedAnalysis(3), props: [] };
    }
    });
    const analyzed = await workflow.analyzeScript(created.id);
     assert.equal(paidTextCalls, 1, "every upload has exactly one paid AI-first standardization pass");
    assert.equal(analyzed.script.analysisMethod, "uploaded-ai-standardized-local-compiler-v1");
    assert.equal(analyzed.script.analysisEnhancement?.noDuplicatePaidAnalysis, true);
    assert.equal(analyzed.currentStage, "assets");
    assert.equal(analyzed.generation.durationLocked, false);
    const plannedSeconds = analyzed.shots.reduce((sum, shot) => sum + shot.duration, 0);
    assert.ok(plannedSeconds > 0);
    assert.equal(analyzed.generation.durationContract.targetSeconds, plannedSeconds);
    assert.equal(analyzed.generation.targetDurationSeconds, plannedSeconds);
    assert.equal(analyzed.generation.durationSource, "uploaded-script-adaptive");
    assert.notEqual(plannedSeconds, 45, "the configured target remains advisory for uploaded scripts");
    assert.match(analyzed.productionRevision, /^revision_/);
    assert.match(analyzed.script.sourceFingerprint, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy shots with a different total remain usable because duration is advisory", () => {
  assert.equal(scriptPipelineEntryRoute({
    generation: { targetDurationSeconds: 60 },
    shots: [{ duration: 10 }, { duration: 10 }],
    script: { raw: "用户上传的原稿" }
  }), "ready");
});

test("an analyzed source fingerprint prevents silently reusing shots after an out-of-band edit", () => {
  const crypto = require("node:crypto");
  assert.equal(scriptPipelineEntryRoute({
    generation: { targetDurationSeconds: 20, durationLocked: true },
    shots: [{ duration: 10 }, { duration: 10 }],
    script: {
      raw: "后来被替换的剧本",
      sourceFingerprint: crypto.createHash("sha256").update("原分析剧本").digest("hex")
    }
  }), "reanalyze_source");
});

test("changing script or duration archives the active plan but preserves history and cost", () => {
  const root = temporaryDirectory("puream-duration-invalidation-");
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("时长合同", { targetDurationSeconds: 30 });
    const project = store.getProject(created.id);
    project.productionRevision = "revision-old";
    project.script = { ...project.script, raw: "旧剧本", analyzedAt: "2026-01-01T00:00:00.000Z", analysis: { premise: "旧" } };
    project.characters = [{ id: "C01", name: "旧角色" }];
    project.scenes = [{ id: "SC01", name: "旧场景" }];
    project.shots = [{ id: "S01", number: 1, duration: 30 }];
    project.candidates = [{ id: "candidate-old", entityType: "shot", entityId: "S01", stage: "shot_video", productionRevision: "revision-old", selected: true }];
    project.jobs = [{ id: "job-old", type: "shot_video", entityId: "S01", productionRevision: "revision-old", status: "completed" }];
    project.finalVideoPath = "D:\\finished\\old.mp4";
    project.costLedger.entries = [{ id: "cost-old", category: "video", status: "settled", amount: 12.3 }];
    store.saveProject(project);

    const scripted = store.patchProject(created.id, { script: { raw: "新上传剧本" } });
    assert.equal(scripted.script.raw, "新上传剧本");
    assert.equal(scripted.shots.length, 0);
    assert.equal(scripted.characters.length, 0);
    assert.equal(scripted.currentStage, "script");
    assert.equal(scripted.generation.durationLocked, false);
    assert.notEqual(scripted.productionRevision, "revision-old");
    assert.equal(scripted.candidates[0].stale, true);
    assert.equal(scripted.candidates[0].selected, false);
    assert.equal(scripted.jobs[0].staleByEdit, true);
    assert.equal(scripted.finalVideoPath, "");
    assert.equal(scripted.finalVideoHistory[0].filePath, "D:\\finished\\old.mp4");
    assert.equal(scripted.costLedger.entries.some(entry => entry.id === "cost-old"), true);

    scripted.script.analyzedAt = "2026-01-02T00:00:00.000Z";
    scripted.characters = [{ id: "C02", name: "新角色" }];
    scripted.scenes = [{ id: "SC02", name: "新场景" }];
    scripted.shots = [{ id: "S01", number: 1, duration: 30 }];
    scripted.generation.durationLocked = true;
    store.saveProject(scripted);
    const newRevision = scripted.productionRevision;
    const retimed = store.patchProject(created.id, { generation: { targetDurationSeconds: 45 } });
    assert.equal(retimed.generation.targetDurationSeconds, 45);
    assert.notEqual(retimed.productionRevision, newRevision);
    assert.equal(retimed.shots.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("saving unchanged script is idempotent and source mutations are blocked during automation", () => {
  const root = temporaryDirectory("puream-duration-busy-");
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("运行保护");
    let project = store.getProject(created.id);
    project.script.raw = "同一份剧本";
    project.shots = [{ id: "S01", number: 1, duration: 300 }];
    project.productionRevision = "revision-stable";
    store.saveProject(project);
    const unchanged = store.patchProject(created.id, { script: { raw: "同一份剧本" } });
    assert.equal(unchanged.shots.length, 1);
    assert.equal(unchanged.productionRevision, "revision-stable");

    unchanged.generation.durationLocked = true;
    unchanged.generation.durationContract = { locked: true, targetSeconds: 300, plannedSeconds: 300 };
    store.saveProject(unchanged);
    const persisted = store.getProject(created.id);
    assert.equal(persisted.generation.durationLocked, true);
    assert.equal(persisted.generation.durationContract.targetSeconds, 300);

    project = store.getProject(created.id);
    project.automation = { ...project.automation, status: "running", operation: "full_pipeline" };
    store.saveProject(project);
    assert.throws(
      () => store.patchProject(created.id, { generation: { targetDurationSeconds: 60 } }),
      error => error.code === "PROJECT_MUTATION_BUSY"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("replacing a script after pausing AI writing retires the old checkpoint", () => {
  const root = temporaryDirectory("puream-paused-script-replace-");
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("暂停后上传");
    const project = store.getProject(created.id);
    project.script.raw = "AI旧草稿";
    project.script.generationCheckpoint = { shotPlan: [{ id: "S01" }], shots: [] };
    project.script.generationLive = { stage: "script_units", message: "已写一半" };
    project.automation = { ...project.automation, status: "paused", operation: "idea_script" };
    store.saveProject(project);
    const replaced = store.patchProject(created.id, { script: { raw: "用户上传的新剧本" } });
    assert.equal(replaced.script.raw, "用户上传的新剧本");
    assert.equal(replaced.script.generationCheckpoint, undefined);
    assert.equal(replaced.script.generationLive, undefined);
    assert.equal(replaced.automation.status, "idle");
    assert.equal(scriptPipelineEntryRoute(replaced), "analyze_imported");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rough-cut stitching uses actual trimmed media duration, selected aspect ratio and full audio", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(source, /const exactDurationRequired = true;/);
  // Authored duration is only a planning hint in local post-production. Real
  // media length minus a safe head trim now owns the exported timeline, so a
  // stale script duration cannot truncate dialogue or pad the final sentence.
  assert.match(source, /const sourceDuration = await probeMediaStreamDuration\(ffmpeg, videos\[index\]\.filePath, "0:v:0", signal\);/);
  assert.match(source, /duration: Math\.max\(0\.001, sourceDuration - trimStartSeconds\), hasAudio/);
  assert.match(source, /exactTargetSeconds = Math\.max\(0\.001, finalStreams\.reduce\(/);
  assert.match(source, /h3ExactStitchFilter\(finalStreams, exactTargetSeconds, 24, project\.generation\?\.aspectRatio \|\| "9:16"\)/);
  const streams = [{ duration: 12.5, trimStartSeconds: 0.2, hasAudio: true }, { duration: 6.25, trimStartSeconds: 0, hasAudio: false }];
  for (const [ratio, dimensions] of Object.entries({ "9:16": "576:1024", "16:9": "1024:576", "1:1": "720:720", "4:3": "960:720", "3:4": "720:960", "21:9": "1344:576" })) {
    const filter = h3ExactStitchFilter(streams, 18.75, 24, ratio);
    assert.ok(filter.includes(`scale=${dimensions}:force_original_aspect_ratio=increase,crop=${dimensions}`), `${ratio} must retain its requested frame shape`);
    assert.match(filter, /\[0:v:0\]settb=AVTB,trim=start=0\.2,/);
    assert.match(filter, /\[0:a:0\][^;]*atrim=start=0\.2,[^;]*atrim=duration=12\.5/);
    assert.match(filter, /anullsrc=r=48000:cl=stereo,atrim=duration=6\.25,[^;]*\[a1\]/);
    assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1/);
    assert.match(filter, /\[vcat\][^;]*trim=duration=18\.75/);
    assert.match(filter, /\[acat\][^;]*atrim=duration=18\.75[^;]*\[outa\]/);
    assert.doesNotMatch(filter, /drawtext|subtitles=/, "editable captions belong in the draft, never burned into the rough cut");
  }
  assert.match(source, /if \(exactDurationRequired\) \{/);
  assert.doesNotMatch(source, /const exactDurationH3/);
  assert.match(source, /if \(!finalDurationAudit\.ok\) \{\s*throw Object\.assign/);
  assert.doesNotMatch(source, /if \(planSum !== filmSchedule\.totalSeconds && this\.qualityGatesEnabled/);
  assert.doesNotMatch(source, /海螺 H3 (?:精确时长拼接失败|成片实际时长未锁定)/);
});
