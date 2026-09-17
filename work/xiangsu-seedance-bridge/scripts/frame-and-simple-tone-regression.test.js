"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildFullReferencePrompt } = require("../app/hailuo-h3-prompt");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { defaultPromptTemplates } = require("../app/prompt-library");
const { characterVideoOutputContract } = require("../app/workbench-workflow");

const project = {
  generation: { engine: "hailuo-h3", mode: "keyframe", aspectRatio: "9:16" },
  characters: [{ id: "C01", name: "小林" }, { id: "C02", name: "妈妈" }],
  scenes: [{ id: "SC01", name: "客厅", description: "同一客厅，沙发靠窗，门在右侧" }]
};

const shot = {
  id: "S01",
  number: 1,
  duration: 8,
  sceneId: "SC01",
  characterIds: ["C01", "C02"],
  visibleCharacterIds: ["C01", "C02"],
  videoStrategy: "keyframe",
  startFrame: "小林尚未递出护膝，妈妈仍坐在沙发上",
  endFrame: "妈妈戴好护膝并站到门边，小林放下手",
  dialogueTurns: [{
    speakerId: "C01",
    listenerIds: ["C02"],
    sourceTone: "压低声音，带着安慰",
    text: "妈，先试试这个。"
  }]
};

function keyframeReferences() {
  return {
    hailuoApiMode: "multimodal_to_video",
    images: ["start.png", "end.png"],
    imageRoles: [
      { type: "storyboard_start", label: "剧情首帧" },
      { type: "storyboard_end", label: "剧情尾帧" }
    ],
    videos: [],
    videoRoles: [],
    audios: []
  };
}

test("keyframe compiler separates exact before-action and after-action endpoints", () => {
  const prompt = buildFullReferencePrompt({
    project,
    shot,
    mode: "keyframe",
    references: keyframeReferences(),
    spec: {},
    template: "unused",
    skipValidation: true
  });
  assert.match(prompt, /<Picture 1> is the exact before-action narrative frame at 0\.00 seconds/);
  assert.match(prompt, /<Picture 2> is the exact final narrative state after the authored action completes/);
  assert.match(prompt, /Begin with opening pose and prop state/);
  assert.match(prompt, /finish with authored completed state/);
  assert.match(prompt, /\[Shot 1\] From 0\.0 to 10\.0 seconds/);
});

test("Simple user tone survives into the final H3 dialogue timeline", () => {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot,
    references: keyframeReferences(),
    dialogueTurns: shot.dialogueTurns
  });
  assert.match(prompt, /delivery is [^;]+/);
  assert.match(prompt, /<d>\[Chinese\] 妈，先试试这个。<\/d>/);
  assert.equal(prompt.split("妈，先试试这个。").length - 1, 1);
});

test("missing simple tone is inferred from Chinese sentence and action instead of a generic fallback", () => {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: { ...shot, action: "小林突然挡住门口，攥紧手里的护膝" },
    references: keyframeReferences(),
    dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "你还要走吗？" }]
  });
  assert.doesNotMatch(prompt, /natural breath, pace and stress/i);
  assert.match(prompt, /delivery is [^;]+/);
});

test("structured performance metadata never leaks object serialization into a video prompt", () => {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot,
    references: keyframeReferences(),
    dialogueTurns: [{
      speakerId: "C01",
      listenerIds: ["C02"],
      sourceTone: { delivery: "压低声音，克制安慰", emotion: "安心" },
      text: "妈，先试试这个。"
    }]
  });
  assert.doesNotMatch(prompt, /\[object Object\]/i);
  assert.match(prompt, /delivery is [^;]+/);
  assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
});

test("silent shots omit implicit voice references from the final prompt", () => {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: { ...shot, dialogueTurns: [], action: "妈妈闭口戴好护膝并走到门边" },
    references: { ...keyframeReferences(), audios: [{ characterId: "C01", characterName: "小林" }, { characterId: "C02", characterName: "妈妈" }] },
    dialogueTurns: []
  });
  assert.doesNotMatch(prompt, /<Audio\s+\d+>|audio reference|assigned voices/i);
  assert.match(prompt, /From 0\.0 to 10\.0 seconds, no one speaks/);
});

test("Simple guide states its asset-only, no-text-model workflow", () => {
  const html = fs.readFileSync(path.join(__dirname, "../app/renderer/simple-mode.html"), "utf8");
  assert.match(html, /不调用文本模型/);
  assert.match(html, /语气会原样进入最终视频提示词/);
  assert.match(html, /简易模式不选题、不写剧本/);
});

test("static image contracts ban text explicitly while character-video payloads use only positive clean-frame wording", () => {
  const prompts = defaultPromptTemplates();
  assert.match(prompts.storyboardImage, /No dialogue text|added captions|字幕|文字/i);

  for (const engine of ["seedance", "hailuo-h3"]) {
    const output = [
      engine === "hailuo-h3" ? prompts.hailuoCharacterVideo : prompts.characterVideo,
      characterVideoOutputContract({ generation: { engine } }, { prompts })
    ].join("\n");
    assert.match(output, /干净|clean/i);
    assert.doesNotMatch(output, /字幕|字卡|subtitles?|captions?|on[- ]screen\s+text/i);
  }
});
