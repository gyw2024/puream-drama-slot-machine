"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultPromptTemplates } = require("../app/prompt-library");
const {
  WorkbenchWorkflow,
  promptReviewReferencePlan,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese,
  resolveShotVideoStrategy
} = require("../app/workbench-workflow");
const {
  MATRIX,
  matrixRuntimeVideoPromptForProject
} = require("../app/production-mode-matrix");
const {
  assertHailuoFinalPromptIntegrity,
  containsCjkOutsideDialogue
} = require("../app/hailuo-h3-prompt");

const MODES = [
  "production_package",
  "asset_direct",
  "keyframe",
  "continuation",
  "smart",
  "storyboard_sheet"
];

const EXPECTED_FINAL_LOCK = "The deliverable is a clean full-frame camera-original live-action plate: every visible pixel belongs to the photographed story world. On-screen dialogue synchronizes only its named speaker's lips; off-screen dialogue leaves every visible mouth closed.";

function createOfflineWorkflow() {
  const calls = { text: 0, fetch: 0, bridge: 0, media: 0 };
  const deny = kind => async () => {
    calls[kind] += 1;
    throw new Error(`OFFLINE_AUDIT_FORBIDS_${kind.toUpperCase()}`);
  };
  const workflow = new WorkbenchWorkflow({
    store: {},
    bridge: new Proxy({}, { get: () => deny("bridge") }),
    locateFfmpeg: deny("media"),
    stagingRoot: "OFFLINE-AUDIT-NO-MEDIA",
    textGenerator: deny("text"),
    remoteFetch: deny("fetch")
  });
  return { workflow, calls };
}

function dialogueTurns() {
  return [
    {
      sourceDialogueId: "D001",
      speakerId: "C01",
      speaker: "顾景川",
      listenerIds: ["C02"],
      text: "你拿走母亲的救命钱，还敢说是为了我？",
      onScreen: true,
      deliveryEn: "begin low and restrained, sharpen the accusation, then land the final question with clipped disbelief",
      vocalArcEn: "low chest register, controlled volume, faster through the accusation, a short pause before the final question, hard stress on the phrase life-saving money",
      expressionArcEn: "wet eyes stay fixed on the listener, brows tighten at the accusation, jaw locks on the final question",
      bodyActionEn: "keep the ledger pinned with the right palm and push it six centimeters toward the listener only after the stressed keyword",
      blockingEn: "C01 holds screen-left in the foreground while C02 holds screen-right half a step deeper; both faces remain unobstructed",
      speakerFacingEn: "C01 keeps a readable three-quarter face toward C02 on screen-right and never looks into the lens",
      listenerReactionEn: "C02 keeps resting lips, swallows once, and shifts the gaze from the ledger back to C01",
      metadata: {
        deliveryEn: "begin low and restrained, sharpen the accusation, then land the final question with clipped disbelief",
        vocalArcEn: "low chest register, controlled volume, faster through the accusation, a short pause before the final question, hard stress on the phrase life-saving money",
        expressionArcEn: "wet eyes stay fixed on the listener, brows tighten at the accusation, jaw locks on the final question",
        bodyActionEn: "keep the ledger pinned with the right palm and push it six centimeters toward the listener only after the stressed keyword",
        blockingEn: "C01 holds screen-left in the foreground while C02 holds screen-right half a step deeper; both faces remain unobstructed",
        speakerFacingEn: "C01 keeps a readable three-quarter face toward C02 on screen-right and never looks into the lens",
        listenerReactionEn: "C02 keeps resting lips, swallows once, and shifts the gaze from the ledger back to C01"
      }
    },
    {
      sourceDialogueId: "D002",
      speakerId: "C02",
      speaker: "沈知夏",
      listenerIds: ["C01"],
      text: "钱没动，这是账本；羊脂皂也一直在我手里。",
      onScreen: true,
      directToViewer: false,
      deliveryEn: "answer quickly under pressure, slow down on the proof, then finish with steady wounded certainty",
      vocalArcEn: "medium-low pitch, firm volume, one clean pause after the word ledger, slower final clause, stress the product name and the final phrase still in my hand",
      expressionArcEn: "fear flashes in the eyes, the brows release when the proof is shown, then hurt settles across the face",
      bodyActionEn: "open the ledger with the left hand, lift the single exact referenced soap package in the right hand, and keep it physically held beside the chest",
      blockingEn: "C02 remains screen-right and steps only into the established focus mark; C01 remains screen-left without crossing the axis",
      speakerFacingEn: "C02 faces C01 on screen-left with a readable three-quarter speaking face and keeps the product upright in the right hand",
      listenerReactionEn: "C01 closes the mouth, follows the ledger with the eyes, then softens the jaw after seeing the held product",
      metadata: {
        deliveryEn: "answer quickly under pressure, slow down on the proof, then finish with steady wounded certainty",
        vocalArcEn: "medium-low pitch, firm volume, one clean pause after the word ledger, slower final clause, stress the product name and the final phrase still in my hand",
        expressionArcEn: "fear flashes in the eyes, the brows release when the proof is shown, then hurt settles across the face",
        bodyActionEn: "open the ledger with the left hand, lift the single exact referenced soap package in the right hand, and keep it physically held beside the chest",
        blockingEn: "C02 remains screen-right and steps only into the established focus mark; C01 remains screen-left without crossing the axis",
        speakerFacingEn: "C02 faces C01 on screen-left with a readable three-quarter speaking face and keeps the product upright in the right hand",
        listenerReactionEn: "C01 closes the mouth, follows the ledger with the eyes, then softens the jaw after seeing the held product"
      }
    }
  ];
}

