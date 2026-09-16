"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { assertHailuoFinalPromptIntegrity, containsCjkOutsideDialogue } = require("../app/hailuo-h3-prompt");
const {
  PROMPT_REVIEW_BUNDLE_VERSION,
  finalizeVideoPromptForSubmission,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese
} = require("../app/workbench-workflow");

function fixture() {
  const project = {
    generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" },
    promptReview: { version: PROMPT_REVIEW_BUNDLE_VERSION, status: "approved" },
    characters: [
      { id: "C01", name: "陈国强" },
      { id: "C02", name: "李伯" }
    ],
    scenes: [{ id: "SC01", name: "老式面馆" }],
    shots: []
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 12,
    promptMode: "system",
    promptReviewBundleVersion: PROMPT_REVIEW_BUNDLE_VERSION,
    sceneId: "SC01",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    action: "李伯走进面馆，坐到常坐的位置并低头看菜单；两句问答结束后，陈国强转身去后厨煮面，端回一碗面放到李伯面前，李伯低头开始吃面，陈国强回到柜台继续忙碌。",
    stateBefore: "李伯刚跨进面馆门口，陈国强站在柜台后抬头看见他",
    stateAfter: "李伯安静吃面，陈国强已经回到柜台继续忙碌",
    subshots: [
      {
        start: 0,
        end: 3.8,
        framingZh: "中景转人物近景",
        cameraZh: "先跟随李伯进门落座，再按说话人变化直接硬切",
        actionZh: "李伯走进面馆坐到常坐的位置，低头看一眼菜单；陈国强在柜台后抬头试探",
        stateBeforeZh: "李伯刚跨进面馆门口",
        stateAfterZh: "两人隔着桌面完成简短问答"
      },
      {
        start: 3.8,
        end: 12,
        framingZh: "中景配合面碗特写",
        cameraZh: "跟随陈国强走向后厨，面碗落桌时切一次物品特写，再回到两人中景",
        actionZh: "陈国强转身去后厨煮面，端回一碗面放到李伯面前；李伯低头开始吃面，陈国强回到柜台继续忙碌",
        stateBeforeZh: "问答结束，李伯仍坐在原位",
        stateAfterZh: "李伯安静吃面，陈国强回到柜台"
      }
    ],
    dialogueTurns: [
      {
        sourceDialogueId: "D001",
        speakerId: "C01",
        listenerIds: ["C02"],
        text: "李伯，老样子？",
        deliveryZh: "警觉试探，起句压低，重读“老样子”，句尾轻微上扬但保持紧绷",
        expressionZh: "眉峰先收紧，视线锁住李伯，问完后下颌不放松",
        bodyZh: "身体从柜台后略微前倾，只在称呼李伯时停下手中动作",
        listenerReactionZh: "李伯闭口，抬眼看向陈国强，短促吸气后轻轻点头"
      },
      {
        sourceDialogueId: "D002",
        speakerId: "C02",
        listenerIds: ["C01"],
        text: "嗯，老样子。",
        deliveryZh: "低声克制，先短促应声，再放慢说完后半句",
        expressionZh: "眼神略显疲惫，句尾避开陈国强的注视",
        bodyZh: "一只手压住菜单边缘，肩膀轻微下沉",
        listenerReactionZh: "陈国强闭口，观察李伯片刻后转身去后厨"
      }
    ]
  };
  project.shots = [shot];
  return { project, shot };
}

function referencesForMode(mode) {
  const base = {
    promptMode: mode,
    images: ["scene-four-view.png", "c01.png", "c02.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [
      { characterId: "C01", characterName: "陈国强", path: "c01.wav" },
      { characterId: "C02", characterName: "李伯", path: "c02.wav" }
    ],
    videos: [],
    videoRoles: []
  };
  if (mode === "storyboard_sheet") {
    base.images.unshift("storyboard-sheet.png");
    base.imageRoles.unshift({ type: "storyboard_sheet", entityId: "S01" });
  } else if (mode === "keyframe") {
    base.images.unshift("start.png", "end.png");
    base.imageRoles.unshift(
      { type: "storyboard_start", entityId: "S01" },
      { type: "storyboard_end", entityId: "S01" }
    );
  } else if (mode === "continuation") {
    base.videos.push("previous.mp4");
    base.videoRoles.push({ type: "previous_shot", entityId: "S00" });
  }
  return base;
}

function assertCanonicalPrompt(prompt) {
  assert.ok(prompt.startsWith("subject_definitions:"));
  assert.match(prompt, /summary:[\s\S]*retention_analysis:[\s\S]*detailed_description:[\s\S]*overall_soundscape:[\s\S]*non_diegetic_music:/i);
  assert.match(prompt, /\[Shot 1\] From 0\.0 to \d+(?:\.\d+)? seconds/);
  assert.match(prompt, /<d>\[Chinese\] 李伯，老样子？<\/d>/);
  assert.match(prompt, /<d>\[Chinese\] 嗯，老样子。<\/d>/);
  assert.equal((prompt.match(/李伯，老样子？/g) || []).length, 1);
  assert.equal((prompt.match(/嗯，老样子。/g) || []).length, 1);
  assert.match(prompt, /Only <Subject 1> \(S1\) moves the lips for this line/);
  assert.match(prompt, /Only <Subject 2> \(S2\) moves the lips for this line/);
  assert.match(prompt, /<Subject 2> remains closed-lipped/);
  assert.match(prompt, /<Subject 1> remains closed-lipped/);
  assert.match(prompt, /no one speaks; every visible mouth remains at rest|all mouths rest while the remaining authored action/);
  assert.match(prompt, /Never freeze, wait idly, or add another line|no idle hold or added speech/);
  assert.match(prompt, /Reference images establish identity, appearance, space, product and prop continuity only|References lock identity and continuity only/);
  assert.match(prompt, /clean full-frame camera-original live-action plate/);
  assert.equal(containsCjkOutsideDialogue(prompt), false);
  assert.equal(assertHailuoFinalPromptIntegrity(prompt), true);
}

for (const mode of ["asset_direct", "storyboard_sheet", "keyframe", "continuation"]) {
  test(`${mode} uses one complete official-English multimodal timeline`, () => {
    const { project, shot } = fixture();
    project.generation.mode = mode;
    const references = referencesForMode(mode);
    const execution = buildApprovedHailuoPrompt({
      project,
      shot,
      references,
      dialogueTurns: shot.dialogueTurns
    });
    assertCanonicalPrompt(execution);
    if (mode === "storyboard_sheet") assert.match(execution, /<Picture 1> supplies ordered narrative frame composition|Follow <Picture 1>/);
    if (mode === "keyframe") assert.match(execution, /<Picture 1> is the exact before-action narrative frame/);
    if (mode === "continuation") assert.match(execution, /<Video 1> supplies only the exact final temporal state/);
  });
}

test("Chinese review display compiles to the byte-identical official-English paid prompt", () => {
  const { project, shot } = fixture();
  const references = referencesForMode("asset_direct");
  shot.promptReviewReferencePlan = {
    images: references.imageRoles.map(role => ({ ...role })),
    audios: references.audios.map(audio => ({ characterId: audio.characterId }))
  };
  const execution = renderApprovedVideoPrompt(project, shot, references);
  const display = renderApprovedVideoPromptChinese(project, shot, references);
  assert.notEqual(display, execution);
  assert.match(display, /分镜视频中文编辑稿/);
  const submitted = finalizeVideoPromptForSubmission(project, "shot", shot.id, "shot_video", display, "hailuo-h3", references);
  assert.equal(submitted, execution);
  assertCanonicalPrompt(submitted);
});
