"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  finalizeVideoPromptForSubmission,
  PROMPT_REVIEW_BUNDLE_VERSION,
  promptReviewReferencePlan,
  renderApprovedVideoPrompt,
  shotVideoProductReferenceRequired
} = require("../app/workbench-workflow");

function fixture() {
  const shot = {
    id: "S01",
    number: 1,
    duration: 12,
    sceneId: "SC01",
    scene: "婚礼准备室",
    characterIds: ["C01", "C02", "C03"],
    visibleCharacterIds: ["C01", "C02"],
    scenePresenceCharacterIds: ["C01", "C02", "C03"],
    videoReferenceCharacterIds: ["C01", "C02", "C03"],
    action: "C01拿起泡泡染发膏，C02面对C01查看发色，礼服放在后方。",
    visualBeat: "两人确认发色自然，第三人只在场但不入镜。",
    stateBefore: "C01刚洗净头发。",
    stateAfter: "C01与C02确认结果。",
    productMention: true,
    productShotType: "natural_use",
    propNames: ["礼服"],
    dialogueTurns: [
      {
        sourceDialogueId: "D001",
        speakerId: "C01",
        speaker: "林秀兰",
        listenerIds: ["C02"],
        text: "这个颜色很自然。",
        spokenText: "这个颜色很自然。",
        sourceTone: "欣慰、温柔",
        deliveryEn: "C01 speaks with relieved warmth.",
        vocalArcEn: "C01 begins softly, stresses natural, and releases the ending on a calm exhale.",
        expressionEn: "C01 softens the eyes and forms a small sincere smile.",
        expressionArcEn: "C01 begins guarded, relaxes the brow at the key word, and ends with a small smile.",
        bodyEn: "C01 touches the hair ends and lowers the hand.",
        blockingEn: "C01 is screen-left and C02 is screen-right.",
        speakerFacingEn: "C01 faces C02 on screen-right and meets C02's eyeline.",
        listenerReactionEn: "C02 stays silent, closes the lips, and nods once."
      }
    ],
    promptMode: "system"
  };
  const project = {
    id: "P01",
    productionRevision: "rev-one",
    generation: { mode: "asset_direct", engine: "hailuo-h3", aspectRatio: "9:16" },
    characters: [
      { id: "C01", name: "林秀兰" },
      { id: "C02", name: "陈强" },
      { id: "C03", name: "程雅" }
    ],
    scenes: [{ id: "SC01", name: "婚礼准备室" }],
    product: { name: "七味堂植物泡泡染发膏", imagePath: "product.png" },
    assetLibraries: {
      wardrobes: [],
      props: [
        { id: "P01", name: "礼服", units: ["S01"] },
        { id: "P02", name: "房产证文件袋", units: ["S01"] }
      ]
    },
    shots: [shot]
  };
  return { project, shot };
}

test("prompt review enumerates the exact two-face H3 manifest in submission order", () => {
  const { project, shot } = fixture();
  const plan = promptReviewReferencePlan(project, shot, "asset_direct");
  assert.deepEqual(
    plan.imageRoles.map(role => `${role.type}:${role.entityId}`),
    ["scene:SC01", "character:C01", "character:C02", "product:product", "prop:P01"]
  );
  assert.equal(plan.imageRoles.some(role => role.entityId === "C03"), false, "scene-presence extras must not shift Picture tokens");
  assert.equal(plan.imageRoles.some(role => role.entityId === "P02"), false, "unit bookkeeping alone must not upload an invisible prop");
  assert.deepEqual(plan.audios.map(item => item.characterId), [], "image-only mode must not reserve or upload a voice reference");
});

