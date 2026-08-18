"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  QUALITY_LIMITS,
  analyzeVisualFile,
  assessTechnicalVisualIntegrity,
  assessReferenceAssetLeak
} = require("../app/media-quality");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const {
  FINAL_OUTPUT_LOCK,
  withGenerationBlockTechnicalRepair
} = require("../app/agent-director");

const ffmpeg = path.join(__dirname, "..", "media-tools", "ffmpeg.exe");

function render(output, filters = []) {
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=180x320:r=24:d=2",
    ...filters,
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", output
  ], { windowsHide: true, stdio: "pipe" });
}

test("mandatory technical audit rejects white edge wipes while accepting a complete moving frame", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clean = path.join(root, "clean.mp4");
  const whiteWipe = path.join(root, "white-wipe.mp4");
  render(clean);
  render(whiteWipe, ["-vf", "drawbox=x=0:y=0:w=iw/2:h=ih:color=white:t=fill"]);

  const [cleanVisual, badVisual] = await Promise.all([
    analyzeVisualFile(ffmpeg, clean, 2, QUALITY_LIMITS.technicalVisual.sampleFps),
    analyzeVisualFile(ffmpeg, whiteWipe, 2, QUALITY_LIMITS.technicalVisual.sampleFps)
  ]);
  const cleanDecision = assessTechnicalVisualIntegrity(cleanVisual);
  const badDecision = assessTechnicalVisualIntegrity(badVisual);

  assert.equal(cleanDecision.ok, true);
  assert.equal(cleanVisual.solidEdgeBandFrameCount, 0);
  assert.equal(badDecision.ok, false);
  assert.ok(badVisual.solidEdgeBandFrameCount > 0);
  assert.ok(badDecision.failures.some(item => item.code === "VIDEO_SOLID_EDGE_WIPE_OR_BOARD"));
});

test("mandatory technical audit rejects persistent baked subtitles", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-subtitle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const subtitle = path.join(root, "subtitle.mp4");
  render(subtitle, [
    "-vf",
    "drawtext=text='NO SUBTITLES':x=(w-text_w)/2:y=h-45:fontsize=18:fontcolor=white:borderw=2:bordercolor=black"
  ]);
  const visual = await analyzeVisualFile(ffmpeg, subtitle, 2, QUALITY_LIMITS.technicalVisual.sampleFps);
  const decision = assessTechnicalVisualIntegrity(visual);
  assert.equal(visual.overlayText.detected, true);
  assert.ok(visual.overlayText.persistentFrameCount >= 3);
  assert.equal(decision.ok, false);
  assert.ok(decision.failures.some(item => item.code === "VIDEO_BAKED_TEXT_OR_SUBTITLE"));
});

test("stable thin table highlights are not mistaken for subtitle glyphs", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-table-highlight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const naturalLines = path.join(root, "table-highlights.mp4");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=#24160f:s=180x320:r=24:d=2",
    "-vf", [28, 58, 92, 126].map(x => `drawbox=x=${x}:y=220:w=14:h=2:color=#d9b38c:t=fill`).join(","),
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", naturalLines
  ], { windowsHide: true, stdio: "pipe" });
  const visual = await analyzeVisualFile(ffmpeg, naturalLines, 2, QUALITY_LIMITS.technicalVisual.sampleFps);
  const decision = assessTechnicalVisualIntegrity(visual);
  assert.equal(visual.overlayText.detected, false);
  assert.equal(decision.failures.some(item => item.code === "VIDEO_BAKED_TEXT_OR_SUBTITLE"), false);
});

test("production-only mode reuses a paid stale candidate without audit or regeneration", async () => {
  const candidate = {
    id: "candidate-old-gate",
    entityType: "shot",
    entityId: "S02",
    stage: "shot_video",
    productionRevision: "revision-1",
    createdAt: "2026-08-16T00:00:00.000Z",
    selected: false,
    stale: true,
    filePath: __filename,
    technicalIntegrityAudit: { mandatory: true, version: "older-gate", ok: false }
  };
  const project = {
    id: "P01",
    productionRevision: "revision-1",
    generation: { videoProviderKind: "local-xiangsu" },
    candidates: [candidate]
  };
  const store = {
    getSettings: () => ({ generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    getProject: () => project,
    updateCandidate: (_projectId, candidateId, patch) => Object.assign(project.candidates.find(item => item.id === candidateId), patch),
    confirmCandidate: (_projectId, candidateId) => {
      for (const item of project.candidates) item.selected = item.id === candidateId;
      const selected = project.candidates.find(item => item.id === candidateId);
      selected.stale = false;
      return selected;
    }
  };
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => ffmpeg, stagingRoot: "", textGenerator: async () => ({}) });
  workflow.auditTechnicalShotCandidate = async () => { throw new Error("production-only mode must not audit"); };
  workflow.generateShotVideo = async () => { throw new Error("a paid regeneration must not run"); };
  const recovered = await workflow.generateQualityShotVideo("P01", { id: "S02", number: 2 }, "keyframe");
  assert.equal(recovered.id, candidate.id);
  assert.equal(recovered.selected, true);
  assert.equal(recovered.stale, false);
});

