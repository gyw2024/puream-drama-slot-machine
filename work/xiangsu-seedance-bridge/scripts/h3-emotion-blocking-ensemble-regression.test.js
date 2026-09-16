"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { renderApprovedVideoPromptChinese } = require("../app/workbench-workflow");

const characters = [
  { id: "C01", name: "林岚" },
  { id: "C02", name: "周强" }
];

function fixture(mode) {
  const project = {
    generation: { mode, aspectRatio: "9:16" },
    characters,
    scenes: [{ id: "SC01", name: "社区礼堂" }]
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 12,
    sceneId: "SC01",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    action: "林岚说完决定，礼堂里的邻居和志愿者集体鼓掌；镜头切到一排路人鼓掌，再切回林岚与周强。",
    actionEn: "C01 finishes the decision; several neighbors and volunteers applaud together; cut to the applauding group, then return to C01 and C02.",
    stateBefore: "林岚在左，周强在右，二人相对站立",
    stateAfter: "掌声落下，林岚与周强仍在原站位对视",
    subshots: [
      {
        start: 0,
        end: 5,
        action: "林岚面向周强说出决定",
        actionEn: "C01 faces C02 and states the decision.",
        backgroundAction: "周强闭口，下颌放松后屏住呼吸",
        blockingEn: "C01 holds screen-left facing screen-right toward C02; C02 holds screen-right facing screen-left; camera stays on the established 180-degree axis.",
        backgroundActionEn: "C02 remains silent and reacts with a softened jaw and held breath.",
        cameraEn: "medium close-up on C01",
        visibleCharacterIds: ["C01", "C02"]
      },
      {
        start: 5,
        end: 8,
        action: "切到邻居和志愿者集体鼓掌",
        actionEn: "Cut to several anonymous neighbors and volunteers applauding together with visible hands.",
        backgroundAction: "一排邻居和志愿者闭口集体鼓掌，手掌动作清楚同步",
        backgroundActionEn: "The anonymous ensemble applauds once in shared timing; every mouth remains at rest.",
        cameraEn: "motivated medium-wide ensemble cutaway",
        visibleCharacterIds: []
      },
      {
        start: 8,
        end: 12,
        action: "切回二人原站位，周强回应",
        actionEn: "Return to the unchanged principal axis; C02 answers C01.",
        backgroundAction: "林岚闭口，以轻微点头回应",
        blockingEn: "C01 remains screen-left and C02 remains screen-right; both face inward on the same eyeline axis.",
        cameraEn: "hard cut back to a medium close-up on C02",
        visibleCharacterIds: ["C01", "C02"]
      }
    ],
    dialogueTurns: [
      {
        sourceDialogueId: "D001",
        speakerId: "C01",
        listenerIds: ["C02"],
        text: "这次我不躲了，我留下来把事情做完。",
        plannedSpeechSeconds: 3.8,
        plannedAfterBeatSeconds: 0.5,
        vocalArcEn: "begin at medium-low volume with a restrained pitch, rise half a step and slow on 留下来, then land the final clause in a lower firm register after one short breath",
        expressionArcEn: "eyes start guarded, brows release on the decision, jaw settles into quiet resolve at the end",
        bodyEn: "C01 squares her shoulders and opens one hand toward C02",
        blockingEn: "C01 remains screen-left one step from C02 on screen-right",
        speakerFacingEn: "C01 keeps face, eyes and upper torso toward C02 in readable three-quarter view on the same 180-degree axis",
        listenerReactionEn: "C02 keeps lips closed, releases a held breath and lowers his shoulders"
      },
      {
        sourceDialogueId: "D002",
        speakerId: "C02",
        listenerIds: ["C01"],
        text: "我跟你一起。",
        plannedSpeechSeconds: 1.8,
        plannedAfterBeatSeconds: 0.6,
        vocalArcEn: "start softly, lift pitch slightly on 一起, then end warm and steady without rushing",
        expressionArcEn: "brows soften, eyes meet C01, and the mouth settles into restrained relief",
        bodyEn: "C02 takes one small step toward C01 and stops at the established distance",
        blockingEn: "C02 remains screen-right facing C01 on screen-left",
        speakerFacingEn: "C02 turns face, eyes and upper torso toward C01 and remains on the same 180-degree axis",
        listenerReactionEn: "C01 stays closed-lipped and answers with a small relieved nod"
      }
    ]
  };
  const imageRoles = mode === "storyboard_sheet"
    ? [{ type: "storyboard_sheet", entityId: "S01" }]
    : mode === "keyframe"
      ? [{ type: "storyboard_start", entityId: "S01" }, { type: "storyboard_end", entityId: "S01" }]
      : [{ type: "scene", entityId: "SC01" }, { type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }];
  const references = {
    promptMode: mode,
    images: imageRoles.map((_, index) => `image-${index + 1}`),
    imageRoles,
    audios: [
      { characterId: "C01", characterName: "林岚" },
      { characterId: "C02", characterName: "周强" }
    ]
  };
  return { project, shot, references };
}

for (const mode of ["asset_direct", "keyframe", "storyboard_sheet"]) {
  test(`${mode} compiles vocal arc, blocking, correct facing and authored ensemble coverage`, () => {
    const { project, shot, references } = fixture(mode);
    const prompt = buildApprovedHailuoPrompt({ project, shot, references, dialogueTurns: shot.dialogueTurns });
    assert.match(prompt, /vocal arc is start softly, lift pitch slightly/);
    assert.match(prompt, /screen-left/);
    assert.match(prompt, /screen-right/);
    assert.match(prompt, /180-degree eyeline axis/);
    assert.match(prompt, /background bystanders applaud together/);
    assert.match(prompt, /Return by direct cut to the principal characters/);
    assert.match(prompt, /<d>\[Chinese\] 这次我不躲了，我留下来把事情做完。<\/d>/);
    assert.match(prompt, /<d>\[Chinese\] 我跟你一起。<\/d>/);
    assert.match(prompt, /<Subject 1> \(S1\) faces <Subject 2>[^\n]+<d>\[Chinese\] 这次我不躲了/);
    assert.doesNotMatch(prompt, /<Subject 2> \(S2\) faces <Subject 1>[^\n]+<d>\[Chinese\] 这次我不躲了/);
    assert.match(prompt, /no one speaks/);
    assert.match(prompt, /<Subject 2> \(S2\) faces <Subject 1>[^\n]+<d>\[Chinese\] 我跟你一起。<\/d>/);
    assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
  });
}

test("Chinese review exposes editable vocal, expression, blocking, facing and listener-reaction fields", () => {
  const { project, shot, references } = fixture("asset_direct");
  const review = renderApprovedVideoPromptChinese(project, shot, references);
  assert.match(review, /语气|声调/);
  assert.match(review, /表情|眼神/);
  assert.match(review, /站位|画面左侧/);
  assert.match(review, /朝向|面向/);
  assert.match(review, /闭口/);
  assert.match(review, /背景|听者/);
  assert.match(review, /180/);
});
