"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HAILUO_BLOCK_PROMPT_LIMIT,
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  cameraTakeCompilerMessages,
  filterReferencesForGenerationBlock,
  generationBlockShotForValidation,
  generationBlockTakes
} = require("../app/agent-director");
const { buildApprovedHailuoPrompt, deterministicEnglishCue, dialogueTimingPlan } = require("../app/hailuo-h3-natural-prompt");
const { effectiveChineseCharacters } = require("../app/drama-timing");

const project = {
  generation: { engine: "hailuo-h3", mode: "storyboard_sheet", aspectRatio: "9:16" },
  characters: [{ id: "C01", name: "陈默" }, { id: "C02", name: "陈建国" }]
};

function references() {
  return {
    hailuoApiMode: "multimodal_to_video",
    images: ["sheet.png", "scene.png", "c01.png", "c02.png"],
    imageRoles: [
      { type: "storyboard_generation_block_sheet" },
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [{ characterId: "C01" }, { characterId: "C02" }]
  };
}

function chineseBlueprintOffShot() {
  return {
    id: "S01",
    number: 1,
    duration: 8,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    action: "陈建国从床边失衡坠下，陈默瞬间扑过去垫在父亲身下并伸手拦挡。",
    stateBefore: "陈建国在床边失衡，陈默离床一步距离。",
    stateAfter: "陈默垫在地上托住陈建国，两人停在紧绷对视。",
    subshots: [
      {
        start: 0,
        end: 2,
        action: "陈默见陈建国坠床，瞬间跨步扑过去垫人，同时厉声喝止。",
        framing: "C01单人近景，带床边失稳前景",
        camera: "机位略低，随扑出短促前跟",
        sound: "老卧室底噪+床板晃动+扑地闷响+衣料摩擦",
        visibleCharacterIds: ["C01", "C02"],
        dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], sourceTone: "压着怒气，厉声喝止", text: "住手！有话冲我来！", metadata: { body: "伸手拦挡前方", listenerBeat: "父亲盯住他" } }]
      },
      {
        start: 2,
        end: 5,
        action: "陈建国被陈默托住，缓过一口气后盯着儿子。",
        framing: "C02中近景反打",
        camera: "固定反打机位，保持180度轴线",
        sound: "连续底噪+粗重呼吸+布料轻蹭",
        visibleCharacterIds: ["C01", "C02"],
        dialogueTurns: [{ speakerId: "C02", listenerIds: ["C01"], sourceTone: "压低声音，结尾放慢", text: "先把人放开，这次别再回避。", metadata: { body: "缓过一口气后盯住儿子", listenerBeat: "儿子收紧手臂" } }]
      },
      {
        start: 5,
        end: 8,
        action: "陈默收紧手臂把人托稳，两人紧绷对视。",
        framing: "双人近距离压迫构图",
        camera: "固定后轻推近",
        sound: "连续底噪+急促呼吸+手掌按衣料声",
        visibleCharacterIds: ["C01", "C02"]
      }
    ]
  };
}

function outsideDialogue(prompt) {
  return String(prompt).replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, "");
}

test("Director En schema requests faithful English translations of every locked physical field", () => {
  const shot = chineseBlueprintOffShot();
  const plan = buildCameraTakePlan(project, shot);
  const messages = cameraTakeCompilerMessages(project, shot, plan);
  const system = messages[0].content;
  const input = JSON.parse(messages[1].content);

  assert.match(system, /所有以 En 结尾[^。]*英文/);
  assert.match(system, /逐个 locked take 忠实翻译并落实其 action、framing、camera、sound/);
  assert.match(system, /stateBeforeEn\/stateAfterEn 必须忠实翻译/);
  assert.match(system, /不得改写、补写或删减剧情/);
  assert.doesNotMatch(system, /创意字段用中文|不要写英文/);
  assert.equal(input.shot.stateBefore, shot.stateBefore);
  assert.equal(input.shot.stateAfter, shot.stateAfter);
  assert.equal(input.lockedTakes[0].action, shot.subshots[0].action);
  assert.equal(input.lockedTakes[0].framing, shot.subshots[0].framing);
  assert.equal(input.lockedTakes[0].camera, shot.subshots[0].camera);
  assert.equal(input.lockedTakes[0].sound, shot.subshots[0].sound);
});

