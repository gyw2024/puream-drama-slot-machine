"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSpeakerCue,
  parseCompiledDialogueSegments,
  parseSourceDialogueLedger,
  parseSpeakerLabel
} = require("../app/dialogue-parser");
const { cameraDialogueTurns } = require("../app/agent-director");
const { validateHailuoModeMedia } = require("../app/puream-video-adapters");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { assertHailuoFinalPromptIntegrity } = require("../app/hailuo-h3-prompt");
const {
  candidateHasHailuoDialogueMode,
  hailuoVoiceLineageAudit,
  referenceManifestAudios,
  resolveHailuoApiModeForReferences,
  shotSpeakingCharacterIds,
  uniqueDialogueTurns
} = require("../app/workbench-workflow");

test("narrative production script quotes become an immutable source ledger", () => {
  const source = [
    "角色固定：C01林娜，38岁；C02秦添，45岁。",
    "S01【0-10秒】林娜按住信封，带哭腔怒声质问：‘你凭什么烧掉它？我妈等了你整整三十年！’秦添闭口。",
    "S02【10-20秒】秦添把信封推回，声音发颤承认：‘我今天才知道，是我错怪了她。’"
  ].join("\n");
  const ledger = parseSourceDialogueLedger(source);
  assert.deepEqual(ledger.map(item => [item.speaker, item.text]), [
    ["林娜", "你凭什么烧掉它？我妈等了你整整三十年！"],
    ["秦添", "我今天才知道，是我错怪了她。"]
  ]);
});

test("camera cuts preserve one canonical line without splitting or repeating stressed words", () => {
  const project = {
    characters: [
      { id: "C01", name: "林娜" },
      { id: "C02", name: "秦添" }
    ]
  };
  const exact = "你凭什么烧掉它？我妈等了你整整三十年！";
  const shot = {
    id: "S01",
    duration: 10,
    dialogueTurns: [{
      sourceDialogueId: "D001",
      speakerId: "C01",
      listenerIds: ["C02"],
      text: exact,
      subshotNumber: 1,
      delivery: "前半压火，整整三十年逐字重读且带哭腔"
    }],
    subshots: [
      { start: 0, end: 3, speakerIds: ["C01"], dialogue: "林娜：‘你凭什么烧掉它？’" },
      { start: 3, end: 7, speakerIds: ["C01"], offscreenSpeakerIds: ["C01"], dialogue: "林娜画外音：‘我妈等了你整整三十年！’（前半）" },
      { start: 7, end: 10, speakerIds: ["C01"], dialogue: "林娜：‘整整三十年！’（逐字重读落锤）" }
    ]
  };
  const canonical = uniqueDialogueTurns(project, shot);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].text, exact);
  const cameraTurns = cameraDialogueTurns(project, shot);
  assert.deepEqual(cameraTurns.map(item => item.text), [exact]);
  assert.equal(cameraTurns.map(item => item.text).join(""), exact);
  assert.equal(cameraTurns.filter(item => item.text.includes("整整三十年")).length, 1);
});

test("stitched H3 candidates inherit nested voice lineage and multimodal proof", () => {
  const candidate = {
    referenceManifest: {
      generationBlocks: [
        { referenceManifest: { images: [{ filePath: "frame-1.png" }], audios: [{ characterId: "C01", sha256: "voice-a", filePath: "voice-a.wav" }] } },
        { referenceManifest: { images: [{ filePath: "frame-2.png" }], audios: [{ characterId: "C01", sha256: "voice-a", filePath: "voice-a.wav" }] } }
      ]
    }
  };
  assert.deepEqual(referenceManifestAudios(candidate.referenceManifest).map(item => item.characterId), ["C01"]);
  assert.equal(candidateHasHailuoDialogueMode(candidate), true);
});

