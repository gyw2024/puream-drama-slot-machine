"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  WorkbenchWorkflow,
  h3ExactStitchFilter,
  probeMediaStreamDuration
} = require("../app/workbench-workflow");

const ffmpeg = path.join(__dirname, "..", "media-tools", "ffmpeg.exe");

function run(args) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true, stdio: "pipe" });
}

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
  run(["-f", "lavfi", "-i", "color=c=gray:s=1080x1280", "-frames:v", "1", source]);
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
  run(["-i", result, "-frames:v", "1", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"]);
});
