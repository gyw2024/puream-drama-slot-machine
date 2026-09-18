"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  promptReviewReferencePlan,
  resolveHailuoApiModeForStrategy,
  resolveShotVideoStrategy,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese,
  shotReferenceCharacterIds
} = require("../app/workbench-workflow");
const { characterEligibilityView, characterRegistry } = require("../app/asset-eligibility");
const { viewCompatibility } = require("../app/asset-decision-contract");
const { validateProviderPayload } = require("../app/puream-video-adapters");
const {
  REQUIRED_SECTIONS,
  BASE_REQUIRED_SECTIONS,
  assertHailuoFinalPromptIntegrity,
  collectDialogue,
  containsCjkOutsideDialogue
} = require("../app/hailuo-h3-prompt");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");

function fixture() {
  const project = {
    generation: { mode: "asset_direct", aspectRatio: "9:16" },
    characters: [
      { id: "C01", name: "林曼秋" },
      { id: "C02", name: "哈桑" }
    ],
    scenes: [{ id: "SC01", name: "玻璃长廊" }],
    assetLibraries: { props: [], wardrobes: [] },
    product: {},
    shots: []
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 7,
    sceneId: "SC01",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    action: "林曼秋询问邀请券，哈桑回答后搂住她。",
    actionEn: "C01 asks about the invitation; C02 answers and pulls C01 into a close embrace.",
    stateBefore: "两人隔着半步对视。",
    stateBeforeEn: "C01 and C02 face each other half a step apart.",
    stateAfter: "哈桑搂住林曼秋。",
    stateAfterEn: "C02 holds C01 in a close embrace.",
    dialogueTurns: [
      { speakerId: "C01", speaker: "林曼秋", listenerIds: ["C02"], text: "邀请券带了吗？", onScreen: true },
      { speakerId: "C02", speaker: "哈桑", listenerIds: ["C01"], text: "带了，先给我奖励。", onScreen: true }
    ],
    subshots: [
      {
        number: 1,
        start: 0,
        end: 3.2,
        actionEn: "C01 watches the invitation in C02's hand and asks the question without changing position.",
        cameraEn: "Stable medium close-up on C01 from the same eyeline axis.",
        stateBeforeEn: "C01 and C02 remain half a step apart.",
        stateAfterEn: "C01 finishes the question and keeps her gaze on C02.",
        soundEn: "Continuous quiet corridor room tone with subtle cloth movement.",
        dialogueTurns: [{ speakerId: "C01", speaker: "林曼秋", listenerIds: ["C02"], text: "邀请券带了吗？", onScreen: true }]
      },
      {
        number: 2,
        start: 3.2,
        end: 7,
        actionEn: "C02 answers, closes the distance and pulls C01 into one close embrace.",
        cameraEn: "Direct hard cut to C02 in a medium close-up on the same axis.",
        stateBeforeEn: "C02 holds the invitation while facing C01.",
        stateAfterEn: "C02 holds C01 in a close embrace.",
        soundEn: "The same corridor room tone continues; crowd chatter; light laughter; one synchronized cloth movement.",
        dialogueTurns: [{ speakerId: "C02", speaker: "哈桑", listenerIds: ["C01"], text: "带了，先给我奖励。", onScreen: true }]
      }
    ]
  };
  project.shots = [shot];
  return { project, shot };
}

test("new installations default to image-only H3 references", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-h3-image-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  assert.equal(store.getSettings().videoProvider.hailuoReferenceAudioMode, "image_only");
});

test("official H3 prompt overflow is rejected locally before uploads or submit", () => {
  const payload = {
    prompt: "A".repeat(9801),
    duration: 7,
    hailuoApiMode: "image_to_video",
    images: [{ path: "reference.png" }],
    videos: [],
    audios: [],
    videoAudios: []
  };
  assert.throws(
    () => validateProviderPayload("puream-hailuo-h3", payload),
    error => error?.code === "HAILUO_PROMPT_TOO_LONG_LOCAL"
      && error?.promptLength === 9801
      && error?.promptLimit === 9800
  );
});

