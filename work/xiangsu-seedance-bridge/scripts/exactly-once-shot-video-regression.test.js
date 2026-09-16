"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { promptReviewSourceFingerprint, WorkbenchWorkflow } = require("../app/workbench-workflow");

test("strict once H3 generation never retries a transient submit failure", async () => {
  const project = {
    id: "P01",
    shots: [{ id: "S01", number: 1, duration: 5 }],
    candidates: [],
    generation: { engine: "hailuo-h3" }
  };
  const workflow = new WorkbenchWorkflow({
    store: {
      getSettings: () => ({ generation: { qualityGatesEnabled: false } }),
      getProject: () => project,
      saveProject: next => Object.assign(project, next),
      updateCandidate: () => {}
    },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    textGenerator: async () => ({})
  });
  workflow.prepareHailuoAgentShotTakes = async () => ({
    plan: { duration: 5, sourceFingerprint: "fp", generationBlocks: [{ id: "S01-B01" }] },
    prepared: [{
      block: { id: "S01-B01", takeIds: ["T01"], takes: [{ id: "T01" }], providerDuration: 5 },
      references: { images: [], imageRoles: [] },
      prompt: "prompt"
    }],
    promptManifest: "prompt",
    internalGenerationBlock: false
  });
  let calls = 0;
  workflow.submitVideo = async () => {
    calls += 1;
    throw Object.assign(new Error("temporary upstream failure"), { code: "SERVER_ERROR", retryable: true });
  };
  await assert.rejects(
    workflow.generateHailuoAgentShotVideo("P01", project, project.shots[0], {}, "asset_direct", {}, { exactlyOnce: true }),
    /temporary upstream failure/
  );
  assert.equal(calls, 1);
});

test("strict once policy protects one stable provider identity while transport recovery stays possible", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const bridgeSource = fs.readFileSync(path.join(__dirname, "..", "app", "bridge-client.js"), "utf8");
  const statusSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-status.js"), "utf8");
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const runner = fs.readFileSync(path.join(__dirname, "run-jiubao-real-full-e2e.js"), "utf8");
  assert.match(source, /const maxSubmitAttempts = resolveAttemptLimit\(this\.videoSubmissionRecoveryAttempts, UNLIMITED_ATTEMPTS\)/);
  assert.match(source, /submissionPreparationAttemptCount: priorPreparationCount \+ 1/);
  assert.match(source, /submissionAttemptCount: \(Number\(currentJob\.submissionAttemptCount\) \|\| 0\) \+ 1/);
  assert.match(bridgeSource, /phase: "upstream_request_starting"/);
  assert.match(bridgeSource, /phase: "submit_request_started"/);
  assert.match(bridgeSource, /phase: "submit_response_missing_task_id"/);
  assert.match(statusSource, /key: upstreamCreated \? "generating" : "submitting"/);
  assert.match(rendererSource, /上游尚无任务/);
  assert.match(rendererSource, /上游任务 \$\{upstreamActiveJobs\.length\} 个正在生成/);
  assert.match(source, /upstreamSubmissionState: "created"/);
  assert.match(source, /hasCreatedUpstreamVideoTask\(item\)/);
  assert.doesNotMatch(source, /exactlyOnce && priorAttemptCount >= 1/);
  assert.match(source, /VIDEO_EXACTLY_ONCE_SUBMISSION_ALREADY_ATTEMPTED/);
  assert.match(runner, /generateAllShotVideos\(PROJECT_ID, \{ promptPrepared: true, exactlyOnce: true \}\)/);
  assert.match(runner, /VIDEO_EXACTLY_ONCE_VIOLATION/);
});

test("the first four Jiubao draws use isolated once-only ledgers and exact S03 speakers", () => {
  const runner = fs.readFileSync(path.join(__dirname, "run-jiubao-package-first-shot-once.js"), "utf8");
  assert.match(runner, /"S01-B01": "first-shot"/);
  assert.match(runner, /"S02-B01": "second-shot"/);
  assert.match(runner, /"S03-B01": "third-shot"/);
  assert.match(runner, /"S03-B02": "fourth-shot-priority-v2"/);
  assert.match(runner, /sourceDialogueId: "D006", speakerId: "C01", text: "看见了？别装可怜。"/u);
  assert.match(runner, /sourceDialogueId: "D007", speakerId: "C03", text: "六年婚姻，不值一张券？"/u);
  assert.match(runner, /sourceDialogueId: "D008", speakerId: "C01", text: "至少它能带我进门。"/u);
  assert.match(runner, /if \(submitBoundaryCount > 1\)/);
});

test("verified built-in voices auto-bind by gender and age without impersonating a real library speaker", () => {
  const voicePath = __filename;
  const workflow = new WorkbenchWorkflow({
    store: {
      listVoiceLibrary: () => [{
        id: "builtin_voice_01",
        builtIn: true,
        filePath: voicePath,
        profileVerified: true,
        gender: "male",
        ageBand: "老年"
      }]
    },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    textGenerator: async () => ({})
  });
  const match = workflow.findReusableVoice({ id: "C10", name: "银发代表甲", gender: "male", ageBand: "老年" });
  assert.equal(match.entry.id, "builtin_voice_01");
  assert.equal(match.reason, "builtin-age-gender");
});

test("runtime identity and voice bindings do not invalidate approved production prompts", () => {
  const base = {
    productionRevision: "R01",
    script: { raw: "顾云舟：起来。", sourceDialogueLedger: [{ id: "D001", speakerId: "C01", speaker: "顾云舟", text: "起来。" }] },
    productionPlan: {},
    promptIntake: {},
    product: { name: "九宝茶" },
    generation: { mode: "asset_direct" },
    characters: [{ id: "C01", name: "顾云舟", gender: "male", ageBand: "middle", appearanceDescription: "五十多岁，深色西装" }],
    scenes: [{ id: "SC01", name: "会场" }],
    assetLibraries: { props: [], wardrobes: [], voices: [] },
    shots: [{ id: "S01", number: 1, sceneId: "SC01", dialogueTurns: [{ sourceDialogueId: "D001", speakerId: "C01", speaker: "顾云舟", text: "起来。" }] }]
  };
  const runtimeBound = JSON.parse(JSON.stringify(base));
  Object.assign(runtimeBound.characters[0], {
    activeIdentityCandidateId: "card-one",
    activeIdentitySelectedAt: "2026-09-01T00:00:00.000Z",
    visualAssetLibraryId: "asset-one",
    voiceLibraryId: "builtin_voice_01",
    voiceLibraryBindingMode: "automatic"
  });
  runtimeBound.assetLibraries.voices.push({
    id: "builtin_voice_01",
    characterId: "C01",
    filePath: "C:\\runtime\\voice.wav",
    duration: 4.32,
    source: "global-voice-library",
    mediaProbeVerified: true
  });
  runtimeBound.generation.videoProviderPlan = {
    version: "agent-director-runtime",
    shots: 1,
    calls: 1,
    computedAt: "2026-09-01T00:00:00.000Z"
  };
  assert.equal(promptReviewSourceFingerprint(runtimeBound), promptReviewSourceFingerprint(base));

  const authoredChange = structuredClone(runtimeBound);
  authoredChange.characters[0].voiceDescription = "更低沉、克制的中老年男声";
  assert.notEqual(promptReviewSourceFingerprint(authoredChange), promptReviewSourceFingerprint(base));
});

test("reference-library rebuild preserves approved wardrobe prompt metadata", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(source, /project\.assetLibraries\.wardrobes\.push\(\{\s*\.\.\.\(prior \|\| \{\}\)/);
});
