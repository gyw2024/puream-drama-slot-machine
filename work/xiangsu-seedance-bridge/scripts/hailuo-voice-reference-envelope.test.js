"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { auditVoiceReferenceFile } = require("../app/media-quality");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

const ffmpeg = path.join(__dirname, "..", "media-tools", "ffmpeg.exe");

test("H3 preflight turns a legacy 1.49-second voice into a selected provider-safe reference", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-h3-voice-envelope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const source = path.join(root, "legacy-short-voice.wav");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=1.491",
    "-ac", "1", "-c:a", "pcm_s16le", source
  ], { windowsHide: true, stdio: "pipe" });

  const store = new WorkbenchStore(path.join(root, "workbench"));
  let project = store.createProject("H3 短音色提交前修复");
  project.characters = [{
    id: "C01",
    number: 1,
    name: "林娜",
    gender: "女",
    age: "中年",
    voiceDescription: "带哭腔的中年女性"
  }];
  project.shots = [{ id: "S01", number: 1, duration: 10, dialogueTurns: [{ speakerId: "C01", speaker: "林娜", text: "我妈等了你整整三十年！" }] }];
  store.saveProject(project);
  const legacy = store.addCandidate(project.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_voice",
    filePath: source,
    duration: 1.491,
    mediaProbeVerified: true,
    selected: true
  });

  project = store.getProject(project.id);
  const references = {
    audios: [{
      path: legacy.filePath,
      duration: legacy.duration,
      characterId: "C01",
      characterName: "林娜",
      candidateId: legacy.id,
      sourceStage: "character_voice",
      mediaProbeVerified: true
    }]
  };
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => ffmpeg,
    stagingRoot: root,
    textGenerator: async () => ({})
  });

  await workflow.verifyHailuoVoiceReferences(project, project.shots[0], references);
  const prepared = references.audios[0];
  assert.notEqual(prepared.path, source);
  assert.ok(prepared.duration >= 3.05 && prepared.duration <= 3.25, `duration=${prepared.duration}`);
  const decoded = await auditVoiceReferenceFile(ffmpeg, prepared.path, prepared.duration);
  assert.equal(decoded.ok, true);

  const saved = store.getProject(project.id);
  const selected = saved.candidates.filter(item => item.entityType === "character" && item.entityId === "C01" && item.stage === "character_voice" && item.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].filePath, prepared.path);
  assert.equal(selected[0].h3VoiceNormalization.sourceCandidateId, legacy.id);
  assert.match(selected[0].prompt, /不进入成片音轨/);
});
