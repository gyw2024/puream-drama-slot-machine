"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  WorkbenchWorkflow,
  assertShotReferenceBundle,
  h3ExactStitchFilter,
  probeMediaStreamDuration
} = require("../app/workbench-workflow");
const { analyzeTimedHardCuts, analyzeImageDimensions, analyzeStoryboardSheetGrid } = require("../app/media-quality");

const ffmpeg = path.join(__dirname, "..", "media-tools", "ffmpeg.exe");

function run(args) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true, stdio: "pipe" });
}

test("a sanitized storyboard derivative keeps verifiable parent lineage", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-sheet-lineage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "storyboard-sheet.png");
  const derived = path.join(root, "storyboard-panel-anchor.png");
  fs.writeFileSync(parent, "parent-sheet");
  fs.writeFileSync(derived, "sanitized-live-story-panel");
  const project = {
    productionRevision: "revision-1",
    generation: { engine: "seedance", mode: "storyboard_sheet", modeConfirmed: true },
    candidates: [{
      id: "sheet-1",
      filePath: parent,
      stage: "storyboard_sheet",
      entityType: "shot",
      entityId: "S01",
      productionRevision: "revision-1"
    }]
  };
  const shot = { id: "S01", number: 1, duration: 5 };
  const references = {
    images: [derived],
    imageRoles: [{
      type: "storyboard_panel_anchor",
      path: derived,
      parentFilePath: parent,
      candidateId: "sheet-1",
      sourceStage: "storyboard_sheet",
      entityType: "shot",
      entityId: "S01"
    }]
  };
  assert.equal(assertShotReferenceBundle(
    project,
    shot,
    "storyboard_sheet",
    references,
    null,
    { generation: { qualityGatesEnabled: false } }
  ), true);
});

test("atomic hard-cut stitch survives a provider clip with no audio stream", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-agent-stitch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const voiced = path.join(root, "voiced.mp4");
  const silent = path.join(root, "silent.mp4");
  const output = path.join(root, "stitched.mp4");
  run([
    "-f", "lavfi", "-i", "color=c=red:s=180x320:r=24:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", voiced
  ]);
  run([
    "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=24:d=2",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent
  ]);
  const filter = h3ExactStitchFilter([
    { duration: 1.25, hasAudio: true },
    { duration: 0.75, hasAudio: false }
  ], 2, 24);
  run([
    "-i", voiced, "-i", silent,
    "-filter_complex", filter,
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "2", output
  ]);
  const [videoSeconds, audioSeconds] = await Promise.all([
    probeMediaStreamDuration(ffmpeg, output, "0:v:0"),
    probeMediaStreamDuration(ffmpeg, output, "0:a:0")
  ]);
  assert.ok(Math.abs(videoSeconds - 2) <= 0.05, `video duration=${videoSeconds}`);
  assert.ok(Math.abs(audioSeconds - 2) <= 0.05, `audio duration=${audioSeconds}`);
});