test("image-only review uses the official H3 template that matches each media role", () => {
  for (const mode of ["asset_direct", "keyframe", "continuation", "storyboard_sheet"]) {
    const { project, shot } = fixture();
    project.generation.mode = mode;
    const references = promptReviewReferencePlan(project, shot, mode, "image_only");
    const strategy = resolveShotVideoStrategy(project, shot);
    const expectedApiMode = resolveHailuoApiModeForStrategy(
      strategy.frameStages.includes("storyboard_sheet") ? "asset_direct" : strategy.strategy,
      "auto",
      strategy.strategy === "continuation"
    );
    assert.equal(references.referenceAudioMode, "image_only", mode);
    assert.equal(references.audios.length, 0, mode);
    assert.equal(references.hailuoApiMode, expectedApiMode, mode);

    const prompt = renderApprovedVideoPrompt(project, shot, references);
    const requiredSections = expectedApiMode === "image_to_video" ? BASE_REQUIRED_SECTIONS : REQUIRED_SECTIONS;
    requiredSections.forEach(section => assert.ok(prompt.includes(section), `${mode}:${section}`));
    assert.match(prompt, /<d>\[Chinese\]\s*邀请券带了吗？<\/d>/u, mode);
    assert.match(prompt, /<d>\[Chinese\]\s*带了，先给我奖励。<\/d>/u, mode);
    assert.doesNotMatch(prompt, /<Audio\s+\d+>/i, mode);
    assert.doesNotMatch(prompt, /\b(?:chatter|laughter|laughing|giggles?|giggling|crowd\s+voices?)\b/i, mode);
    assert.match(prompt, /silent crowd movement/i, mode);
    assert.match(prompt, /silent visible smiles/i, mode);
    assert.equal(containsCjkOutsideDialogue(prompt), false, mode);
    assert.equal(assertHailuoFinalPromptIntegrity(prompt), true, mode);

    const chinese = renderApprovedVideoPromptChinese(project, shot, references);
    assert.match(chinese, /不传参考音频/u, mode);
    assert.match(chinese, /邀请券带了吗？/u, mode);
  }
});

test("production-package dialogue lines express dialogue, tone, emotion, action and blocking in official natural language", () => {
  const { project, shot } = fixture();
  project.generation.mode = "production_package";
  const references = promptReviewReferencePlan(project, shot, "production_package", "image_only");
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot,
    references,
    dialogueTurns: shot.dialogueTurns,
    priorityProfile: "dialogue_tone_emotion_action_blocking"
  });
  const dialogueLines = prompt.split(/\r?\n/).filter(line => /<d>\s*\[Chinese\]/i.test(line));
  assert.equal(dialogueLines.length, 2);
  for (const line of dialogueLines) {
    const positions = [
      line.indexOf("<d>[Chinese]"),
      line.indexOf("delivery is"),
      line.indexOf("vocal arc is"),
      line.indexOf("facial arc is"),
      line.indexOf("body action is"),
      line.indexOf("blocking is")
    ];
    assert.ok(positions.every(position => position >= 0));
    assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
    assert.doesNotMatch(line, /DIALOGUE\s+PRIORITY|TONE\s+PRIORITY|EMOTION\s+PRIORITY|ACTION\s+PRIORITY|BLOCKING\s+PRIORITY/i);
  }
  assert.equal(containsCjkOutsideDialogue(prompt), false);
  assert.equal(assertHailuoFinalPromptIntegrity(prompt), true);
});

test("a persisted silent generation block never inherits the parent shot dialogue", () => {
  const { project, shot } = fixture();
  const persistedBlockShot = JSON.parse(JSON.stringify({
    ...shot,
    duration: 4,
    dialogueTurns: [],
    subshots: [{
      start: 0,
      end: 4,
      actionEn: "C02 completes the authored embrace while C01 reacts silently.",
      cameraEn: "Hold the same-axis medium two-shot through the completed action.",
      soundEn: "Continuous corridor room tone with one synchronized cloth movement.",
      dialogueTurns: []
    }],
    agentGenerationBlock: {
      id: "S01-B02",
      takeIds: ["S01-T03"],
      takes: [{ id: "S01-T03", dialogueTurns: [] }]
    }
  }));
  assert.deepEqual(collectDialogue(project, persistedBlockShot), []);
  const references = promptReviewReferencePlan(project, persistedBlockShot, "asset_direct", "image_only");
  const prompt = renderApprovedVideoPrompt(project, persistedBlockShot, references);
  const spokenBlocks = [...prompt.matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)]
    .map(match => String(match[1] || "").trim())
    .filter(line => line && line !== "...");
  assert.deepEqual(spokenBlocks, []);
  assert.match(prompt, /no one speaks/i);
});

