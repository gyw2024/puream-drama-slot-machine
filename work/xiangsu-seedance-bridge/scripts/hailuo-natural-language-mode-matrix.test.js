"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUIRED_SECTIONS,
  assertHailuoFinalPromptIntegrity,
  buildFullReferencePrompt,
  compactFullReferencePrompt
} = require("../app/hailuo-h3-prompt");
const { normalizeHailuoPrompt } = require("../app/puream-video-adapters");

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
  ["首帧图生视频", { hailuoApiMode: "image_to_video", images: ["start.png"], imageRoles: [{ type: "storyboard_start" }], videos: [], videoRoles: [], audios: [] }],
  ["首尾帧图生视频", { hailuoApiMode: "image_to_video", images: ["start.png", "end.png"], imageRoles: [{ type: "storyboard_start" }, { type: "storyboard_end" }], videos: [], videoRoles: [], audios: [] }],
  ["多图参考", { hailuoApiMode: "image_to_video", images: ["c01.png", "c02.png", "scene.png"], imageRoles: [{ type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }, { type: "scene", entityId: "SC01" }], videos: [], videoRoles: [], audios: [] }],
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
    for (const section of REQUIRED_SECTIONS) assert.ok(prompt.includes(section), `${label}:${section}`);
    assert.equal(prompt.split(shot.dialogueTurns[0].text).length - 1, 1, label);
    assert.match(prompt, /对白内容＞语气＞情绪＞场景＞运镜＞其他/, label);
    assert.doesNotMatch(prompt, /subject_definitions|retention_analysis|<Subject|<Audio|<d>\[Chinese\]/, label);
    references.images.forEach((_item, index) => assert.ok(prompt.includes(`图${index + 1}`), `${label}:图${index + 1}`));
    references.videos.forEach((_item, index) => assert.ok(prompt.includes(`视频${index + 1}`), `${label}:视频${index + 1}`));
    references.audios.forEach((_item, index) => assert.ok(prompt.includes(`音频${index + 1}`), `${label}:音频${index + 1}`));
    if (references.videos.length) assert.match(prompt, /只参考动作\/运镜\/节奏，不参考脸、服装、场景、原声、字幕/, label);
  }
});

test("provider token conversion preserves the final media-array numbering", () => {
  const normalized = normalizeHailuoPrompt("图1锁张三，图2锁李四；视频1只锁动作；音频1只给张三，音频2只给李四。");
  assert.equal(normalized, "<Picture 1>锁张三，<Picture 2>锁李四；<Video 1>只锁动作；<Audio 1>只给张三，<Audio 2>只给李四。");
});
