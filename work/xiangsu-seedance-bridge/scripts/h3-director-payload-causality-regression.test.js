"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENT_DIRECTOR_VERSION,
  HAILUO_TAKE_PROMPT_LIMIT,
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  filterReferencesForGenerationBlock,
  generationBlockTakes,
  validateCameraTakePlan
} = require("../app/agent-director");
const {
  assertStrictCharacterMediaBindings,
  propMentionTokens,
  shotReferenceCharacterIds,
  shotPropMentionCorpus,
  shotSemanticCharacterIds,
  shotVideoPropBindings
} = require("../app/workbench-workflow");

function fixture() {
  const project = {
    generation: {
      engine: "hailuo-h3",
      mode: "asset_direct",
      aspectRatio: "9:16",
      visualStyle: "Realistic Chinese vertical live-action drama with natural practical light"
    },
    characters: [
      { id: "C01", name: "林岚" },
      { id: "C02", name: "周梅" },
      { id: "C03", name: "顾远" }
    ]
  };
  const vocalArc = "She starts in a breath-starved low register, lets pitch crack upward on the accusation, accelerates through the middle clause, stops for one painful beat before the evidence, drives hard stress into the final noun, then drops volume into a trembling exhausted tail.";
  const expressionArc = "Her eyes begin wet but fixed, the inner brows lift on the accusation, nostrils flare at the pressure word, the jaw locks around the evidence, and the final syllable releases into a visible tear and stunned aftershock.";
  const bodyArc = "C01 keeps her left palm on the cut wedding dress, raises the property envelope with her shaking right hand, squares her shoulders toward C02, then places the envelope on the table without releasing it.";
  const facingArc = "C01 remains screen-left in readable three-quarter profile, face, eyes and upper torso aimed screen-right at C02; C02 remains screen-right, and both eyelines stay on the established 180-degree axis.";
  const listenerReaction = "C02 keeps resting lips, recoils half a step when the dress is cut, looks from the scissors to the envelope, swallows once, and loses the held eyeline without speaking.";
  const shot = {
    id: "S02",
    number: 2,
    duration: 14,
    sceneId: "SC01",
    characterIds: ["C01", "C02", "C03"],
    scenePresenceCharacterIds: ["C01", "C02", "C03"],
    visibleCharacterIds: ["C01", "C02"],
    action: "顾远在背景推门进入，林岚用剪刀剪开礼服，把房产证文件袋摔在桌上；门铃响过后，门外亲友鼓掌。",
    actionEn: "C03 enters through the established doorway behind them. C01 cuts P01 once with P02, then slams the property envelope onto the table; the caused reactions follow in that order.",
    stateBeforeEn: "P01 is intact under C01's left hand; P02 is closed in her right hand; C02 faces C01; C03 is outside the doorway.",
    stateAfterEn: "P01 has one visible cut; P02 is closed beside it; the property envelope lies under C01's palm; C03 has stopped inside the doorway; C02 has recoiled.",
    audioPlan: "持续室内底噪，剪刀剪开礼服声，文件袋摔桌声，门铃一声，亲友鼓掌声。",
    subshots: [{
      start: 0,
      end: 14,
      framingEn: "Speaker-owned medium close-up with C02 held over C01's shoulder; motivated doorway and group reaction inserts",
      cameraEn: "Hold C01 through her complete line, cut to C02's caused reaction, then use a brief medium-wide doorway and applause cutaway before returning to the same axis",
      blockingEn: facingArc,
      backgroundActionEn: "C03 enters once through the background doorway; several anonymous relatives applaud together only after the evidence lands",
      actionEn: "C03 enters through the established doorway behind them. C01 cuts P01 once with P02, then slams the property envelope onto the table; the caused reactions follow in that order.",
      stateBeforeEn: "P01 is intact under C01's left hand; P02 is closed in her right hand; C02 faces C01; C03 is outside the doorway.",
      stateAfterEn: "P01 has one visible cut; P02 is closed beside it; the property envelope lies under C01's palm; C03 has stopped inside the doorway; C02 has recoiled.",
      sound: "持续室内底噪，剪刀剪开礼服声，文件袋摔桌声，门铃一声，亲友鼓掌声。",
      visibleCharacterIds: ["C01", "C02"],
      dialogueTurns: [{
        sourceDialogueId: "D001",
        speakerId: "C01",
        listenerIds: ["C02"],
        spokenText: "你剪掉的是礼服，我剪掉的是这些年对你们的幻想！",
        intentEn: "Seeing C02 reach for the intact dress forces C01 to stop the humiliation and make the evidence impossible to ignore",
        vocalArcEn: vocalArc,
        expressionEn: expressionArc,
        bodyEn: bodyArc,
        speakerFacingEn: facingArc,
        listenerReactionEn: listenerReaction
      }, {
        sourceDialogueId: "D002",
        speakerId: "C02",
        listenerIds: ["C01"],
        spokenText: "你把房子也给她了？",
        intentEn: "The property envelope destroys C02's assumption of control and forces a disbelieving question",
        vocalArcEn: "She begins with a dry involuntary gasp, jumps to a thin high pitch on 房子, slows in disbelief, and lets the final particle fall almost voiceless.",
        expressionEn: "Her eyes snap to the envelope, brows rise unevenly, and the jaw slackens before tightening in fear.",
        bodyEn: "C02 retreats half a step, keeps both hands away from the evidence, and loses balance into the chair edge.",
        speakerFacingEn: "C02 remains screen-right, turns face and torso screen-left toward C01, and never addresses the camera.",
        listenerReactionEn: "C01 keeps resting lips, holds one palm over the envelope and answers only with an unwavering eyeline."
      }]
    }]
  };
  const references = {
    images: ["scene.png", "c01.png", "c02.png", "c03.png", "dress.png", "scissors.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "character", entityId: "C03" },
      { type: "prop", entityId: "P01", holderCharacterId: "C01", stateBefore: "intact dress", stateAfter: "one visible cut" },
      { type: "prop", entityId: "P02", holderCharacterId: "C01", stateBefore: "closed scissors", stateAfter: "closed beside the cut dress" }
    ],
    audios: [
      { characterId: "C01", path: "c01.wav" },
      { characterId: "C02", path: "c02.wav" }
    ]
  };
  return { project, shot, references, expected: { vocalArc, expressionArc, bodyArc, facingArc, listenerReaction } };
}