function shot(number, sceneId = "SC01") {
  const turns = dialogueTurns();
  return {
    id: `S${String(number).padStart(2, "0")}`,
    number,
    duration: 12,
    sceneId,
    sceneName: sceneId === "SC01" ? "老剧院化妆间" : "雨夜医院走廊",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    focusCharacterId: "C01",
    counterpartCharacterId: "C02",
    action: "顾景川把账本推向沈知夏；沈知夏翻开账本并始终用右手拿着同一盒羊脂皂作为证物。",
    actionEn: "C01 pushes the ledger toward C02; C02 opens the ledger with the left hand and keeps the single exact referenced soap package physically held in the right hand as evidence.",
    visualBeat: "账本翻开，沈知夏手持羊脂皂澄清真相。",
    stateBefore: "顾景川在画面左前景按住合拢账本，沈知夏在右后景空着双手。",
    stateBeforeEn: "C01 holds the closed ledger at screen-left foreground while C02 stands half a step deeper at screen-right with empty hands.",
    stateAfter: "账本已经翻开，沈知夏右手稳定拿着唯一一盒羊脂皂，顾景川看清证据。",
    stateAfterEn: "The ledger is open; C02 physically holds the one referenced soap package in the right hand, and C01 has visibly registered the proof.",
    startFrame: "顾景川按住合拢账本，沈知夏在右侧闭口等待。",
    endFrame: "沈知夏右手持羊脂皂、左手按住翻开的账本，顾景川看向证据。",
    shotSize: "中近景正反打",
    cameraMove: "台词换人时沿180度轴线硬切，证物抬起时短促推进",
    compositionPlan: "顾景川固定画面左，沈知夏固定画面右；人物与证物不跨轴",
    emotion: "克制质问升级为受伤澄清，证据出现后关系松动",
    performance: "两人都有清晰微表情弧；说话人面对听者，听者闭口反应",
    audioPlan: "连续安静室内底噪；只有账本纸页和包装接触声；无音乐、无人群声、无额外人声",
    dialogueTurns: turns,
    subshots: [
      {
        number: 1,
        start: 0,
        end: 5.7,
        framingEn: "medium close-up on C01 with C02 retained as a soft screen-right eyeline target",
        cameraEn: "hold the established left-side axis, then make one direct hard cut only after D001 ends",
        actionEn: "C01 keeps the ledger pinned and pushes it toward C02 after the stressed accusation",
        stateBeforeEn: "C01 pins the closed ledger while C02 waits at screen-right",
        stateAfterEn: "C01 has pushed the ledger toward C02 and closes the mouth",
        soundEn: "continuous quiet dressing-room ambience under exact dialogue with one synchronized paper-slide sound",
        dialogueTurns: [turns[0]],
        visibleCharacterIds: ["C01", "C02"]
      },
      {
        number: 2,
        start: 5.7,
        end: 12,
        framingEn: "direct reverse medium close-up on C02 with C01 retained as a soft screen-left listener",
        cameraEn: "hard cut to C02 on the same 180-degree axis, then make one motivated short push-in when the held product becomes visible",
        actionEn: "C02 opens the ledger with the left hand, lifts the single exact referenced soap package with the right hand, and keeps it held through the visible result",
        stateBeforeEn: "C02 receives the closed ledger while both mouths are closed at the cut",
        stateAfterEn: "C02 holds the exact soap package in the right hand beside the open ledger while C01 registers the proof",
        soundEn: "the same continuous quiet dressing-room ambience under exact dialogue with one synchronized page-open and package-contact sound",
        dialogueTurns: [turns[1]],
        visibleCharacterIds: ["C01", "C02"]
      }
    ],
    dialogueSourceIds: ["D001", "D002"],
    productMention: true,
    productShotType: "product_use",
    productBinding: {
      source: "user_uploaded_product",
      name: "羊脂皂",
      sourceDialogueIds: ["D002"],
      holderCharacterId: "C02",
      hand: "right",
      entryActionEn: "C02 lifts the single exact referenced product from the open bag with the right hand",
      demonstrationActionEn: "C02 holds the package upright beside the open ledger without covering the face",
      finalHolderStateEn: "C02 still holds the same package in the right hand"
    },
    propNames: ["旧账本"],
    propBindings: [{
      propId: "P01",
      holderBeforeCharacterId: "C01",
      holderAfterCharacterId: "C02",
      holderCharacterId: "C02",
      hand: "left",
      stateBefore: "closed",
      stateAfter: "open",
      transferAction: "C01 slides the ledger to C02; C02 opens it only after taking control",
      visibleInSubshots: [1, 2]
    }],
    presentBefore: ["C01", "C02"],
    presentAfter: ["C01", "C02"]
  };
}