test("blueprint-off deterministic Agent prompt retains concrete action, camera and endpoint states in English", () => {
  const shot = chineseBlueprintOffShot();
  const plan = buildCameraTakePlan(project, shot);
  const prompts = plan.generationBlocks.map(sourceBlock => {
    const block = { ...sourceBlock, takes: generationBlockTakes(plan, sourceBlock) };
    const boundReferences = filterReferencesForGenerationBlock(references(), block, { blockCount: plan.generationBlocks.length });
    return buildHailuoGenerationBlockPrompt(project, generationBlockShotForValidation(shot, block), block, boundReferences);
  });
  const prompt = prompts.join("\n\n");
  const silent = outsideDialogue(prompt);

  // One authored shot stays one paid H3 block when it fits the provider's
  // duration budget; camera changes remain internal takes instead of becoming
  // three separately billed fragments.
  assert.equal(plan.generationBlocks.length, 1);
  // The two-line Agent payload reserves enough room for complete causal action,
  // state, performance and dialogue semantics. It is still advisory and never
  // truncates an otherwise valid provider prompt.
  assert.equal(prompts.every(item => item.length > 0), true);
  assert.equal(HAILUO_BLOCK_PROMPT_LIMIT, 8000);
  assert.match(silent, /loses balance and drops|lunges forward/i);
  assert.match(silent, /catches and supports|supported and stable/i);
  assert.match(silent, /their eyelines lock|tense locked eyeline/i);
  assert.deepEqual(plan.generationBlocks[0].speakerIds.slice().sort(), ["C01", "C02"]);
  assert.deepEqual(plan.generationBlocks[0].mouthOwnerIds.slice().sort(), ["C01", "C02"]);
  assert.deepEqual(plan.generationBlocks[0].cameraOwnerIds.slice().sort(), ["C01", "C02"]);
  assert.match(silent, /arm[^.]{0,80}(?:block|reaches)|(?:block|reaches)[^.]{0,80}arm/i);
  assert.match(silent, /hard cut on each speaker change|preserve the 180-degree eyeline axis/i);
  assert.match(silent, /one step away|opening pose and prop state/i);
  assert.match(silent, /supported and stable|authored completed state/i);
  assert.match(silent, /continuous room tone/i);
  assert.doesNotMatch(silent, /\b(?:vis|reactio|to the a)(?:[.;]|$)/i);
  assert.doesNotMatch(silent, /\bthen\s+then\b/i);
  assert.doesNotMatch(silent, /subtitle|caption|on-screen\s+text|screen\s+text/i);
  assert.doesNotMatch(silent, /\bthen\s+then\b/i);
  assert.equal((prompt.match(/<d>\[Chinese\]/g) || []).length, 2);
  assert.equal((prompt.match(/vocal arc is/gi) || []).length, 2);
  assert.equal((prompt.match(/moves the lips for this line/gi) || []).length, 2);
  assert.equal((prompt.match(/remains closed-lipped/gi) || []).length >= 2, true);
  assert.doesNotMatch(silent, /[\u3400-\u9fff]/);
});

