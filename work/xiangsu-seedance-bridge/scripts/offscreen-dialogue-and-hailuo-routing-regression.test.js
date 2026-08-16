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
const {
  candidateHasHailuoDialogueMode,
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

test("camera cuts split one canonical line without repeating stressed words", () => {
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
  assert.deepEqual(cameraTurns.map(item => item.text), ["你凭什么烧掉它？", "我妈等了你", "整整三十年！"]);
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

test("H3 child-task mode is derived from the final filtered reference categories", () => {
  const cases = [
    [{ videos: ["previous.mp4"] }, "multimodal_to_video", "video_to_video"],
    [{ images: ["frame.png"] }, "multimodal_to_video", "image_to_video"],
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