test("dialogue reflow splits an authored beat without erasing the following kiss and witness reaction", () => {
  const { project, shot } = fixture();
  shot.dialogueTurns = shot.dialogueTurns.map((turn, index) => ({
    ...turn,
    // These legacy editorial windows are intentionally too short. The
    // dialogue planner must expand them without deleting later physical beats.
    startSecond: index === 0 ? 0 : 1.6,
    endSecond: index === 0 ? 1.6 : 3.34
  }));
  shot.providerTimedDirections = [
    {
      start: 0,
      end: 3.3,
      actionEn: "C01 asks once, then C02 answers once and pulls C01 close.",
      cameraEn: "Use direct speaker-owned medium close-ups on the established axis.",
      stateBeforeEn: "C01 and C02 face each other.",
      stateAfterEn: "C02 has pulled C01 close."
    },
    {
      start: 3.3,
      end: 5.8,
      actionEn: "After both lines finish, C01 and C02 complete one unmistakable profile kiss with clear lip contact.",
      cameraEn: "Hold a profile two-shot and make one short motivated push-in.",
      stateBeforeEn: "Their faces are close and both mouths are closed.",
      stateAfterEn: "The kiss is visibly complete."
    },
    {
      start: 5.8,
      end: 7,
      actionEn: "Hard cut to the silent witness, who freezes after clearly seeing the embracing couple.",
      cameraEn: "Hold a steady medium close-up on the witness reaction.",
      stateBeforeEn: "The embracing couple remains visible behind glass.",
      stateAfterEn: "The witness remains frozen and devastated."
    }
  ];
  const references = promptReviewReferencePlan(project, shot, "asset_direct", "image_only");
  const prompt = renderApprovedVideoPrompt(project, shot, references);
  assert.match(prompt, /After both lines finish,[^\n]*unmistakable profile kiss[^\n]*clear lip contact/i);
  assert.match(prompt, /From 5\.8 to 7\.0 seconds,[^\n]*silent witness[^\n]*freezes/i);
  assert.equal((prompt.match(/<d>\[Chinese\]/g) || []).length, 2);
});

test("a one-line camera-owned speaker always requires and receives an identity asset", () => {
  const project = {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "asset_direct" },
    characters: [{
      id: "C07",
      name: "direct speaker",
      castingTier: "extra",
      assetRequired: false,
      visualAssetRequired: false
    }],
    shots: [{
      id: "S10",
      duration: 8,
      visibleCharacterIds: ["C07"],
      characterIds: ["C07"],
      dialogueTurns: [{ speakerId: "C07", speaker: "direct speaker", text: "排队，我先看见的。", onScreen: true }],
      agentCameraTakePlan: {
        takes: [{
          id: "S10-T02",
          cameraOwnerId: "C07",
          mouthOwnerId: "C07",
          onScreenSpeaker: true,
          dialogueTurns: [{ speakerId: "C07", text: "排队，我先看见的。", onScreen: true }]
        }]
      }
    }]
  };
  // §4.3：assetRequired 只是兼容显示值，执行判定必须读显式状态。
  // 旧的 assetDecision() 已被内核视图 characterEligibilityView() 取代。
  const decision = characterEligibilityView(project, characterRegistry(project)[0]);
  assert.equal(decision.visualRequirement, "required", "一句台词的镜位主体仍必须有独立视觉身份");
  assert.equal(viewCompatibility(decision).assetRequired, true);
  assert.equal(decision.evidence.visibleSpeakingShots, 1);
  assert.equal(decision.voiceIdentityRequirement, "required");
  assert.deepEqual(shotReferenceCharacterIds(project, project.shots[0]), ["C07"]);
});