test("image-only H3 reference-to-video remains valid for native prompt dialogue", () => {
  const project = {
    characters: [
      { id: "C01", name: "林娜" },
      { id: "C02", name: "秦添" }
    ]
  };
  const shot = {
    id: "S01",
    dialogueTurns: [
      { speakerId: "C01", speaker: "林娜", text: "券带了吗？" },
      { speakerId: "C02", speaker: "秦添", text: "带了。" }
    ]
  };
  const candidate = {
    hailuoRequestedMode: "reference_to_video",
    referenceManifest: {
      images: [{ characterId: "C01", filePath: "lin.png" }, { characterId: "C02", filePath: "qin.png" }],
      audios: []
    }
  };
  assert.equal(candidateHasHailuoDialogueMode(candidate), true);
  const audit = hailuoVoiceLineageAudit(project, shot, candidate, new Map());
  assert.equal(audit.ok, true);
  assert.equal(audit.badMode, false);
  assert.equal(audit.changedBoundVoice, false);
});

test("operator-selected imported shot video is not invalidated for lacking an H3 request-mode marker", () => {
  const project = { characters: [{ id: "C01", name: "林娜" }] };
  const shot = {
    id: "S02",
    dialogueTurns: [{ speakerId: "C01", speaker: "林娜", text: "这句已经人工核过。" }]
  };
  const candidate = {
    source: "mcp-import",
    manualSelectionOverride: true,
    qualityAudit: { mode: "manual", ok: true },
    referenceManifest: { images: [], audios: [] }
  };
  assert.equal(candidateHasHailuoDialogueMode(candidate), true);
  assert.equal(hailuoVoiceLineageAudit(project, shot, candidate, new Map()).ok, true);
});

test("a parent shot may have three speakers when every H3 provider block has at most two voices", () => {
  const project = {
    characters: [
      { id: "C01", name: "林娜" },
      { id: "C02", name: "秦添" },
      { id: "C03", name: "魏叔" }
    ]
  };
  const shot = {
    id: "S01",
    dialogueTurns: [
      { speakerId: "C01", speaker: "林娜", text: "第一句" },
      { speakerId: "C02", speaker: "秦添", text: "第二句" },
      { speakerId: "C03", speaker: "魏叔", text: "第三句" }
    ]
  };
  const block = audios => ({ referenceManifest: { images: [{ filePath: "frame.png" }], audios } });
  const candidate = {
    hailuoRequestedMode: "multimodal_to_video",
    referenceManifest: {
      audios: [
        { characterId: "C01", sha256: "voice-a" },
        { characterId: "C02", sha256: "voice-b" },
        { characterId: "C03", sha256: "voice-c" }
      ],
      generationBlocks: [
        block([{ characterId: "C01", sha256: "voice-a" }, { characterId: "C02", sha256: "voice-b" }]),
        block([{ characterId: "C03", sha256: "voice-c" }])
      ]
    }
  };
  const audit = hailuoVoiceLineageAudit(project, shot, candidate, new Map([
    ["C01", "voice-a"],
    ["C02", "voice-b"],
    ["C03", "voice-c"]
  ]));
  assert.equal(audit.ok, true);
  assert.equal(audit.providerBlockVoiceOverflow, false);
});

test("named off-screen directions never become fake character identities", () => {
  const knownNames = ["林娜", "秦添"];
  const variants = ["林娜画外", "林娜画外音", "林娜（画外）", "林娜（画外音）", "林娜 O.S.", "林娜 off-screen"];
  for (const variant of variants) {
    assert.equal(normalizeSpeakerCue(variant).speaker, "林娜", variant);
    const parsed = parseSpeakerLabel(variant, knownNames);
    assert.equal(parsed.speaker, "林娜", variant);
    assert.equal(parsed.offscreen, true, variant);
  }
  assert.equal(normalizeSpeakerCue("旁白").speaker, "旁白");
  assert.equal(normalizeSpeakerCue("旁白").offscreen, false);
});

