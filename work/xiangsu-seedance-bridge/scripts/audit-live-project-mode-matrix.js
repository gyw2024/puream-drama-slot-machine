"use strict";

// Offline contract audit for the four Hailuo temporal modes. This stops at
// prompt review and never calls a provider or submits an image/video job.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

const rawSourcePath = String(process.argv[2] || "").trim();
const rawOutputRoot = String(process.argv[3] || "").trim();
if (!rawSourcePath || !rawOutputRoot) {
  throw new Error("usage: node scripts/audit-live-project-mode-matrix.js <source project.json> <output root>");
}
const sourcePath = path.resolve(rawSourcePath);
const outputRoot = path.resolve(rawOutputRoot);
const modes = ["keyframe", "continuation", "smart", "storyboard_sheet"];

function digest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function cjkOutsideDialogue(prompt) {
  return String(prompt || "")
    .replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, "")
    .match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
}

function dialogueBlocks(prompt) {
  return [...String(prompt || "").matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)]
    .map(match => String(match[1] || "").trim());
}

function spokenTurns(shot) {
  return (Array.isArray(shot?.dialogueTurns) ? shot.dialogueTurns : [])
    .map(turn => String(turn?.text || turn?.spokenText || "").trim())
    .filter(Boolean);
}

function hasCompleteTimeline(prompt) {
  const text = String(prompt || "");
  if (!/^visual_timeline:/mi.test(text)) return false;
  if (!/\bV\d+=\S[\s\S]*?\bC\d+=\S/i.test(text)) return false;
  if (!/\b\d+(?:\.\d+)?-\d+(?:\.\d+)?s@V\d+\s+state=\S[^\n]*/i.test(text)) return false;
  if (!/temporal_contract:/i.test(text)) return false;
  return true;
}

function assertVideoPrompt(prompt, shot, plannedVideos) {
  const text = String(prompt || "").trim();
  assert.ok(text.length > 20, `${shot.id} video prompt must be non-empty`);
  assert.match(text, /^production:\S+;\d+(?:\.\d+)?s;9:16;mode=/i);
  assert.match(text, /speech_boundary:/i);
  assert.equal(cjkOutsideDialogue(text).length, 0, `${shot.id} has Chinese outside <d> dialogue blocks`);
  assert.equal((text.match(/<d>/gi) || []).length, dialogueBlocks(text).length, `${shot.id} dialogue tags must be balanced`);
  assert.deepEqual(dialogueBlocks(text), spokenTurns(shot), `${shot.id} dialogue must be exact and in source order`);
  assert.equal(dialogueBlocks(text).length, spokenTurns(shot).length, `${shot.id} must preserve every dialogue line`);

  for (const line of text.split(/\n+/).filter(item => /<d>\s*\[Chinese\]/i.test(item))) {
    assert.match(line, /\bT=[^;]+;/i, `${shot.id} line missing tone (T)`);
    assert.match(line, /\bA=[^;]+;/i, `${shot.id} line missing action (A)`);
    assert.match(line, /\bmouth=\S+/i, `${shot.id} line missing mouth owner`);
    assert.match(line, /\bL=[^.\n]+/i, `${shot.id} line missing listener reaction (L)`);
  }
  assert.equal(hasCompleteTimeline(text), true, `${shot.id} visual timeline must contain action/camera and before/after state`);
  assert.match(text, /continuity:/i);

  // Do not prime the final video model with screen-text concepts. Static
  // storyboard prompts carry the explicit image instruction instead.
  assert.doesNotMatch(text, /字幕|字卡|屏幕文字|可读文字|伪文字|水印|subtitles?|captions?|on[- ]screen\s+text|screen\s+text|readable\s+text|watermarks?|title\s+cards?/i,
    `${shot.id} final video prompt must not mention screen-text concepts`);
  assert.doesNotMatch(text.replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, ""), /[\u3400-\u9fff\uf900-\ufaff]/,
    `${shot.id} non-dialogue video metadata must remain English`);
  assert.doesNotMatch(text, /\b(?:reacti|vis|motivat|synchroniz|restrain|stabl|the|a|an)\.?$/i,
    `${shot.id} prompt must not end with a truncated English word`);
  assert.doesNotMatch(text, /\b(?:to the a|cut to the a|visible reacti|motivated reacti)\b/i,
    `${shot.id} prompt contains a known half-word/truncation pattern`);

  const speakers = (Array.isArray(shot?.dialogueTurns) ? shot.dialogueTurns : [])
    .map(turn => String(turn?.speakerId || turn?.speaker || "").trim())
    .filter(Boolean);
  const changedSpeaker = speakers.some((speaker, index) => index > 0 && speaker !== speakers[index - 1]);
  if (changedSpeaker) assert.match(text, /hard cut|shot-reverse-shot/i, `${shot.id} speaker change needs a hard cut/shot-reverse-shot contract`);
  if (plannedVideos.length) assert.match(text, /<Video\s+\d+>=/i, `${shot.id} planned video references must be bound in prompt`);
}