function projectFor(mode) {
  const shots = [shot(1, "SC01"), shot(2, "SC01"), shot(3, "SC02")];
  const project = {
    id: `OFFLINE-${mode}`,
    generation: {
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode,
      aspectRatio: "9:16",
      shotDuration: 12
    },
    story: {
      premise: "顾景川误会沈知夏侵吞救命钱，沈知夏用账本和一直手持的羊脂皂证明自己守住了承诺。"
    },
    characters: [
      { id: "C01", name: "顾景川", age: "53", gender: "male", role: "lead", description: "53-year-old Chinese man, lean, salt-and-pepper swept-back hair, charcoal suit", identitySignature: "long narrow face, deep-set eyes, salt-and-pepper swept-back hair" },
      { id: "C02", name: "沈知夏", age: "50", gender: "female", role: "co-lead", description: "50-year-old Chinese woman, composed posture, shoulder-length dark hair, camel coat", identitySignature: "oval face, calm almond eyes, shoulder-length dark hair" }
    ],
    scenes: [
      { id: "SC01", name: "老剧院化妆间", description: "长方形内景，左侧门，后墙镜台，右侧衣架，中央木桌；入口、门窗、家具和轴线固定", interiorExterior: "interior", time: "night", lighting: "warm practical bulbs from the rear mirror, soft key from camera-left", axis: "table-centred left-right eyeline axis", entrances: "single door on frame-left" },
      { id: "SC02", name: "雨夜医院走廊", description: "狭长医院内景，后方电梯，左侧病房门，右侧长椅；空间拓扑固定", interiorExterior: "interior", time: "night", lighting: "cool ceiling lights and soft spill from frame-left doors", axis: "corridor longitudinal axis", entrances: "rear elevator and frame-left ward door" }
    ],
    product: {
      name: "羊脂皂",
      description: "用户上传的白色盒装羊脂皂，包装外观不可改变",
      sellingPoints: "只允许引用用户已提供的温和清洁信息",
      imagePath: "OFFLINE-FIXTURE-IMMUTABLE-PRODUCT.png",
      assetId: "PRODUCT01",
      metadata: { userSuppliedImmutable: true }
    },
    assetLibraries: {
      props: [{ id: "P01", name: "旧账本", description: "一本深棕布面旧账本，纸页泛黄", isCore: true, storyFunction: "证明救命钱未被挪用", continuity: "S01-S03始终是同一本账本" }],
      wardrobes: []
    },
    shots
  };
  if (mode === "production_package") {
    project.importedProductionPackage = true;
    for (const item of project.shots) {
      item.promptReviewReferencePlan = {
        images: [
          { type: "scene", entityId: item.sceneId, assetId: item.sceneId, label: "locked scene board" },
          { type: "character", entityId: "C01", assetId: "C01", label: "locked C01 identity" },
          { type: "character", entityId: "C02", assetId: "C02", label: "locked C02 identity" },
          { type: "product", entityId: "product", assetId: "PRODUCT01", label: "immutable user product" },
          { type: "prop", entityId: "P01", assetId: "P01", label: "locked ledger" }
        ]
      };
    }
  }
  return project;
}

