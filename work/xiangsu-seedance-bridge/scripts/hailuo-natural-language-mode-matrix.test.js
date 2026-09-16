"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BASE_REQUIRED_SECTIONS,
  REQUIRED_SECTIONS,
  assertHailuoFinalPromptIntegrity,
  buildFullReferencePrompt,
  compactFullReferencePrompt
} = require("../app/hailuo-h3-prompt");
const { normalizeHailuoPrompt } = require("../app/puream-video-adapters");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");

const project = {
  generation: { engine: "hailuo-h3", aspectRatio: "9:16" },
  characters: [{ id: "C01", name: "张三" }, { id: "C02", name: "李四" }],
  scenes: [{ id: "SC01", name: "客厅" }]
};

const shot = {
  id: "S08",
  number: 8,
  duration: 8,
  sceneId: "SC01",
  action: "张三把证据推到李四面前",
  emotion: "克制质问到事实落地",
  characterIds: ["C01", "C02"],
  visibleCharacterIds: ["C01", "C02"],
  dialogueTurns: [{
    speakerId: "C01",
    speaker: "张三",
    listenerIds: ["C02"],
    sourceTone: "压低声音，在证据二字上加重",
    text: "证据就在这里，你还要瞒多久？",
    metadata: { listenerBeat: "李四后退半步，呼吸变乱" }
  }]
};

const cases = [
  ["文生视频", { hailuoApiMode: "text_to_video", images: [], imageRoles: [], videos: [], videoRoles: [], audios: [] }],
  ["首尾帧图生视频", { hailuoApiMode: "image_to_video", images: ["start.png", "end.png"], imageRoles: [{ type: "storyboard_start" }, { type: "storyboard_end" }], videos: [], videoRoles: [], audios: [] }],
  ["单图整段参考", { hailuoApiMode: "reference_to_video", images: ["c01.png"], imageRoles: [{ type: "character", entityId: "C01" }], videos: [], videoRoles: [], audios: [] }],
  ["多图整段参考", { hailuoApiMode: "reference_to_video", images: ["c01.png", "c02.png", "scene.png"], imageRoles: [{ type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }, { type: "scene", entityId: "SC01" }], videos: [], videoRoles: [], audios: [] }],
  ["图片+音频", { hailuoApiMode: "multimodal_to_video", images: ["c01.png"], imageRoles: [{ type: "character", entityId: "C01" }], videos: [], videoRoles: [], audios: [{ characterId: "C01", characterName: "张三" }] }],
  ["图片+视频", { hailuoApiMode: "multimodal_to_video", images: ["c01.png"], imageRoles: [{ type: "character", entityId: "C01" }], videos: ["motion.mp4"], videoRoles: [{ type: "motion_reference" }], audios: [] }],
  ["图片+视频+音频", { hailuoApiMode: "multimodal_to_video", images: ["c01.png"], imageRoles: [{ type: "character", entityId: "C01" }], videos: ["motion.mp4"], videoRoles: [{ type: "motion_reference" }], audios: [{ characterId: "C01", characterName: "张三" }] }]
];

test("all supported H3 modes compile to the same approved dialogue-first format", () => {
  for (const [label, references] of cases) {
    const prompt = compactFullReferencePrompt(buildFullReferencePrompt({
      project,
      shot,
      mode: "keyframe",
      references,
      spec: {},
      template: "unused",
      skipValidation: true
    }));
    assert.equal(assertHailuoFinalPromptIntegrity(prompt), true, label);
    const usesBaseTemplate = ["text_to_video", "image_to_video"].includes(references.hailuoApiMode);
    const requiredSections = usesBaseTemplate
      ? BASE_REQUIRED_SECTIONS
      : REQUIRED_SECTIONS;
    for (const section of requiredSections) assert.ok(prompt.includes(section), `${label}:${section}`);
    assert.equal(prompt.split(shot.dialogueTurns[0].text).length - 1, 1, label);
    assert.doesNotMatch(prompt, /speech_boundary:/, label);
    assert.match(prompt, usesBaseTemplate ? /(?:^|\n)integrated_multimodal_description:/u : /^subject_definitions:/u, label);
    assert.match(prompt, /\[Shot 1\]/u, label);
    assert.match(prompt, /From 0\.0 to/u, label);
    assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/, label);
    references.images.forEach((_item, index) => assert.ok(prompt.includes(usesBaseTemplate ? `Picture ${index + 1}` : `<Picture ${index + 1}>`), `${label}:Picture ${index + 1}`));
    references.videos.forEach((_item, index) => assert.ok(prompt.includes(`<Video ${index + 1}>`), `${label}:Video ${index + 1}`));
    references.audios.forEach((_item, index) => assert.ok(prompt.includes(`<Audio ${index + 1}>`), `${label}:Audio ${index + 1}`));
    if (references.videos.length) assert.match(prompt, /motion, camera rhythm, and blocking reference|final temporal state/u, label);
  }
});

test("provider token conversion preserves the final media-array numbering", () => {
  const normalized = normalizeHailuoPrompt("图1锁张三，图2锁李四；视频1只锁动作；音频1只给张三，音频2只给李四。");
  assert.equal(normalized, "<Picture 1>锁张三，<Picture 2>锁李四；<Video 1>只锁动作；<Audio 1>只给张三，<Audio 2>只给李四。");
});