test("compiled off-screen dialogue keeps exact words and authoritative hidden-speaker state", () => {
  const project = {
    characters: [
      { id: "C01", name: "林娜" },
      { id: "C02", name: "秦添" }
    ]
  };
  const source = "林娜画外音：我妈等了你整整三十年！";
  const parsed = parseCompiledDialogueSegments(source, ["林娜", "秦添"]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].speaker, "林娜");
  assert.equal(parsed[0].spokenText, "我妈等了你整整三十年！");
  assert.equal(parsed[0].onScreen, false);

  const shot = {
    id: "S01",
    subshots: [{
      start: 0,
      end: 10,
      dialogue: source,
      visibleCharacterIds: ["C02"],
      offscreenSpeakerIds: ["C01"]
    }]
  };
  const turns = uniqueDialogueTurns(project, shot);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].speaker, "林娜");
  assert.equal(turns[0].speakerId, "C01");
  assert.equal(turns[0].spokenText, "我妈等了你整整三十年！");
  assert.equal(turns[0].onScreen, false);
  const speakers = shotSpeakingCharacterIds(project, shot);
  assert.deepEqual([...speakers], ["C01"]);
  assert.deepEqual(speakers.unknownSpeakers, []);
});

test("official six-section spec keeps a phone speaker off-screen without assigning a visible mouth", () => {
  const exact = "钱大海！别做梦了！明天一早银行查封，你自求多福吧！";
  const project = {
    generation: { aspectRatio: "9:16" },
    characters: [
      { id: "C01", name: "钱大海" },
      { id: "C02", name: "赵总", offscreenOnly: true }
    ]
  };
  const turn = {
    sourceDialogueId: "D002",
    speakerId: "C02",
    listenerIds: ["C01"],
    text: exact,
    onScreen: false,
    start: 0.4,
    end: 5.4,
    subshotNumber: 1,
    deliveryEn: "An icy, decisive withdrawal notice with a hard final warning."
  };
  const shot = {
    id: "S01",
    duration: 10,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01"],
    dialogueTurns: [turn],
    subshots: [{
      number: 1,
      start: 0,
      end: 10,
      visibleCharacterIds: ["C01"],
      offscreenSpeakerIds: ["C02"],
      dialogueTurns: [turn],
      actionEn: "C01 holds the phone toward his ear and visibly loses confidence while C02 remains outside the frame.",
      cameraEn: "Hold a medium close-up on C01 from the established axis.",
      soundEn: "Continuous quiet interior room tone under the single clean phone voice."
    }]
  };
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot,
    dialogueTurns: [turn],
    references: {
      images: [{ id: "room" }, { id: "qian" }],
      imageRoles: [
        { type: "scene", entityId: "SC01" },
        { type: "character", entityId: "C01" }
      ],
      audios: [],
      videoAudios: [],
      hailuoApiMode: "reference_to_video"
    },
    spec: {
      specVersion: "test-offscreen-official",
      summaryEn: "C01 receives an off-screen phone withdrawal notice and visibly loses confidence.",
      subshots: [{ soundEn: "Continuous quiet interior room tone under the single clean phone voice." }],
      overallSoundscapeEn: "Continuous quiet interior room tone and the exact phone voice only."
    }
  });
  assertHailuoFinalPromptIntegrity(prompt);
  assert.match(prompt, /<Subject 1> \(S1\) remains off-screen and speaks once/);
  assert.match(prompt, /No visible mouth moves for this line/);
  assert.doesNotMatch(prompt, /<Subject 1> \(S1\) faces <Subject 2>/);
  assert.equal(prompt.split(exact).length - 1, 1);
});

test("H3 child-task mode is derived from the final filtered reference categories", () => {
  const cases = [
    [{ videos: ["previous.mp4"] }, "multimodal_to_video", "video_to_video"],
    [{ images: ["frame.png"] }, "multimodal_to_video", "reference_to_video"],
    [{ audios: [{ path: "voice.wav" }] }, "multimodal_to_video", "audio_to_video"],
    [{ videos: ["previous.mp4"], audios: [{ path: "voice.wav" }] }, "video_to_video", "multimodal_to_video"],
    [{ images: ["frame.png"], audios: [{ path: "voice.wav" }] }, "image_to_video", "multimodal_to_video"],
    [{}, "multimodal_to_video", "text_to_video"]
  ];
  for (const [references, preferred, expected] of cases) {
    const mode = resolveHailuoApiModeForReferences(references, preferred);
    assert.equal(mode, expected);
    assert.doesNotThrow(() => validateHailuoModeMedia(mode, {
      images: references.images || [],
      videos: references.videos || [],
      audios: references.audios || [],
      videoAudios: references.videoAudios || []
    }));
  }
});
