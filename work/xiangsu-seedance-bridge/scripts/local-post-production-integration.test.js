"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, probeMediaStreamDuration } = require("../app/workbench-workflow");
const { validateJianyingDraft } = require("../app/jianying-draft-export");
const ffmpeg = path.resolve(__dirname, "..", "media-tools", "ffmpeg.exe");
const taskRoot = path.resolve(__dirname, "..", "..", "..", "..", ".codex_tests", "TASK-20260905-DRAMA-JIANYING-DRAFT-001", "local-post-integration");

function media(file, seconds, sound) {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=160x90:r=24:d=${seconds}`];
  if (sound) args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:a", "aac");
  else args.push("-an");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", file);
  execFileSync(ffmpeg, args, { windowsHide: true, timeout: 20000, stdio: "pipe" });
}

function fixture() {
  fs.mkdirSync(taskRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(taskRoot, "case-"));
  const store = new WorkbenchStore(path.join(root, "store"));
  const settings = store.getSettings();
  settings.generation = { ...settings.generation, qualityGatesEnabled: false, auditBlueprintEnabled: false };
  store.saveSettings(settings);
  const project = store.createProject("本地后期横屏实测");
  project.generation = { ...project.generation, aspectRatio: "16:9", qualityGatesEnabled: false, targetDurationSeconds: 2 };
  project.shots = [
    { id: "S01", number: 1, duration: 1, action: "脚步停下，人物拿起信封", dialogueTurns: [{ speakerId: "C01", speaker: "甲", text: "回来了。", start: 0.35, end: 1.15 }], sceneId: "SC01" },
    { id: "S02", number: 2, duration: 1, action: "人物无声打开门后停下", dialogueTurns: [] }
  ];
  project.characters = [{ id: "C01", name: "甲" }];
  store.saveProject(project);
  const source1 = path.join(root, "voiced.mp4"), source2 = path.join(root, "silent.mp4");
  media(source1, 1.8, true); media(source2, 1.6, false);
  store.addCandidate(project.id, { id: "v1", entityType: "shot", entityId: "S01", stage: "shot_video", filePath: source1, selected: true });
  store.addCandidate(project.id, { id: "v2", entityType: "shot", entityId: "S02", stage: "shot_video", filePath: source2, selected: true });
  let paidCalls = 0;
  const denyPaid = () => { paidCalls++; throw new Error("NO_PAID_GENERATION_ALLOWED_IN_LOCAL_POST_TEST"); };
  const workflow = new WorkbenchWorkflow({ store, bridge: { submit: denyPaid, submitScoped: denyPaid }, locateFfmpeg: () => ffmpeg, stagingRoot: root, textGenerator: denyPaid });
  workflow.ensureStageDependencies = denyPaid;
  const draftRoot = path.join(root, "native-drafts"); fs.mkdirSync(draftRoot);
  return { root, store, workflow, projectId: project.id, source1, source2, draftRoot, paidCalls: () => paidCalls };
}

test("whole roughcut -> Jianying pipeline preserves actual silent+voiced length and landscape, with editable subtitles and SFX", async () => {
  const f = fixture();
  const a = f.workflow.stitchProject(f.projectId), b = f.workflow.stitchProject(f.projectId);
  assert.equal(f.workflow.hasActiveOperation(f.projectId), true);
  await Promise.all([a,b]);
  const project = f.store.getProject(f.projectId);
  assert.equal(project.postProductionMixResult.mode, "separate-draft-tracks");
  assert.equal(project.postProductionMixResult.applied, false);
  assert.equal(project.roughCutAudioCleanup.shots.length, 2);
  assert.ok(project.roughCutAudioCleanup.shots[1].sourceDurationSeconds >= 1.58, "silent clip must use real video duration, not authored one second");
  const actual = await probeMediaStreamDuration(ffmpeg, project.roughCutVideoPath, "0:v:0");
  assert.ok(actual >= 3.35 && actual <= 3.5, `actual=${actual}`);
  const metadata = execFileSync(ffmpeg, ["-hide_banner", "-i", project.roughCutVideoPath, "-f", "null", "-"], { windowsHide: true, timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  void metadata;
  const [one,two] = await Promise.all([f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot }), f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot })]);
  assert.equal(one.draftId, two.draftId);
  const { content, manifest } = await validateJianyingDraft(one.draftPath);
  assert.ok(content.canvas_config.width > content.canvas_config.height, "landscape canvas is preserved");
  assert.deepEqual(content.tracks.filter(lane => lane.type === "video").map(lane => lane.segments.length), [2]);
  assert.ok(content.tracks.some(lane => lane.type === "text"));
  assert.ok(content.tracks.some(lane => lane.type === "audio"));
  assert.equal(manifest.soundsBakedIntoVideo, false);
  assert.equal(manifest.subtitlesBakedIntoVideo, false);
  assert.equal(manifest.resources.filter(resource => /\.mp4$/i.test(resource.source)).length, 1, "clean roughcut is copied once and split nondestructively");
  assert.equal(JSON.parse(content.materials.texts[0].content).text, "回来了。");
  assert.ok(Math.abs(content.duration / 1e6 - actual) < 0.1);
  assert.equal(f.workflow.hasActiveOperation(f.projectId), false);
  assert.equal(f.paidCalls(), 0);
});

test("raw export uses real media duration without first generating assets or baking effects", async () => {
  const f = fixture();
  const output = await f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot });
  const { content, manifest } = await validateJianyingDraft(output.draftPath);
  assert.ok(content.duration >= 3.35e6, `actual=${content.duration}`);
  assert.equal(manifest.resources.filter(resource => /\.mp4$/i.test(resource.source)).length, 2);
  assert.equal(f.paidCalls(), 0);
  assert.equal(f.workflow.hasActiveOperation(f.projectId), false);
});

test("missing media and cancellation release local locks and allow safe retry", async () => {
  const f = fixture();
  fs.renameSync(f.source2, `${f.source2}.keep`);
  await assert.rejects(f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot }), error => error.code === "JIANYING_VIDEOS_INCOMPLETE");
  assert.equal(f.workflow.hasActiveOperation(f.projectId), false);
  assert.equal(f.store.getProject(f.projectId).postProductionTask.status, "failed");
  fs.renameSync(`${f.source2}.keep`, f.source2);
  const pending = f.workflow.stitchProject(f.projectId);
  assert.equal(f.workflow.cancelPostProduction(f.projectId).cancelled, true);
  await assert.rejects(pending, error => error.code === "LOCAL_MEDIA_CANCELLED");
  assert.equal(f.workflow.hasActiveOperation(f.projectId), false);
  assert.equal(f.store.getProject(f.projectId).postProductionTask.status, "cancelled");
  const retry = await f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot });
  await validateJianyingDraft(retry.draftPath);
  assert.equal(f.store.getProject(f.projectId).postProductionTask.status, "completed");
  assert.equal(f.paidCalls(), 0);
});

test("local export scope prevents conflicting roughcut, and changed subtitle source exports a fresh draft", async () => {
  const f = fixture();
  let release;
  const pending = f.workflow.runLocalPostProduction(f.projectId, "roughcut", () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot }), error => error.code === "LOCAL_POST_BUSY");
  release({ ok: true }); await pending;
  const first = await f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot });
  const project = f.store.getProject(f.projectId); project.shots[0].dialogueTurns[0].text = "看到了。"; f.store.saveProject(project);
  const second = await f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot });
  assert.notEqual(first.draftId, second.draftId);
  await validateJianyingDraft(first.draftPath); await validateJianyingDraft(second.draftPath);
  assert.equal(f.paidCalls(), 0);
});

test("cancelling an orphaned persisted local task clears only its local lock and permits retry", async () => {
  const f = fixture();
  const project = f.store.getProject(f.projectId);
  project.postProductionTask = { kind: "jianying", status: "running" };
  project.automation = { status: "running", stage: "shot_video", message: "upstream task retained" };
  f.store.saveProject(project);
  const upstreamBefore = f.store.getProject(f.projectId).automation;
  assert.equal(f.workflow.cancelPostProduction(f.projectId).recovered, true);
  const recovered = f.store.getProject(f.projectId);
  assert.equal(recovered.postProductionTask.status, "interrupted");
  assert.deepEqual(recovered.automation, upstreamBefore);
  const output = await f.workflow.exportJianyingDraft(f.projectId, { draftRoot: f.draftRoot });
  await validateJianyingDraft(output.draftPath);
  assert.equal(f.paidCalls(), 0);
});