test("submission finalization does not silently rebind reviewed prose when the reference manifest changes", () => {
  const { project, shot } = fixture();
  const staleReferences = {
    images: ["scene.png", "c01.png", "c02.png", "c03.png", "product.png", "prop.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "character", entityId: "C03" },
      { type: "product", entityId: "product" },
      { type: "prop", entityId: "P01" }
    ],
    audios: [{ characterId: "C01", characterName: "林秀兰" }],
    aspectRatio: "9:16",
    hailuoApiMode: "multimodal_to_video"
  };
  const actualReferences = {
    images: ["scene.png", "c01.png", "c02.png", "product.png", "prop.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "product", entityId: "product" },
      { type: "prop", entityId: "P01" }
    ],
    audios: [{ characterId: "C01", characterName: "林秀兰" }],
    aspectRatio: "9:16",
    hailuoApiMode: "multimodal_to_video"
  };
  shot.promptReviewReferencePlan = {
    images: staleReferences.imageRoles,
    audios: staleReferences.audios
  };
  const stalePrompt = renderApprovedVideoPrompt(project, shot, staleReferences);
  const expected = renderApprovedVideoPrompt(project, shot, actualReferences);
  const before = structuredClone(project);
  const rebound = finalizeVideoPromptForSubmission(
    project,
    "shot",
    "S01",
    "shot_video",
    stalePrompt,
    "hailuo-h3",
    actualReferences
  );
  assert.notEqual(stalePrompt, expected, "changed bindings require preparation and review before submission");
  assert.equal(rebound, stalePrompt, "finalization cannot substitute a new draft for the reviewed text");
  assert.deepEqual(project, before, "transport finalization must not silently change displayed project content");
});

test("execution prompt never invents reference-bound subjects for unuploaded supporting cast or props", () => {
  const { project, shot } = fixture();
  shot.action = "C03 silently repairs P02 in the background while C01 and C02 inspect the result.";
  shot.visualBeat = "C03 folds P02 and leaves it on the rear table.";
  shot.dialogueTurns[0].bodyEn = "C01 gently smooths C01's own damp hair ends and lowers the hand.";
  const references = {
    images: ["scene.png", "c01.png", "c02.png", "product.png", "prop.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "product", entityId: "product" },
      { type: "prop", entityId: "P01" }
    ],
    audios: [{ characterId: "C01", characterName: "C01" }],
    promptMode: "asset_direct",
    videoStrategy: "asset_direct"
  };
  const prompt = renderApprovedVideoPrompt(project, shot, references);
  assert.doesNotMatch(prompt, /the recurring (?:adult|character) C03/i);
  assert.match(prompt, /source-identified character C03/, "missing media must not erase a source character identity");
  assert.match(prompt, /\bP02\b/, "an unreferenced prop retains its source identity without creating an image binding");
  assert.doesNotMatch(prompt, /<Subject 6>|<Subject 7>/i, "unuploaded background entities must stay unbound");
  assert.doesNotMatch(prompt, /The treatment recipient is/i, "self-grooming must not be rebound onto the listener");
  assert.doesNotMatch(prompt, /existing continuity object B/, "missing English metadata must not erase a source prop identity");
  project.assetLibraries.props[1].nameEn = "brown document envelope";
  const grounded = renderApprovedVideoPrompt(project, shot, references);
  assert.match(grounded, /the brown document envelope/);
  assert.doesNotMatch(grounded, /\bP02\b|existing continuity object B/);
});

test("an after-result product beat does not upload an invisible package reference", () => {
  const { project, shot } = fixture();
  shot.action = "时间经过。林秀兰清洗头发后抬起脸，白发盖色自然，发色不僵黑。";
  shot.visualBeat = "孙子查看奶奶洗净后的自然发色，两人确认结果。";
  shot.stateBefore = "头发已经清洗干净。";
  shot.stateAfter = "发色变为自然深色。";
  shot.dialogueTurns[0].text = "奶奶，这个颜色很自然，人还是你，只是精神多了。";
  shot.dialogueTurns[0].spokenText = shot.dialogueTurns[0].text;

  assert.equal(shotVideoProductReferenceRequired(project, shot), false);
  const plan = promptReviewReferencePlan(project, shot, "asset_direct");
  assert.equal(plan.imageRoles.some(role => role.type === "product"), false);
});

test("visible package handling and application still require the real product image", () => {
  const { project, shot } = fixture();
  shot.action = "林秀兰撕开一袋泡泡染发膏，挤出细腻泡沫并揉开到发根和鬓角。";
  shot.visualBeat = "手部近景展示小袋、泡沫和发根涂匀动作。";
  assert.equal(shotVideoProductReferenceRequired(project, shot), true);
  const plan = promptReviewReferencePlan(project, shot, "asset_direct");
  assert.equal(plan.imageRoles.some(role => role.type === "product"), true);
});