test("multi-frame storyboard is cropped into a take-only timeline before video submission", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-agent-sheet-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "parent-sheet.png");
  const outputDir = path.join(root, "storyboards");
  fs.mkdirSync(outputDir, { recursive: true });
  run([
    "-f", "lavfi", "-i", "color=c=gray:s=1080x1280",
    "-vf", [
      "drawbox=x=0:y=0:w=540:h=640:color=0x713a35:t=fill",
      "drawbox=x=540:y=0:w=540:h=640:color=0x355b71:t=fill",
      "drawbox=x=0:y=640:w=540:h=640:color=0x4e7135:t=fill",
      "drawbox=x=540:y=640:w=540:h=640:color=0x6f3571:t=fill",
      "drawbox=x=536:y=0:w=8:h=1280:color=white:t=fill",
      "drawbox=x=0:y=636:w=1080:h=8:color=white:t=fill"
    ].join(","),
    "-frames:v", "1", source
  ]);
  const detected = await analyzeStoryboardSheetGrid(ffmpeg, source, 4);
  assert.equal(detected.ok, true);
  assert.deepEqual(detected.rowColumns, [2, 2]);
  const workflow = new WorkbenchWorkflow({
    store: { assetDir: () => outputDir },
    bridge: {},
    locateFfmpeg: () => ffmpeg,
    stagingRoot: root,
    textGenerator: async () => ({})
  });
  const result = await workflow.cropStoryboardTakeSheet(
    "P01",
    { id: "S01", duration: 4 },
    { id: "S01-T01", panelIndices: [0, 1] },
    { images: [source], imageRoles: [{ type: "storyboard_sheet", entityId: "S01" }] }
  );
  assert.equal(fs.existsSync(result), true);
  assert.ok(fs.statSync(result).size > 100);
  const dimensions = await analyzeImageDimensions(ffmpeg, result);
  assert.equal(dimensions.width, 720);
  assert.equal(dimensions.height, 640);
  run(["-i", result, "-frames:v", "1", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"]);
});

test("regular 3x3 storyboard gutters use the verified uniform-grid fallback", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-agent-sheet-3x3-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "storyboard-sheet-3x3.png");
  run([
    "-f", "lavfi", "-i", "color=c=0x31506b:s=900x1600",
    "-vf", [
      "drawbox=x=0:y=0:w=300:h=533:color=0x713a35:t=fill",
      "drawbox=x=300:y=0:w=300:h=533:color=0x355b71:t=fill",
      "drawbox=x=600:y=0:w=300:h=533:color=0x4e7135:t=fill",
      "drawbox=x=0:y=533:w=300:h=533:color=0x6f3571:t=fill",
      "drawbox=x=300:y=533:w=300:h=533:color=0x35716b:t=fill",
      "drawbox=x=600:y=533:w=300:h=533:color=0x716535:t=fill",
      "drawbox=x=0:y=1066:w=300:h=534:color=0x3f4f71:t=fill",
      "drawbox=x=300:y=1066:w=300:h=534:color=0x713f58:t=fill",
      "drawbox=x=600:y=1066:w=300:h=534:color=0x447135:t=fill",
      "drawbox=x=297:y=0:w=6:h=1600:color=white:t=fill",
      "drawbox=x=597:y=0:w=6:h=1600:color=white:t=fill",
      "drawbox=x=0:y=530:w=900:h=6:color=white:t=fill",
      "drawbox=x=0:y=1063:w=900:h=6:color=white:t=fill"
    ].join(","),
    "-frames:v", "1", source
  ]);
  const detected = await analyzeStoryboardSheetGrid(ffmpeg, source, 9);
  assert.equal(detected.ok, true);
  assert.equal(detected.columns, 3);
  assert.equal(detected.rows, 3);
  assert.equal(detected.cells.length, 9);
  assert.ok(["adaptive-lines", "verified-uniform-grid"].includes(detected.detectionMethod));
});

test("timed hard-cut audit distinguishes a real edit from an unchanged clip", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-agent-cut-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cut = path.join(root, "cut.mp4");
  const flat = path.join(root, "flat.mp4");
  run([
    "-f", "lavfi", "-i", "color=c=red:s=180x320:r=24:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=24:d=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[outv]",
    "-map", "[outv]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", cut
  ]);
  run(["-f", "lavfi", "-i", "color=c=red:s=180x320:r=24:d=2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", flat]);
  const present = await analyzeTimedHardCuts(ffmpeg, cut, [1], 2);
  const missing = await analyzeTimedHardCuts(ffmpeg, flat, [1], 2);
  assert.equal(present.ok, true);
  assert.equal(present.cutsPresent, true);
  assert.equal(present.detected, 1);
  assert.equal(missing.ok, true);
  assert.equal(missing.cutsPresent, false);
  assert.equal(missing.detected, 0);
});