test("a failed Agent generation block receives a new compact repair fingerprint", () => {
  const base = `detailed_description:\nOne story shot.\n\n${FINAL_OUTPUT_LOCK}`;
  const first = withGenerationBlockTechnicalRepair(base, "white edge at 3.5 seconds", "bad-candidate-a:attempt-1");
  const same = withGenerationBlockTechnicalRepair(base, "white edge at 3.5 seconds", "bad-candidate-a:attempt-1");
  const second = withGenerationBlockTechnicalRepair(base, "white edge at 3.5 seconds", "bad-candidate-b:attempt-2");
  assert.equal(first, same, "transient retry of the same repair task must remain idempotent");
  assert.notEqual(first, second, "a newly rejected candidate must force a genuinely new upstream task");
  assert.match(first, /full-frame 9:16/);
  assert.match(first, /direct hard cuts only/);
  assert.match(first, /identity pictures/);
  assert.equal(first.includes(FINAL_OUTPUT_LOCK), true);
  assert.doesNotMatch(first.replace(FINAL_OUTPUT_LOCK, ""), /[\u3400-\u9fff]/);
});

test("reference asset frames are a mandatory failure instead of valid story footage", () => {
  const visual = {
    sampleHashes: [
      { time: 0, hash: "00".repeat(32) },
      { time: 1.25, hash: "ff".repeat(32) }
    ]
  };
  const decision = assessReferenceAssetLeak(visual, [{
    hash: "ff".repeat(32),
    candidateId: "character-intro-1",
    entityId: "C01",
    sourceStage: "character_intro",
    label: "C01 identity reference"
  }]);
  assert.equal(decision.ok, false);
  assert.equal(decision.strongest.time, 1.25);
  assert.ok(decision.failures.some(item => item.code === "VIDEO_REFERENCE_ASSET_BOARD_LEAK"));
});

test("an atomic provider clip is audited before stitching and rejects black plus storyboard-board playback", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-block-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reference = path.join(root, "identity.png");
  const video = path.join(root, "provider-block.mp4");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=white:s=180x320",
    "-vf", "drawbox=x=70:y=40:w=40:h=240:color=black:t=fill",
    "-frames:v", "1", reference
  ], { windowsHide: true, stdio: "pipe" });
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=180x320:r=24:d=0.75",
    "-f", "lavfi", "-i", "color=black:s=180x320:r=24:d=0.5",
    "-f", "lavfi", "-i", "color=white:s=180x320:r=24:d=1.25",
    "-filter_complex", "[2:v]drawbox=x=70:y=40:w=40:h=240:color=black:t=fill[asset];[0:v][1:v][asset]concat=n=3:v=1:a=0[outv]",
    "-map", "[outv]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", video
  ], { windowsHide: true, stdio: "pipe" });
  const jobs = [];
  const project = { candidates: [] };
  const workflow = new WorkbenchWorkflow({
    store: {
      getProject: () => project,
      updateJob: (_projectId, _jobId, patch) => jobs.push(patch)
    },
    bridge: {},
    locateFfmpeg: () => ffmpeg,
    stagingRoot: root,
    textGenerator: async () => ({})
  });
  const audit = await workflow.auditAgentGenerationBlockResult("P01", {
    block: { id: "S01-B01-A02", authoredDuration: 2.5, providerDuration: 5 },
    references: {
      images: [reference],
      imageRoles: [{ type: "storyboard_generation_block_sheet", sourceStage: "storyboard_sheet", entityId: "S01", candidateId: "sheet-1", label: "S01 generated timeline sheet" }]
    }
  }, { jobId: "job-1", filePath: video });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some(item => item.code === "VIDEO_BLANK_OR_SOLID_FRAME"));
  assert.ok(audit.failures.some(item => item.code === "VIDEO_REFERENCE_ASSET_BOARD_LEAK"));
  assert.equal(jobs.at(-1).localQualityRejected, true);
});