function assertStoryboardPrompt(prompt, shot, stage) {
  const text = String(prompt || "").trim();
  assert.ok(text.length > 40, `${shot.id}/${stage} storyboard prompt must be non-empty`);
  assert.match(text, /字幕|文字|伪文字|水印|screen\s+text|readable\s+text|watermark/i,
    `${shot.id}/${stage} storyboard prompt must explicitly forbid readable screen text`);
  // The prompt may mention rejected layouts as part of its positive contract;
  // this audit only requires that the output shape is explicitly single-frame
  // (the production prompt carries that instruction).
  assert.match(text, /单张|一张|single\s+(?:real|cinematic)\s+(?:film|story)\s+frame/i,
    `${shot.id}/${stage} storyboard prompt must state a single-frame output`);
}

function assertModeReferences(mode, reviewed, videos, storyboards) {
  const shots = Array.isArray(reviewed.shots) ? reviewed.shots : [];
  assert.equal(videos.length, shots.length, `${mode} must create one video prompt per shot`);
  assert.equal(shots.every(shot => storyboards.some(item => item.entityId === shot.id)), true,
    `${mode} must bind storyboard prompts to every shot`);
  const plans = shots.map(shot => shot.promptReviewReferencePlan?.videos || []);
  if (mode === "keyframe" || mode === "storyboard_sheet") {
    assert.equal(plans.every(entries => entries.length === 0), true, `${mode} must not inject previous video references`);
  } else if (mode === "continuation") {
    assert.equal(plans[0]?.length || 0, 0, "continuation opening must not use a previous video");
    assert.equal(plans.slice(1).every(entries => entries.length === 1 && entries[0].type === "previous_shot"), true,
      "continuation chain shots must use exactly one previous-shot reference");
  } else if (mode === "smart") {
    assert.equal(plans[0]?.length || 0, 0, "smart opening must not use a previous video");
    assert.equal(plans.slice(1).some(entries => entries.length === 1 && entries[0].type === "previous_shot"), true,
      "smart mode needs a same-scene continuation branch");
    assert.equal(plans.slice(1).some(entries => entries.length === 0), true,
      "smart mode needs a scene-cut/keyframe branch");
  }
}

async function main() {
  if (!fs.existsSync(sourcePath)) throw new Error(`source project.json not found: ${sourcePath}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const results = [];

  for (const mode of modes) {
    const root = path.join(outputRoot, mode);
    fs.mkdirSync(root, { recursive: true });
    const store = new WorkbenchStore(root);
    const created = store.createProject(`mode-audit-${mode}`, { engine: "hailuo-h3", mode });
    const clone = JSON.parse(JSON.stringify(source));
    clone.id = created.id;
    clone.title = `mode-audit-${mode}`;
    clone.promptReview = null;
    clone.currentOperation = null;
    clone.status = "analyzed";
    clone.generation = {
      ...(clone.generation || {}),
      engine: "hailuo-h3",
      mode,
      modeConfirmed: true,
      modeConfirmedAt: new Date().toISOString()
    };
    store.saveProject(clone);
    const workflow = new WorkbenchWorkflow({
      store,
      bridge: new Proxy({}, { get: () => () => { throw new Error("mode audit must not submit media"); } }),
      locateFfmpeg: () => "",
      stagingRoot: path.join(root, "staging")
    });
    const reviewed = await workflow.preparePromptReviewBundle(created.id, { autoApprove: false });
    const items = reviewed.promptReview?.items || [];
    const videos = items.filter(item => item.group === "videos");
    const storyboards = items.filter(item => item.group === "storyboards");
    assert.equal(reviewed.promptReview?.status, "ready", `${mode} prompt review must be ready`);
    assertModeReferences(mode, reviewed, videos, storyboards);
    for (const shot of reviewed.shots || []) {
      const shotVideos = videos.filter(item => item.entityId === shot.id);
      const shotStoryboards = storyboards.filter(item => item.entityId === shot.id);
      assert.equal(shotVideos.length, 1, `${mode}/${shot.id} must have one video prompt`);
      for (const item of shotVideos) assertVideoPrompt(item.prompt, shot, shot.promptReviewReferencePlan?.videos || []);
      for (const item of shotStoryboards) assertStoryboardPrompt(item.prompt, shot, item.stage);
    }
    results.push({
      mode,
      projectId: reviewed.id,
      status: reviewed.promptReview.status,
      counts: reviewed.promptReview.counts,
      shots: (reviewed.shots || []).map(shot => ({
        id: shot.id,
        duration: shot.duration,
        dialogues: spokenTurns(shot),
        referenceImages: shot.promptReviewReferencePlan?.images || [],
        referenceVideos: shot.promptReviewReferencePlan?.videos || [],
        storyboardStages: storyboards.filter(item => item.entityId === shot.id).map(item => item.stage),
        storyboardPromptSha256: storyboards.filter(item => item.entityId === shot.id).map(item => digest(item.prompt)),
        videoPromptSha256: digest(videos.find(item => item.entityId === shot.id)?.prompt)
      }))
    });
  }

  const report = {
    ok: true,
    contract: "h3-final-prompt-v2",
    sourceProjectId: source.id,
    sourcePath,
    createdAt: new Date().toISOString(),
    mediaSubmissions: 0,
    apiCalls: 0,
    results
  };
  const reportPath = path.join(outputRoot, "mode-matrix-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath, mediaSubmissions: 0, apiCalls: 0, modes: results.map(item => ({ mode: item.mode, projectId: item.projectId, counts: item.counts })) }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || "MODE_MATRIX_AUDIT_FAILED", message: error.message, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 1;
});