test("reference retention scopes temporal images to their actual endpoints instead of freezing completed action", () => {
  const prompt = buildFullReferencePrompt({
    project, shot, mode: "continuation", spec: {}, template: "unused", skipValidation: true,
    references: { hailuoApiMode: "multimodal_to_video", images: ["before.png", "after.png"],
      imageRoles: [{ type: "storyboard_start" }, { type: "storyboard_end" }],
      videos: ["previous.mp4"], videoRoles: [{ type: "previous_shot" }], audios: [] }
  });
  const retention = prompt.split("retention_analysis:")[1].split("detailed_description:")[0];
  assert.match(retention, /<Picture 1>: fully_preserved - .*only at the opening/);
  assert.match(retention, /<Picture 2>: fully_preserved - .*only at the final frame/);
  assert.match(retention, /never use it as the opening or freeze it throughout/);
  assert.match(retention, /<Video 1>: fully_preserved - /);
});

test("new-source official checking is explicit, not activated by an incidental legacy sentence", () => {
  const prompt=buildFullReferencePrompt({project,shot,mode:"continuation",spec:{},template:"unused",skipValidation:true,
    references:{hailuoApiMode:"multimodal_to_video",images:["c01.png"],imageRoles:[{type:"character",entityId:"C01"}],videos:["old.mp4"],videoRoles:[{type:"previous_shot"}],audios:[]}})
    .replace(/Speak only the (?:one tagged Chinese line|two tagged Chinese lines), each once and complete/g,"Perform the authored speech once in full");
  const bad=prompt.replace(/<Video 1>: fully_preserved - /,"<Video 1>: ");
  assert.throws(()=>assertHailuoFinalPromptIntegrity(bad,10000,{strictOfficial:true}),error=>error.failures?.some(x=>/official relationship marker/.test(x)));
  assert.equal(assertHailuoFinalPromptIntegrity(bad,10000),true,'unchanged legacy imports keep their compatibility path');
});

test("approved H3 prompt expands legacy short requests to a 10-second acted unit and keeps a silent action tail", () => {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: {
      ...shot,
      providerVisualEn: "Each speaker change creates a motivated eyeline cut to the active speaker while the listener remains visibly reactive.",
      duration: 8
    },
    references: {
      hailuoApiMode: "multimodal_to_video",
      images: ["c01.png", "c02.png"],
      imageRoles: [{ type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }],
      audios: [{ characterId: "C01", characterName: "张三" }]
    },
    dialogueTurns: [{
      ...shot.dialogueTurns[0],
      start: 0,
      end: 5,
      metadata: { body: "伸手把证据推到对方面前", listenerBeat: "李四后退半步并盯住证据" }
    }]
  });
  assert.match(prompt, /From 5\.0 to 10\.0 seconds, no one speaks/u);
  assert.match(prompt, /every visible mouth remains at rest/u);
  assert.match(prompt, /remaining authored physical action and visible reaction continue/u);
  assert.doesNotMatch(prompt, /\b(?:vis|visi|reacti|the a)\./i);
  assert.doesNotMatch(prompt, /detailed_description:[^\n]*\.\./);
});

test("too-short authored dialogue windows expand naturally and preserve only the genuine silent tail", () => {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: { ...shot, duration: 10 },
    references: {
      hailuoApiMode: "multimodal_to_video",
      images: ["c01.png", "c02.png"],
      imageRoles: [{ type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }],
      audios: [{ characterId: "C01" }, { characterId: "C02" }]
    },
    spec: {
      subshots: [
        { start: 0, end: 2, actionEn: "the unstable person loses balance", cameraEn: "medium close-up" },
        { start: 2, end: 5, actionEn: "one character catches the other", cameraEn: "shot-reverse-shot" },
        { start: 5, end: 10, actionEn: "the supporting arms tighten", cameraEn: "restrained push-in" }
      ]
    },
    dialogueTurns: [
      { speakerId: "C01", listenerIds: ["C02"], start: 0, end: 2, text: "住手！有话冲我来！", sourceTone: "restrained anger, sharp attack", metadata: { body: "body lunges forward", listenerBeat: "still lips, balance jolts" } },
      { speakerId: "C02", listenerIds: ["C01"], start: 2, end: 5, text: "先把人放开，这次别再回避。", sourceTone: "firm stress, slower ending", metadata: { body: "gaze lands on the listener", listenerBeat: "still lips, breath catches" } }
    ]
  });
  const secondLine = prompt.split("\n").find(line => line.includes("先把人放开，这次别再回避。")) || "";
  const secondWindow = [...secondLine.slice(0, secondLine.indexOf("<d>")).matchAll(/From (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) seconds/gu)].at(-1);
  assert.ok(secondWindow, "the second sentence must start after the naturally completed first line");
  const secondStartSeconds = Number(secondWindow[1]);
  const secondEndSeconds = Number(secondWindow[2]);
  assert.ok(secondStartSeconds >= 1 && secondStartSeconds < 5);
  assert.ok(secondEndSeconds > secondStartSeconds && secondEndSeconds < 10, "the authored hint may expand only as long as the sentence actually needs");
  const silentStart = secondWindow[2].replace(".", "\\.");
  assert.match(prompt, new RegExp(`From ${silentStart} to 10\\.0 seconds, no one speaks`, "u"));
  assert.match(prompt, /switch camera ownership and speaking-mouth ownership together with a direct hard cut|cut to <Subject \d+>'s established visible speaking face without changing that person's identity|cut only to the next authored on-screen speaker's established face; identity never changes inside a face/u, "the camera cut must move with the adaptive speaker boundary");
  assert.match(prompt, new RegExp(`From 0\\.0 to ${secondWindow[1].replace(".", "\\.")} seconds`, "u"), "the first visual segment must not cut away before the first complete sentence ends");
  assert.equal(prompt.split("住手！有话冲我来！").length - 1, 1);
  assert.equal(prompt.split("先把人放开，这次别再回避。").length - 1, 1);
});