test("blueprint-off path preserves arbitrary AI-compiled production fields without generic replacement", () => {
  const shot = {
    id: "S09",
    duration: 6,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    action: "快递员展开折叠星砂机关，沿三角轨迹扣入银色凹槽。",
    actionEn: "The courier unfolds the star-sand mechanism and locks it into the silver triangular groove; then the courier rotates the cobalt safety lever downward.",
    stateBefore: "折叠机关停在快递员左掌心。",
    stateBeforeEn: "The folded mechanism rests inside the courier's left palm.",
    stateAfter: "展开的机关与银色凹槽严丝合缝锁定。",
    stateAfterEn: "The open mechanism is locked flush inside the silver groove.",
    subshots: [{
      start: 0,
      end: 6,
      actionZh: "快递员展开折叠星砂机关，扣入银色凹槽，再将钴蓝色安全杆向下旋转到位。",
      actionEn: "The courier unfolds the star-sand mechanism and locks it into the silver groove.",
      framingZh: "手部与面部紧凑双人构图。",
      framingEn: "Tight hand-and-face two-shot.",
      cameraZh: "短距离横移后稳定落到机关细节特写。",
      cameraEn: "A short lateral track ends in a stable detail close-up.",
      soundZh: "持续工坊底噪，三次金属卡扣声与动作同步。",
      soundEn: "Continuous workshop hum with three synchronized metal clicks.",
      visibleCharacterIds: ["C01", "C02"],
      dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], sourceTone: "quiet confidence with one firm stress", text: "机关已经扣稳了。", metadata: { body: "hands stop on the final click", listenerBeat: "listener leans closer with closed lips" } }]
    }]
  };
  const plan = buildCameraTakePlan(project, shot);
  const block = { ...plan.generationBlocks[0], takes: generationBlockTakes(plan, plan.generationBlocks[0]) };
  const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, filterReferencesForGenerationBlock(references(), block, { blockCount: 1 }));
  const silent = outsideDialogue(prompt);

  assert.match(silent, /courier unfolds the star-sand mechanism/i);
  assert.match(silent, /short lateral track ends in a stable detail close-up/i);
  assert.match(silent, /folded mechanism rests inside the courier's left palm/i);
  assert.match(silent, /open mechanism is locked flush inside the silver groove/i);
  assert.equal((silent.match(/rotates the cobalt safety lever downward/gi) || []).length >= 1, true);
  assert.match(silent, /Continuous workshop hum with three synchronized metal clicks/i);
  assert.doesNotMatch(silent, /[\u3400-\u9fff]/);
});

test("Simple two-person dialogue derives hard shot-reverse-shot cuts without providerCameraEn", () => {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: {
      id: "S02",
      duration: 8,
      characterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      action: "女儿把密封档案袋沿桌面推到父亲面前。",
      actionEn: "The daughter slides the sealed envelope across the table toward her father.",
      stateBefore: "密封档案袋放在女儿右手边。",
      stateBeforeEn: "The sealed envelope rests beside the daughter's right hand.",
      stateAfter: "密封档案袋停在父亲正前方。",
      stateAfterEn: "The sealed envelope stops directly in front of her father."
    },
    references: references(),
    dialogueTurns: [
      { speakerId: "C01", listenerIds: ["C02"], sourceTone: "firm, clipped breath and hard stress", text: "这份证据，你先看完。", metadata: { body: "clear hand action", listenerBeat: "silent recoil" } },
      { speakerId: "C02", listenerIds: ["C01"], sourceTone: "low voice, slower ending", text: "原来你早就知道了。", metadata: { body: "gaze drops to the envelope", listenerBeat: "still lips and fixed gaze" } }
    ]
  });
  const silent = outsideDialogue(prompt);

  assert.match(silent, /direct hard cut|HARD CUT/i);
  assert.match(silent, /daughter slides the sealed envelope across the table toward her father/i);
  assert.match(silent, /sealed envelope rests beside the daughter's right hand/i);
  assert.match(silent, /sealed envelope stops directly in front of her father/i);
  assert.doesNotMatch(silent, /subtitle|caption|on-screen\s+text|screen\s+text/i);
  assert.doesNotMatch(silent, /[\u3400-\u9fff]/);
});

test("English cue clipping ends on complete words and clauses", () => {
  const camera = deterministicEnglishCue("Each speaker change creates a motivated eyeline cut to the active speaker while the listener remains visibly reactive.", "camera", "", 58);
  const reaction = deterministicEnglishCue("still lips, brief frozen reaction, visible recoil and locked gaze", "action", "", 31);
  assert.doesNotMatch(camera, /\b(?:a|an|and|at|by|for|from|in|into|of|on|or|the|to|with)$/i);
  assert.doesNotMatch(`${camera}. ${reaction}.`, /\b(?:vis|reactio|to the a)\./i);
});

test("ordinary photo placement never mutates into a wearable product action", () => {
  const cue = deterministicEnglishCue("苏梅把旧合照贴在掌心，随后捡起照片。", "action", "advance the authored evidence action", 180);
  assert.match(cue, /hand lifts the authored object|advance the authored evidence action/);
  assert.doesNotMatch(cue, /referenced (?:product|wearable)|fit and secure/);
});