test("pre-applied dye foam and spoken product claims do not consume a package reference slot", () => {
  const { project, shot } = fixture();
  shot.action = "林秀兰对着镜子把已经揉开的细腻泡沫均匀带到发根和鬓角，程雅继续缝礼服。";
  shot.visualBeat = "镜中展示泡沫覆盖发根的状态，包装始终不在画面内。";
  shot.stateBefore = "一袋泡泡染发膏已经在上一镜拆封，泡沫已在头发上。";
  shot.stateAfter = "七味堂植物泡泡染发膏的泡沫覆盖两侧发根。";
  shot.dialogueTurns[0].text = "七味堂这个泡沫真细，发根也顾得到。";
  shot.dialogueTurns[0].spokenText = shot.dialogueTurns[0].text;

  assert.equal(shotVideoProductReferenceRequired(project, shot), false);
  const plan = promptReviewReferencePlan(project, shot, "asset_direct");
  assert.equal(plan.imageRoles.some(role => role.type === "product"), false);
});

test("reflowed dialogue owns one visual timeline and never repeats a line across a legacy cut", () => {
  const { project, shot } = fixture();
  project.promptReview = { version: PROMPT_REVIEW_BUNDLE_VERSION, status: "approved" };
  shot.promptReviewBundleVersion = PROMPT_REVIEW_BUNDLE_VERSION;
  shot.duration = 12;
  shot.characterIds = ["C01", "C02"];
  shot.visibleCharacterIds = ["C01", "C02"];
  shot.providerTimedDirections = [
    { startSecond: 0, endSecond: 6.1, actionEn: "A silent hard-cut time-compression sequence finishes unrelated preparation.", cameraEn: "Use quick inserts." },
    { startSecond: 6.1, endSecond: 8.4, actionEn: "C01 apologizes to C02 and C02 answers calmly while inspecting the result.", cameraEn: "Cut between both faces." },
    { startSecond: 8.4, endSecond: 12, actionEn: "C02 raises the chin and holds the final result.", cameraEn: "Push to the result." }
  ];
  shot.dialogueTurns = [
    {
      sourceDialogueId: "D101", speakerId: "C01", listenerIds: ["C02"],
      startSecond: 4.35, endSecond: 6.05,
      text: "奶奶，这个颜色很自然，人还是你，只是精神多了。",
      bodyEn: "C01 looks from C02's roots to the hair ends.",
      blockingEn: "C01 is screen-right and C02 is screen-left.",
      speakerFacingEn: "C01 faces C02 on the same eyeline axis.",
      listenerReactionEn: "C02 keeps the lips closed and touches the damp hair ends."
    },
    {
      sourceDialogueId: "D102", speakerId: "C02", listenerIds: ["C01"],
      startSecond: 6.45, endSecond: 8.15,
      text: "我也没想装年轻，干净体面就好。",
      bodyEn: "C02 smooths the hair ends and looks toward C01.",
      blockingEn: "C02 is screen-left and C01 is screen-right.",
      speakerFacingEn: "C02 faces C01 on the same eyeline axis.",
      listenerReactionEn: "C01 keeps the lips closed and nods once."
    }
  ];
  project.foundry = {
    scriptUnderstanding: {
      productionIR: {
        units: [{
          id: "S01",
          spokenTurns: shot.dialogueTurns.map(({ startSecond, endSecond, ...turn }) => turn),
          silentDirections: { action: shot.action, visualBeat: shot.visualBeat }
        }]
      }
    }
  };
  const references = {
    images: ["scene.png", "c01.png", "c02.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [{ characterId: "C01" }, { characterId: "C02" }],
    promptMode: "asset_direct",
    videoStrategy: "asset_direct"
  };

  const prompt = renderApprovedVideoPrompt(project, shot, references);
  const visualLines = prompt.split("\n").filter(line => /^\[Shot \d+\]/u.test(line));
  const dialogueLines = prompt.split("\n").filter(line => /^\[Shot \d+\]/u.test(line) && line.includes("<d>[Chinese]"));
  assert.ok(visualLines.length >= 2, "the integrated timeline must retain explicit camera beats");
  assert.doesNotMatch(prompt, /time-compression sequence|speak in sequence/i);
  assert.equal(dialogueLines.length, 2);
  assert.match(dialogueLines[0], /Only <Subject 1> \(S1\) moves the lips for this line/);
  assert.match(dialogueLines[1], /Only <Subject 2> \(S2\) moves the lips for this line/);
  assert.equal((prompt.match(/奶奶，这个颜色很自然，人还是你，只是精神多了。/g) || []).length, 1);
  assert.equal((prompt.match(/我也没想装年轻，干净体面就好。/g) || []).length, 1);
});
