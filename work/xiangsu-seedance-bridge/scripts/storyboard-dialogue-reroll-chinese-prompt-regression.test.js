"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  WorkbenchWorkflow,
  renderApprovedVideoPromptChinese,
  selectedExistingCandidate,
  storyboardSheetGrid
} = require("../app/workbench-workflow");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { analyzeImageDimensions } = require("../app/media-quality");

const ffmpeg = path.join(__dirname, "..", "media-tools", "ffmpeg.exe");

test("vertical storyboard grids preserve exact 9:16 cells instead of stretching an 8-panel square sheet", () => {
  const grid = storyboardSheetGrid(8, "9:16");
  assert.deepEqual({ columns: grid.columns, rows: grid.rows }, { columns: 3, rows: 3 });
  assert.equal(grid.canvasAspectRatio, "9:16");
  assert.equal(grid.panelAspectRatio, "9:16");
  assert.equal(grid.emptyCells, 1);
  assert.equal(grid.fitPolicy, "exact-panel-ratio-square-grid-never-stretch");
});

test("video reroll falls back from a missing selected storyboard file to an existing candidate in the same revision", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-reroll-frame-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const existing = path.join(root, "existing.png");
  fs.writeFileSync(existing, Buffer.from("valid-storyboard-candidate"));
  const project = {
    productionRevision: "revision-7",
    candidates: [{
      id: "missing-selected",
      entityType: "shot",
      entityId: "S01",
      stage: "storyboard_sheet",
      productionRevision: "revision-7",
      selected: true,
      filePath: path.join(root, "removed.png"),
      updatedAt: "2026-08-25T10:00:00.000Z"
    }, {
      id: "existing-fallback",
      entityType: "shot",
      entityId: "S01",
      stage: "storyboard_sheet",
      productionRevision: "revision-7",
      selected: false,
      filePath: existing,
      updatedAt: "2026-08-25T09:59:00.000Z"
    }]
  };
  assert.equal(selectedExistingCandidate(project, "shot", "S01", "storyboard_sheet")?.id, "existing-fallback");
});

test("speaker, mouth, camera and voice stay on the same character while the listener remains closed-lipped", () => {
  const project = {
    generation: { aspectRatio: "9:16" },
    characters: [{ id: "C01", name: "周岚" }, { id: "C02", name: "顾母" }]
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 10,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "这双鞋不是给我的。", sourceTone: "压着委屈，句尾发紧" },
      { speakerId: "C02", listenerIds: ["C01"], text: "你先把话说清楚。", sourceTone: "惊讶后严厉追问" }],
    action: "周岚把鞋放到两人中间，顾母抬眼追问。"
  };
  const references = {
    images: ["p1.png", "p2.png", "c01.png", "c02.png"],
    imageRoles: [
      { type: "storyboard_timeline_panel", panelIndex: 0, startSecond: 0, endSecond: 5 },
      { type: "storyboard_timeline_panel", panelIndex: 4, startSecond: 5, endSecond: 10 },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [{ characterId: "C01" }, { characterId: "C02" }],
    hailuoApiMode: "multimodal_to_video"
  };
  const prompt = buildApprovedHailuoPrompt({ project, shot, references, dialogueTurns: shot.dialogueTurns });
  assert.match(prompt, /<Subject 1> \(S1\) faces <Subject 2> and says exactly once using only the vocal identity of <Audio 1>/);
  assert.match(prompt, /<Subject 2> \(S2\) faces <Subject 1> and says exactly once using only the vocal identity of <Audio 2>/);
  assert.equal((prompt.match(/这双鞋不是给我的。/g) || []).length, 1);
  assert.equal((prompt.match(/你先把话说清楚。/g) || []).length, 1);
  assert.equal((prompt.match(/remains closed-lipped/g) || []).length, 2);
  assert.match(prompt, /<Picture 1> is ordered 9:16 narrative frame P01 for 0-5 seconds/);
  assert.match(prompt, /<Picture 2> is ordered 9:16 narrative frame P05 for 5-10 seconds/);

  const chinese = renderApprovedVideoPromptChinese(project, shot, references);
  assert.notEqual(chinese, prompt, "the Chinese review copy must stay separate from the English provider prompt");
  assert.match(chinese, /分镜视频中文编辑稿/);
  assert.match(chinese, /镜头与口型只属于说话人【周岚｜C01】/);
  assert.match(chinese, /只使用【音频1｜周岚｜C01】的声线/);
  assert.match(chinese, /听者【顾母｜C02】闭口反应/);
  assert.match(chinese, /图片1：逐秒分镜第1格/);
  assert.doesNotMatch(chinese, /production:|references:|speaker=|mouth=|visual_timeline:|continuity:|delivery:/i);
  assert.doesNotMatch(chinese, /字幕|字卡|屏幕文字|可读文字|水印|subtitles?|captions?|screen\s+text|watermarks?/i);
});

test("a reproducible 4x2 storyboard compiles into eight independent 9:16 provider frames", async () => {
  assert.ok(fs.existsSync(ffmpeg), "packaged FFmpeg is a required build input");
  const evidence=path.resolve(__dirname,'../../../.codex_tests/TASK-20260912-RELEASE-259/panel-regression');
  fs.mkdirSync(evidence,{recursive:true});
  const root = fs.mkdtempSync(path.join(evidence, "frames-"));
  const source=path.join(root,'synthetic-spatial-grid.png');
  // An explicit synthetic spatial pattern makes panel order/independence
  // repeatable without retaining a user's clipboard file on release machines.
  require('node:child_process').execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1440x1280:rate=1','-frames:v','1',source],{windowsHide:true});
  const store = {
    getProject: () => ({ generation: { aspectRatio: "9:16" } }),
    assetDir: () => root
  };
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => ffmpeg, stagingRoot: root });
  const references = {
    images: [source],
    imageRoles: [{
      type: "storyboard_sheet",
      candidateId: "reported-grid",
      storyboardGrid: { panelCount: 8, columns: 4, rows: 2, panelAspectRatio: "9:16", canvasAspectRatio: "1:1" }
    }]
  };
  const panels = await workflow.cropStoryboardPanelSequence("reported", { id: "S01", duration: 8 }, Array.from({ length: 8 }, (_item, index) => index), references, { maxPanels: 8, timelineDuration: 8 });
  assert.equal(panels.length, 8);
  const dimensions = await Promise.all(panels.map(panel => analyzeImageDimensions(ffmpeg, panel.filePath)));
  assert.equal(dimensions.every(item => item.ok && item.width === 360 && item.height === 640), true);
  const hashes = panels.map(panel => crypto.createHash("sha256").update(fs.readFileSync(panel.filePath)).digest("hex"));
  assert.ok(new Set(hashes).size >= 6, "independent timeline frames must not collapse into a repeated first panel");
  assert.deepEqual(panels.map(panel => panel.panelIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
});