test("asset-direct provider cues use bound subjects, explicit wardrobe ownership and realistic sachet scale", () => {
  const prompt = buildApprovedHailuoPrompt({
    project: { ...project, generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" } },
    shot: {
      id: "S09",
      duration: 13,
      characterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      action: "C01换上W01，C02替C01理平衣领；P02留在C01手袋内，C01把P01和一袋商品小袋装入手袋。",
      actionEn: "C01 changes into W01; C02 straightens its collar; P02 stays in C01's handbag while C01 packs P01 and one product sachet into it.",
      stateBefore: "P01在镜旁，P02在C01手袋内，一袋商品小袋在洗手台上。",
      stateBeforeEn: "P01 rests by the mirror, P02 is inside C01's handbag, and one product sachet rests on the washbasin.",
      stateAfter: "P01、P02和一袋商品小袋都已稳妥装入C01手袋。",
      stateAfterEn: "P01, P02 and one product sachet are secured inside C01's handbag."
    },
    references: {
      images: ["scene.png", "c01.png", "c02.png", "product.png", "wardrobe.png", "p01.png", "p02.png"],
      imageRoles: [
        { type: "scene", entityId: "SC02" },
        { type: "character", entityId: "C01" },
        { type: "character", entityId: "C02" },
        { type: "product", entityId: "product" },
        { type: "wardrobe", entityId: "W01", characterId: "C01" },
        { type: "prop", entityId: "P01" },
        { type: "prop", entityId: "P02" }
      ],
      audios: [{ characterId: "C01" }, { characterId: "C02" }],
      promptMode: "asset_direct"
    },
    dialogueTurns: [
      { speakerId: "C01", listenerIds: ["C02"], text: "明天我去拿回自己的座位。", deliveryEn: "calm and resolute", bodyEn: "C01 packs P01 and one product sachet into the handbag." },
      { speakerId: "C02", listenerIds: ["C01"], text: "我陪你一起。", deliveryEn: "warm and certain", bodyEn: "C02 straightens its collar." }
    ]
  });
  assert.match(prompt, /<Subject 1>[\s\S]*identity[\s\S]*<Picture 2>/i);
  assert.match(prompt, /<Subject 1>[\s\S]*wardrobe[\s\S]*<Picture 5>/i);
  assert.match(prompt, /<Subject 4>[\s\S]{0,120}product[\s\S]{0,160}<Picture 4>/i);
  assert.match(prompt, /holder, hand, support, and physical state follow the authored action timeline/);
  assert.doesNotMatch(prompt, /handling remain stable/);
  assert.match(prompt, /<Subject 5>[\s\S]{0,120}P01[\s\S]{0,160}<Picture 6>/i);
  assert.match(prompt, /<Subject 6>[\s\S]{0,120}P02[\s\S]{0,160}<Picture 7>/i);
  assert.match(prompt, /<Subject 1> already wearing the exact complete wardrobe shown in <Picture 5>[\s\S]*<Subject 2> straightens <Subject 1>'s collar/i);
  assert.match(prompt, /<Subject 5>, <Subject 6> and one individual hand-sized flat sachet of <Subject 4> are secured inside <Subject 1>'s handbag/i);
  assert.doesNotMatch(outsideDialogue(prompt), /[\u3400-\u9fff]/);
});

test("two-person treatment binds the patient body parts and repeats camera-mouth ownership", () => {
  const prompt = buildApprovedHailuoPrompt({
    project: { ...project, generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" } },
    shot: {
      id: "S07",
      duration: 11,
      characterIds: ["C02", "C01"],
      visibleCharacterIds: ["C02", "C01"],
      action: "C02打开一袋商品小袋打出泡沫，从C01两侧鬓角向发根揉匀，C01坐着接受护理。",
      actionEn: "C02 opens one product sachet, makes foam, and massages it from both temples toward the roots while C01 receives the treatment.",
      stateBefore: "C01面向镜子坐好，C02站在她身后拿着未开封小袋。",
      stateBeforeEn: "C01 sits facing the mirror while C02 stands behind her with the unopened sachet.",
      stateAfter: "细腻泡沫均匀覆盖C01鬓角发根，C02自己的头发未处理。",
      stateAfterEn: "Fine foam evenly covers C01's temple roots while C02's own hair remains untreated."
    },
    references: {
      images: ["scene.png", "c02.png", "c01.png", "product.png"],
      imageRoles: [
        { type: "scene", entityId: "SC02" },
        { type: "character", entityId: "C02" },
        { type: "character", entityId: "C01" },
        { type: "product", entityId: "product" }
      ],
      audios: [{ characterId: "C02" }, { characterId: "C01" }],
      promptMode: "asset_direct"
    },
    dialogueTurns: [
      { speakerId: "C02", listenerIds: ["C01"], text: "我从你的鬓角往发根揉匀。", deliveryEn: "clear and reassuring", bodyEn: "C02 massages the foam from both temples toward the roots." },
      { speakerId: "C01", listenerIds: ["C02"], text: "这样很舒服。", deliveryEn: "pleasantly surprised", bodyEn: "C01 smiles at C02 in the mirror." }
    ]
  });
  assert.match(prompt, /<Subject 1> opens one individual hand-sized flat sachet of <Subject 4>, makes foam, and massages it from both temples toward the roots while <Subject 2> receives the treatment/i);
  assert.match(prompt, /Fine foam evenly covers <Subject 2>'s temple roots while <Subject 1>'s own hair remains untreated/i);
  assert.match(prompt, /Only <Subject 1> \(S1\) moves the lips for this line/i);
  assert.match(prompt, /<Subject 2> remains closed-lipped/i);
  assert.match(prompt, /Only <Subject 2> \(S2\) moves the lips for this line/i);
  assert.match(prompt, /<Subject 1> remains closed-lipped/i);
  assert.match(prompt, /The treatment recipient is <Subject 2>[\s\S]*every named hair, temple, root, scalp, face, garment part, or body part in this action belongs to <Subject 2>/i);
  assert.doesNotMatch(outsideDialogue(prompt), /subtitle|caption|on-screen\s+text|screen\s+text/i);
  assert.doesNotMatch(outsideDialogue(prompt), /[\u3400-\u9fff]/);
});

test("editorial dialogue timing distributes free action time instead of creating a long dead tail", () => {
  // The old fixture demanded >=4.59 seconds for 18 characters, contradicting
  // the user's 5–6 characters/second contract. Use a substantive 30-character
  // acted line to test free-action allocation without requiring slow speech.
  const monologueTurns = [{
    text: "这些白发不是丢人，是我独自起早贪黑，辛辛苦苦把女儿养大成人的日子。",
    plannedSpeechSeconds: 4.35,
    plannedAfterBeatSeconds: 0.6
  }];
  const monologue = dialogueTimingPlan(monologueTurns, 10);
  assert.ok(monologue.slots[0].start >= 1.5 && monologue.slots[0].start <= 1.7);
  const monologueSeconds = monologue.slots[0].end - monologue.slots[0].start;
  const monologueCharacters = effectiveChineseCharacters(monologueTurns[0].text);
  assert.ok(monologueSeconds >= monologueCharacters / 6 - 0.0001, "an optimistic AI duration must not force delivery faster than 6 characters/second");
  assert.ok(monologueSeconds <= monologueCharacters / 5 + 0.1, "the speech window must not stretch a line slower than 5 characters/second, allowing one provider timestamp rounding tick");
  assert.ok(monologue.reactionTail <= 3.11);

  // Two seven-character placeholders cannot fill a 15-second exchange at the
  // required speed. Keep the bounded handoff/tail assertions and supply a real
  // causally connected 22/19-character exchange instead of relaxing the gates.
  const exchangeTurns = [
    { text: "这封信我保存了二十年，今天终于能够亲手交还给你。", plannedSpeechSeconds: 5, plannedAfterBeatSeconds: 0.6 },
    { text: "原来这些年，你一直没有忘记我们当年的约定。", plannedSpeechSeconds: 2.4, plannedAfterBeatSeconds: 0.6 }
  ];
  const exchange = dialogueTimingPlan(exchangeTurns, 15);
  assert.equal(exchange.slots.length, exchangeTurns.length, "every complete line keeps its own speech slot");
  exchange.slots.forEach((slot, index) => {
    const characters = effectiveChineseCharacters(exchangeTurns[index].text);
    assert.ok(slot.end - slot.start >= characters / 6 - 0.0001, "each complete reply must fit at the maximum ordinary speech rate");
    assert.ok(slot.end - slot.start <= characters / 5 + 0.1, "a short reply must not be stretched to fill the clip");
  });
  assert.ok(exchange.slots[0].start >= 1.4 && exchange.slots[0].start <= 1.6);
  assert.ok(exchange.slots[1].start >= exchange.slots[0].end + 0.6);
  assert.ok(exchange.slots[1].start - exchange.slots[0].end <= 3);
  assert.ok(exchange.reactionTail <= 2.6);
});

test("mirror monologue faces the mirror and keeps the silent tail physically active", () => {
  const prompt = buildApprovedHailuoPrompt({
    project: { ...project, generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" } },
    shot: {
      id: "S05",
      duration: 10,
      sceneName: "home bathroom mirror",
      characterIds: ["C01"],
      visibleCharacterIds: ["C01"],
      action: "C01走进浴室，把旧照片立在镜旁，轻触一侧鬓角的白发。",
      actionEn: "C01 enters, props an old photograph beside the mirror, and touches the gray hair at one temple.",
      stateBefore: "C01手持旧照片走进浴室。",
      stateBeforeEn: "C01 enters holding the photograph.",
      stateAfter: "旧照片立在镜旁，C01抬起下巴。",
      stateAfterEn: "The photograph rests beside the mirror while C01 raises her chin."
    },
    references: {
      images: ["scene.png", "c01.png"],
      imageRoles: [{ type: "scene", entityId: "SC02" }, { type: "character", entityId: "C01" }],
      audios: [{ characterId: "C01" }],
      promptMode: "asset_direct"
    },
    dialogueTurns: [{
      speakerId: "C01",
      text: "这些白发不是丢人，是我把女儿养大的日子。",
      plannedSpeechSeconds: 4.35,
      plannedAfterBeatSeconds: 0.6,
      deliveryEn: "warm private reflection that settles into firm dignity",
      expressionEn: "sad eyes steady and the jaw lifts",
      bodyEn: "C01 touches the gray hair at one temple",
      speakerFacingZh: "正面对着面前的镜子，镜中脸与真实人物保持同一身份"
    }]
  });
  assert.match(prompt, /faces the mirror directly in front of them/i);
  assert.match(prompt, /<d>\[Chinese\] 这些白发不是丢人，是我把女儿养大的日子。<\/d>/);
  assert.match(prompt, /Only <Subject 1> \(S1\) moves the lips for this line/i);
  // The words are unchanged. At the mandated ordinary speaking rate, the
  // actual speech slot ends at 5.3s rather than the obsolete slow 6.3s clock.
  const speechWindow = prompt.match(/From ([\d.]+) to ([\d.]+) seconds, <Subject 1> \(S1\) faces the mirror/);
  assert.ok(speechWindow, "the mirror-facing monologue must retain an explicit complete speech window");
  const spokenSeconds = Number(speechWindow[2]) - Number(speechWindow[1]);
  const characters = effectiveChineseCharacters("这些白发不是丢人，是我把女儿养大的日子。");
  assert.ok(spokenSeconds >= characters / 6 - 0.0001);
  assert.ok(spokenSeconds <= characters / 5 + 0.1);
  assert.ok(prompt.includes(`From ${Number(speechWindow[2]).toFixed(1)} to 10.0 seconds, no one speaks`), "physical action tail must start only after the complete spoken line");
  assert.equal((prompt.match(/<d>\[Chinese\] 这些白发不是丢人，是我把女儿养大的日子。<\/d>/g) || []).length, 1, "the exact monologue is emitted once, never repeated or truncated");
  assert.match(prompt, /remaining authored physical action and visible reaction continue into the exact final state/i);
  assert.doesNotMatch(prompt, /enters again|props the old photograph again/i);
  assert.doesNotMatch(outsideDialogue(prompt), /[\u3400-\u9fff]/);
});