test("a clean live-story panel anchor may match the first video frame without being mislabeled as an asset board", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-live-anchor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const anchor = path.join(root, "live-story-anchor.png");
  const video = path.join(root, "live-story.mp4");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=180x320:r=24",
    "-frames:v", "1", anchor
  ], { windowsHide: true, stdio: "pipe" });
  render(video);
  const jobs = [];
  const workflow = new WorkbenchWorkflow({
    store: {
      getProject: () => ({ candidates: [] }),
      updateJob: (_projectId, _jobId, patch) => jobs.push(patch)
    },
    bridge: {},
    locateFfmpeg: () => ffmpeg,
    stagingRoot: root,
    textGenerator: async () => ({})
  });
  const audit = await workflow.auditAgentGenerationBlockResult("P01", {
    block: { id: "S01-B01-A01", authoredDuration: 2, providerDuration: 5 },
    references: {
      images: [anchor],
      imageRoles: [{
        type: "storyboard_panel_anchor",
        sourceStage: "storyboard_sheet",
        entityId: "S01",
        candidateId: "sheet-1",
        label: "clean live-story opening anchor"
      }]
    }
  }, { jobId: "job-1", filePath: video });
  assert.equal(audit.ok, true);
  assert.equal(audit.referenceLeak.ok, true);
  assert.equal(audit.failures.some(item => item.code === "VIDEO_REFERENCE_ASSET_BOARD_LEAK"), false);
  assert.equal(jobs.at(-1).localQualityRejected, false);
});

test("H3 generation accepts the first download without local review or atomic fallback", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const start = source.indexOf("async generateHailuoAgentShotVideo");
  const end = source.indexOf("async ensureHailuoPromptSpec", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(body, /auditAgentGenerationBlockResult/);
  assert.doesNotMatch(body, /useFallback/);
  assert.doesNotMatch(body, /atomic_fallback/);
  assert.doesNotMatch(body, /AGENT_GENERATION_BLOCK_TECHNICAL_INTEGRITY_FAILED/);
  assert.doesNotMatch(body, /agent_continuity_atomic_fallback/);

  const project = {
    id: "P01",
    shots: [{ id: "S01", number: 1, duration: 5 }],
    candidates: [{ id: "cand-1", entityType: "shot", entityId: "S01", stage: "shot_video" }],
    generation: { engine: "hailuo-h3" }
  };
  let submitted = 0;
  const workflow = new WorkbenchWorkflow({
    store: {
      getSettings: () => ({ generation: { qualityGatesEnabled: false } }),
      getProject: () => project,
      saveProject: next => Object.assign(project, next),
      updateCandidate: (_projectId, candidateId, patch) => Object.assign(project.candidates.find(item => item.id === candidateId), patch)
    },
    bridge: {},
    locateFfmpeg: () => ffmpeg,
    stagingRoot: "",
    textGenerator: async () => ({})
  });
  workflow.prepareHailuoAgentShotTakes = async () => ({
    plan: { duration: 5, mode: "keyframe", sourceFingerprint: "fp", generationBlocks: [{ id: "S01-B01" }] },
    prepared: [{
      block: {
        id: "S01-B01",
        takeIds: ["T01"],
        takes: [{ id: "T01", start: 0, end: 5 }],
        authoredDuration: 5,
        providerDuration: 5,
        strategy: "continuous_single",
        start: 0,
        end: 5
      },
      blockShot: { id: "S01" },
      references: { images: [], imageRoles: [] },
      prompt: "最终输出锁：禁止字幕",
      fallbackPrepared: [{ block: { id: "S01-B01-A01" } }],
      preflightFallback: false
    }],
    promptManifest: "最终输出锁：禁止字幕",
    internalGenerationBlock: false
  });
  workflow.submitVideo = async () => {
    submitted += 1;
    return { id: "cand-1", jobId: "job-1", taskId: "task-1", filePath: __filename, chargeYuan: 1, settlementStatus: "charged" };
  };
  workflow.auditAgentGenerationBlockResult = async () => {
    throw new Error("synthesis results must not be reviewed");
  };
  workflow.stitchAgentCameraTakes = async () => {
    throw new Error("atomic fallback stitch must not run");
  };
  const candidate = await workflow.generateHailuoAgentShotVideo(
    "P01",
    project,
    project.shots[0],
    { generation: { qualityGatesEnabled: false } },
    "keyframe",
    { images: [] }
  );
  assert.equal(submitted, 1);
  assert.equal(candidate.id, "cand-1");
  assert.equal(candidate.prompt, "最终输出锁：禁止字幕");
});