function compileFixture() {
  const data = fixture();
  const plan = buildCameraTakePlan(data.project, data.shot);
  assert.equal(validateCameraTakePlan(plan, data.project, data.shot), true);
  assert.equal(plan.generationBlocks.length, 1);
  const sourceBlock = plan.generationBlocks[0];
  const block = { ...sourceBlock, takes: generationBlockTakes(plan, sourceBlock) };
  const references = filterReferencesForGenerationBlock(data.references, block, {
    blockCount: 1,
    multiBlock: false
  });
  const prompt = buildHailuoGenerationBlockPrompt(data.project, data.shot, block, references);
  return { ...data, plan, block, references, prompt };
}

test("final H3 director payload keeps complete causal acting, camera and listener contracts", () => {
  const { prompt, expected } = compileFixture();
  assert.match(AGENT_DIRECTOR_VERSION, /v25-official-six-section-en/);
  assert.equal(HAILUO_TAKE_PROMPT_LIMIT, 8000);
  assert.ok(prompt.startsWith("subject_definitions:\n"));
  assert.match(prompt, new RegExp(expected.vocalArc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, new RegExp(expected.expressionArc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /Only <Subject 1> \(S1\) moves the lips for this line/);
  assert.match(prompt, /<Subject 2> remains closed-lipped/);
  assert.match(prompt, /switch camera ownership and speaking-mouth ownership together with a direct hard cut|cut to <Subject \d+>'s established visible speaking face without changing that person's identity|cut only to the next authored on-screen speaker's established face; identity never changes inside a face|direct hard cut to the next visible speaker; keep identities stable|cut directly to the next named speaker and switch speaking-mouth ownership together/);
  assert.match(prompt, /180-degree eyeline axis/);
  assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
  assert.match(prompt, /<d>\[Chinese\] 你剪掉的是礼服，我剪掉的是这些年对你们的幻想！<\/d>/);
  assert.match(prompt, /<d>\[Chinese\] 你把房子也给她了？<\/d>/);
});

test("final H3 director payload binds every named entity once and prevents clones or scene multiplication", () => {
  const { prompt, references } = compileFixture();
  assert.deepEqual(references.imageRoles.filter(role => role.type === "character").map(role => role.entityId), ["C01", "C02", "C03"]);
  assert.match(prompt, /<Subject 4>[^\n]+<Picture 4>/);
  assert.match(prompt, /<Subject 5>[^\n]+P01[^\n]+<Picture 5>/);
  assert.match(prompt, /<Subject 6>[^\n]+P02[^\n]+<Picture 6>/);
  assert.match(prompt, /Every person, product and prop remains one unique physical instance|Keep one unique instance per person, product and prop/);
  assert.match(prompt, /every extra remains a silent story-world participant|silent bystanders applauding/);
  assert.doesNotMatch(prompt, /recurring product/, "a shot without a product reference must not prime a product entity");
});

test("source physical sounds survive the final provider compiler", () => {
  const { prompt } = compileFixture();
  assert.match(prompt, /metal scissors snip/);
  assert.match(prompt, /object impact on the authored surface/);
  assert.match(prompt, /doorbell ring/);
  assert.match(prompt, /audience applause/);
  assert.match(prompt, /continuous room tone/);
});

test("reference planning detects named background actors and core props from Chinese or provider-English fields", () => {
  const project = {
    characters: [
      { id: "C01", name: "林岚" },
      { id: "C02", name: "周梅" },
      { id: "C03", name: "顾远" }
    ],
    assetLibraries: {
      props: [
        { id: "P01", name: "白色婚礼礼服", assetRequired: true },
        { id: "P02", name: "银色裁衣剪刀", assetRequired: true },
        { id: "P03", name: "房产证文件袋", assetRequired: true }
      ]
    }
  };
  const shot = {
    id: "S02",
    action: "林岚把礼服压在桌上，用剪刀剪开布料。",
    actionEn: "C03 enters through the doorway while C01 cuts P01 with P02 and pushes P03 toward C02.",
    stateBeforeEn: "P01 is intact; P02 is in C01's right hand; P03 is sealed.",
    stateAfterEn: "P01 has one cut; P02 is closed; P03 rests before C02.",
    subshots: [],
    dialogueTurns: []
  };
  assert.deepEqual(shotSemanticCharacterIds(project, shot), ["C01", "C02", "C03"]);
  assert.match(shotPropMentionCorpus(shot), /P03 rests before C02/);
  assert.ok(propMentionTokens(project.assetLibraries.props[0]).includes("礼服"));
  assert.deepEqual(shotVideoPropBindings(project, shot).map(item => item.propId), ["P01", "P02", "P03"]);
});

test("strict parent manifest accepts a semantically required third actor without relaxing identity uniqueness", () => {
  const project = {
    generation: { engine: "hailuo-h3" },
    characters: [
      { id: "C01", name: "林岚" },
      { id: "C02", name: "周梅" },
      { id: "C03", name: "顾远" }
    ]
  };
  const shot = {
    id: "S03",
    visibleCharacterIds: ["C01", "C02", "C03"],
    videoReferenceCharacterIds: ["C01", "C02"],
    actionEn: "C03 enters once through the doorway behind C01 and C02.",
    dialogueTurns: []
  };
  const references = {
    imageRoles: [
      { type: "character", entityId: "C01", path: "c01.png" },
      { type: "character", entityId: "C02", path: "c02.png" },
      { type: "character", entityId: "C03", path: "c03.png" }
    ],
    audios: []
  };
  assert.deepEqual(shotReferenceCharacterIds(project, shot), ["C01", "C02", "C03"]);
  assert.equal(assertStrictCharacterMediaBindings(project, shot, references), true);
  assert.throws(
    () => assertStrictCharacterMediaBindings(project, shot, {
      ...references,
      imageRoles: [...references.imageRoles, { type: "character", entityId: "C03", path: "c03-duplicate.png" }]
    }),
    error => error?.code === "SHOT_CHARACTER_IDENTITY_BINDING_INVALID"
  );
});