function settings() {
  return {
    generation: {
      visualStyle: "photorealistic Chinese vertical short-drama live action",
      qualityGatesEnabled: true,
      qualityGateModules: { script: true, storyboards: true, videos: true }
    },
    videoProvider: { hailuoReferenceAudioMode: "image_only", hailuoApiMode: "reference_to_video" },
    prompts: defaultPromptTemplates()
  };
}

function stripDialogue(prompt) {
  return String(prompt).replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/giu, "<d>[Chinese]</d>");
}

function dialogueWindows(prompt) {
  return String(prompt).split(/\r?\n/).filter(line => /<d>\[Chinese\][\s\S]*?<\/d>/u.test(line) && /^\[Shot \d+\]/u.test(line)).map(line => {
    const match = [...line.slice(0, line.indexOf("<d>")).matchAll(/From (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) seconds/gu)].at(-1);
    return { line, start: Number(match?.[1]), end: Number(match?.[2]) };
  });
}

function requiredDialogueSeconds(text) {
  const source = String(text || "");
  const spoken = (source.match(/[\u3400-\u9fffA-Za-z0-9]/gu) || []).length;
  return spoken / 8;
}

test("production-mode inventory is exact and complete", () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), MODES.map(mode => `cloud:${mode}`).sort());
});

test("mixed-language provider performance metadata cannot degrade into a dangling English control clause", () => {
  const project = projectFor("asset_direct");
  const target = project.shots[0].dialogueTurns[0];
  target.vocalArcEn = "low chest register, then hard stress on 救命钱";
  target.metadata.vocalArcEn = target.vocalArcEn;
  const refs = promptReviewReferencePlan(project, project.shots[0], "asset_direct", "image_only");
  const prompt = renderApprovedVideoPrompt(project, project.shots[0], refs);
  assert.doesNotMatch(prompt, /hard stress on\s*[.;]/iu);
});

for (const mode of MODES) {
  test(`${mode}: offline pre-asset image/reference strategy is mode-correct`, () => {
    const { workflow, calls } = createOfflineWorkflow();
    const project = projectFor(mode);
    const config = settings();
    const stagesByShot = project.shots.map(item => resolveShotVideoStrategy(project, item).frameStages);

    if (["production_package", "asset_direct"].includes(mode)) {
      assert.deepEqual(stagesByShot, [[], [], []]);
    } else if (mode === "keyframe") {
      assert.deepEqual(stagesByShot, project.shots.map(() => ["storyboard_start", "storyboard_end"]));
    } else if (mode === "continuation") {
      assert.deepEqual(stagesByShot, [["storyboard_start", "storyboard_end"], ["storyboard_end"], ["storyboard_start", "storyboard_end"]]);
    } else if (mode === "smart") {
      assert.deepEqual(stagesByShot, [["storyboard_start", "storyboard_end"], ["storyboard_end"], ["storyboard_start", "storyboard_end"]]);
    } else {
      assert.deepEqual(stagesByShot, project.shots.map(() => ["storyboard_sheet"]));
    }

    if (mode !== "production_package") {
      const characterStage = mode === "asset_direct" ? "character_intro" : "character_sheet";
      const characterPrompt = workflow.compileImagePrompt(project, config, characterStage, project.characters[0]);
      assert.match(characterPrompt, /同一|唯一/u);
      assert.match(characterPrompt, /额外人物|多余人物|禁止.*人物/u);
      assert.match(characterPrompt, /文字|水印/u);

      const scenePrompt = workflow.compileImagePrompt(project, config, "scene_asset", project.scenes[0]);
      assert.match(scenePrompt, /16:9/u);
      assert.match(scenePrompt, /2[×x]2/u);
      assert.match(scenePrompt, /主轴.{0,8}正向/u);
      assert.match(scenePrompt, /同轴反向|反向轴/u);
      assert.match(scenePrompt, /左侧45度/u);
      assert.match(scenePrompt, /右侧45度/u);
      assert.match(scenePrompt, /无人/u);
      assert.match(scenePrompt, /同一.*拓扑.*光/u);

      const propPrompt = workflow.compileImagePrompt(project, config, "prop_asset", project.assetLibraries.props[0]);
      assert.match(propPrompt, /单个道具|只生成/u);
      assert.match(propPrompt, /人物|文字|水印/u);
    }

    for (const shotItem of project.shots) {
      for (const stage of resolveShotVideoStrategy(project, shotItem).frameStages) {
        const imagePrompt = workflow.compileImagePrompt(project, config, stage, shotItem);
        if (stage === "storyboard_start") {
          assert.match(imagePrompt, /本张首帧强制状态/u);
          assert.match(imagePrompt, /动作.*前|起始/u);
          assert.match(imagePrompt, /一张严格 9:16/u);
          assert.match(imagePrompt, /禁止.*拼图/u);
        } else if (stage === "storyboard_end") {
          assert.match(imagePrompt, /本张尾帧强制状态/u);
          assert.match(imagePrompt, /尾帧必须不同于首帧/u);
          assert.match(imagePrompt, /一张严格 9:16/u);
          assert.match(imagePrompt, /禁止复刻首帧/u);
        } else {
          assert.match(imagePrompt, /分镜接触印|逐秒分镜合图/u);
          assert.match(imagePrompt, /共12格/u);
          assert.match(imagePrompt, /每个独立小格必须严格为完整9:16构图/u);
          assert.match(imagePrompt, /从左到右、从上到下/u);
          assert.match(imagePrompt, /字幕、气泡、标题、Logo、水印、UI/u);
          assert.match(imagePrompt, /cameraOwnerId=/u);
          assert.match(imagePrompt, /mouthOwnerId=/u);
        }
      }
    }
    assert.deepEqual(calls, { text: 0, fetch: 0, bridge: 0, media: 0 });
  });

  test(`${mode}: final H3 prompts meet the dialogue-first skill contract without upstream calls`, () => {
    const { calls } = createOfflineWorkflow();
    const project = projectFor(mode);
    for (const shotItem of project.shots) {
      const refs = promptReviewReferencePlan(project, shotItem, mode, "image_only");
      assert.equal(refs.audios.length, 0);
      assert.equal(refs.videoAudios.length, 0);
      const prompt = renderApprovedVideoPrompt(project, shotItem, refs);
      const reviewZh = renderApprovedVideoPromptChinese(project, shotItem, refs);
      assert.equal(assertHailuoFinalPromptIntegrity(prompt), true);
      assert.equal(containsCjkOutsideDialogue(prompt), false);
      assert.ok(prompt.includes(EXPECTED_FINAL_LOCK));
      assert.doesNotMatch(prompt, /<Audio\s+\d+>/iu);
      assert.match(reviewZh, /不传参考音频/u);

      for (const turn of shotItem.dialogueTurns) {
        assert.equal(prompt.split(turn.text).length - 1, 1, `${mode}:${shotItem.id}:${turn.sourceDialogueId}`);
      }
      const windows = dialogueWindows(prompt);
      assert.equal(windows.length, shotItem.dialogueTurns.length);
      windows.forEach((window, index) => {
        assert.ok(Number.isFinite(window.start) && Number.isFinite(window.end));
        assert.ok(window.end > window.start);
        assert.ok(window.end - window.start + 0.051 >= requiredDialogueSeconds(shotItem.dialogueTurns[index].text));
        const effectiveCharacters = (shotItem.dialogueTurns[index].text.match(/[\u3400-\u9fffA-Za-z0-9]/gu) || []).length;
        const maximumWindow = effectiveCharacters / 5 + 0.051;
        assert.ok(window.end - window.start <= maximumWindow, "dialogue window must not slow below five characters per second");
        if (index > 0) assert.ok(window.start >= windows[index - 1].end - 0.001);
        const positions = [
          window.line.indexOf("<d>[Chinese]"),
          window.line.indexOf("delivery is"),
          window.line.indexOf("vocal arc is"),
          window.line.indexOf("facial arc is"),
          window.line.indexOf("body action is"),
          window.line.indexOf("blocking is")
        ];
        assert.ok(positions.every(position => position >= 0));
        assert.ok(positions.every((position, order) => order === 0 || position > positions[order - 1]));
        assert.doesNotMatch(window.line, /DIALOGUE\s+PRIORITY|TONE\s+PRIORITY|EMOTION\s+PRIORITY|ACTION\s+PRIORITY|BLOCKING\s+PRIORITY/i);
      });
      assert.ok(windows[0].start >= 0.25, "clean closed-mouth onset must precede the first syllable");
      assert.ok(windows.at(-1).end <= shotItem.duration - 0.35 + 0.051, "a closed-mouth tail must remain");

      assert.match(prompt, /low chest register, controlled volume/i);
      assert.doesNotMatch(prompt, /\b(?:stress|pause|after|on|and)\s*[.,;](?:\s|$)/iu);
      assert.match(prompt, /wet eyes stay fixed on the listener/i);
      assert.match(prompt, /push it six centimeters toward the listener/i);
      assert.match(prompt, /screen-left in the foreground/i);
      assert.match(prompt, /three-quarter face toward|face <Subject \d+> in readable three-quarter view/i);
      assert.match(prompt, /keeps resting lips, swallows once/i);
      assert.match(prompt, /hard cut on each speaker change|switch camera ownership and speaking-mouth ownership together with a direct hard cut|cut to <Subject \d+>'s established visible speaking face without changing that person's identity/i);
      assert.match(prompt, /no lip smack, tongue click, throat clear, inhale vocalization, false start/i);
      assert.match(prompt, /no overlap, improvised word, background vocal sound or decorative noise/i);
      assert.match(prompt, /one unique physical instance/i);
      assert.match(prompt, /may enter only through an authored doorway or frame edge/i);
      assert.match(prompt, /physically holds the single exact referenced product/i);
      assert.match(prompt, /same hand-held package and returns to the same holder/i);
      assert.doesNotMatch(stripDialogue(prompt), /[\u3400-\u9fff]/u);
      assert.doesNotMatch(stripDialogue(prompt), /\b(?:subtitle|caption|on-screen text|crowd chatter|crowd voices|background speech|murmur|laughter|giggling)\b/iu);

      const roleTypes = refs.imageRoles.map(item => item.type);
      if (mode === "production_package") {
        assert.equal(refs.importedReferenceOrderLocked, true);
        assert.equal(refs.hailuoApiMode, "reference_to_video");
        assert.deepEqual(roleTypes, ["scene", "character", "character", "product", "prop"]);
        assert.equal(refs.videos.length, 0);
      } else if (mode === "asset_direct") {
        assert.ok(!roleTypes.some(type => type.startsWith("storyboard_")));
        assert.equal(refs.hailuoApiMode, "reference_to_video");
        assert.equal(refs.videos.length, 0);
      } else if (mode === "storyboard_sheet") {
        assert.equal(roleTypes[0], "storyboard_sheet");
        assert.match(prompt, /ordered narrative frame|ordered temporal plan/i);
      } else if (mode === "keyframe" || shotItem.number === 1 || (["smart", "continuation"].includes(mode) && shotItem.number === 3)) {
        assert.deepEqual(roleTypes.slice(0, 2), ["storyboard_start", "storyboard_end"]);
        assert.equal(refs.videos.length, 0);
      } else {
        assert.equal(roleTypes[0], "storyboard_end");
        assert.equal(refs.videos.length, 1);
        assert.equal(refs.videoRoles[0].type, "previous_shot");
        assert.match(prompt, /final physical and acoustic state of <Video 1>|exact final temporal state|prior confirmed video|prior final state|previous video/i);
      }

      const runtimeLock = matrixRuntimeVideoPromptForProject(project, settings(), mode);
      assert.match(runtimeLock, /complete Chinese dialogue lines assigned by the validated speech and action windows/i);
      assert.match(runtimeLock, /three passed gates/i);
      assert.match(runtimeLock, /no lip smack/i);
    }
    assert.deepEqual(calls, { text: 0, fetch: 0, bridge: 0, media: 0 });
  });
}
