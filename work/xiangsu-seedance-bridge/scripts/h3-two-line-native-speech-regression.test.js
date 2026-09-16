"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK,
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  filterReferencesForGenerationBlock,
  generationBlockTakes,
  validateCameraTakePlan
} = require("../app/agent-director");
const { assertHailuoPromptVoiceBindings, renderApprovedVideoPrompt } = require("../app/workbench-workflow");

function writeVoiceWav(filePath) {
  const sampleRate = 8000;
  const sampleCount = 800;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index / 5) * 5000), 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
}

function projectFixture() {
  return {
    generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" },
    characters: [
      { id: "C01", name: "姐姐" },
      { id: "C02", name: "母亲" }
    ]
  };
}

function shotFixture(turns) {
  return {
    id: "S09",
    number: 9,
    duration: 12,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    sceneId: "SC01",
    actionEn: "The two women face each other across the dining table as the truth changes their relationship.",
    subshots: [{
      number: 1,
      start: 0,
      end: 12,
      framing: "alternating medium close-ups",
      camera: "one motivated direct reverse cut when the speaker changes",
      visibleCharacterIds: ["C01", "C02"],
      dialogueTurns: turns
    }]
  };
}

function referencesFixture() {
  return {
    images: ["character-c01-original.png", "character-c02-original.png", "scene-four-view-original.png"],
    imageRoles: [
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "scene", entityId: "SC01" }
    ],
    audios: [
      { characterId: "C01", path: "c01-timbre-sample.wav", recordedWords: "样本里的词不能进入本镜" },
      { characterId: "C02", path: "c02-timbre-sample.wav", recordedWords: "这也不是本镜对白" }
    ]
  };
}

function compileAll(project, shot, references) {
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  const compiled = plan.generationBlocks.map(source => {
    const block = { ...source, takes: generationBlockTakes(plan, source) };
    const scopedReferences = filterReferencesForGenerationBlock(references, block, {
      blockCount: plan.generationBlocks.length,
      multiBlock: plan.generationBlocks.length > 1
    });
    return {
      block,
      references: scopedReferences,
      prompt: buildHailuoGenerationBlockPrompt(project, shot, block, scopedReferences)
    };
  });
  return { plan, compiled };
}

test("same speaker may say two complete lines in one H3 provider task", () => {
  const project = projectFixture();
  const shot = shotFixture([
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "妈，你先坐下。", delivery: "gentle but urgent" },
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "这回让我护着你。", delivery: "voice firms with protective resolve" }
  ]);
  const { plan, compiled } = compileAll(project, shot, referencesFixture());
  assert.equal(HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK, 2);
  assert.equal(plan.generationBlocks.length, 1);
  assert.equal(plan.generationBlocks[0].dialogueLineCount, 2);
  assert.equal((compiled[0].prompt.match(/妈，你先坐下。/g) || []).length, 1);
  assert.equal((compiled[0].prompt.match(/这回让我护着你。/g) || []).length, 1);
  assert.match(compiled[0].prompt, /honor each authored camera beat/);
  assert.doesNotMatch(compiled[0].prompt,/55-70%/);
  assert.equal((compiled[0].prompt.match(/Only <Subject 1> \(S1\) moves the lips for this line/g) || []).length, 2);
});

test("two speakers may exchange one complete line each in one H3 provider task", () => {
  const project = projectFixture();
  const shot = shotFixture([
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "你为什么一直瞒着我？", delivery: "hurt accusation, rising pitch" },
    { speakerId: "C02", listenerIds: ["C01"], spokenText: "我怕拖累你。", delivery: "ashamed low voice, breath catches" }
  ]);
  const { plan, compiled } = compileAll(project, shot, referencesFixture());
  assert.equal(plan.generationBlocks.length, 1);
  assert.deepEqual(plan.generationBlocks[0].speakerIds, ["C01", "C02"]);
  assert.match(compiled[0].prompt, /switch camera ownership and speaking-mouth ownership together with a direct hard cut|cut to <Subject \d+>'s established visible speaking face without changing that person's identity|cut only to the next authored on-screen speaker's established face; identity never changes inside a face|direct hard cut to the next visible speaker; keep identities stable/);
  assert.match(compiled[0].prompt, /Only <Subject 2> \(S2\) moves the lips for this line/);
  assert.match(compiled[0].prompt, /<Subject 1> remains closed-lipped/);
});

test("provider compiler preserves authored English delivery, body and listener reaction", () => {
  const project = projectFixture();
  const shot = shotFixture([
    {
      speakerId: "C01",
      listenerIds: ["C02"],
      spokenText: "你别再碰她。",
      delivery: "压着哭腔，先低后高",
      deliveryEn: "A restrained sob hardens into a sharp protective command.",
      bodyActionEn: "C01 steps between C02 and the chair, one hand shaking but held out firmly.",
      listenerReactionEn: "C02 closes her lips, recoils half a step, and stares at C01 in disbelief."
    }
  ]);
  const { compiled } = compileAll(project, shot, referencesFixture());
  const prompt = compiled[0].prompt;
  assert.match(prompt, /A restrained sob hardens into a sharp protective command/);
  assert.match(prompt, /<Subject 1> steps between <Subject 2> and the chair/);
  assert.match(prompt, /<Subject 2> closes her lips, recoils half a step/);
  assert.match(prompt, /<Subject 2> remains closed-lipped/);
  assert.doesNotMatch(prompt, /Act the authored delivery|Continue the authored body action/i);
});

test("approved prompt voice audit follows actual subject/Picture bindings when C02 speaks first", t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "h3-subject-order-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const c01Voice = path.join(tempRoot, "c01.wav");
  const c02Voice = path.join(tempRoot, "c02.wav");
  writeVoiceWav(c01Voice);
  writeVoiceWav(c02Voice);
  const project = {
    ...projectFixture(),
    scenes: [{ id: "SC01", name: "客厅" }],
    product: { name: "七味堂植物泡泡染发膏", imagePath: "hair-dye.png" }
  };
  const shot = {
    ...shotFixture([
      { sourceDialogueId: "D001", speakerId: "C02", speaker: "母亲", listenerIds: ["C01"], text: "一把年纪还染什么头发？滚！", deliveryZh: "尖刻怒骂，重压“染什么头发”，句尾“滚”骤然下砸", deliveryEn: "furious sharp attack" },
      { sourceDialogueId: "D002", speakerId: "C01", speaker: "姐姐", listenerIds: ["C02"], text: "我花自己的钱，也要活得体面！", deliveryZh: "疼痛哭腔，重读“活得体面”，后半句坚定反击", deliveryEn: "tearful but firm" }
    ]),
    productMention: true,
    videoReferenceIncludeProduct: true,
    actionEn: "After the opening action, the exact green hair-dye box lands between the two women."
  };
  const references = {
    images: ["scene-four-view.png", "character-c01.png", "character-c02.png", "hair-dye.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "product", entityId: "product" }
    ],
    audios: [
      { characterId: "C02", characterName: "母亲", path: c02Voice, duration: 0.1, mediaProbeVerified: true },
      { characterId: "C01", characterName: "姐姐", path: c01Voice, duration: 0.1, mediaProbeVerified: true }
    ],
    hailuoApiMode: "multimodal_to_video"
  };
  const prompt = renderApprovedVideoPrompt(project, shot, references);
  assert.match(prompt, /<Subject 1> \(S1\)[^\n]*<Picture 3>/);
  assert.match(prompt, /<Subject 2> \(S2\)[^\n]*<Picture 2>/);
  assert.equal(assertHailuoPromptVoiceBindings(project, shot, references, prompt), true);
});

test("a third complete line starts the next task without truncation or duplication", () => {
  const project = projectFixture();
  const turns = [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "第一句完整保留。" },
    { speakerId: "C02", listenerIds: ["C01"], spokenText: "第二句完整回应。" },
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "第三句进入下一条任务。" }
  ];
  const shot = shotFixture(turns);
  const { plan, compiled } = compileAll(project, shot, referencesFixture());
  assert.deepEqual(plan.generationBlocks.map(item => item.dialogueLineCount), [2, 1]);
  assert.deepEqual(compiled.map(item => item.block.takes.flatMap(take => take.dialogueTurns.map(turn => turn.text))), [
    ["第一句完整保留。", "第二句完整回应。"],
    ["第三句进入下一条任务。"]
  ]);
  const joined = compiled.map(item => item.prompt).join("\n");
  for (const turn of turns) {
    assert.equal(joined.split(turn.spokenText).length - 1, 1, `${turn.spokenText} must appear exactly once`);
  }
});

test("provider prompt uses exact written dialogue, timbre-only audio and natural millisecond windows", () => {
  const project = projectFixture();
  const shot = shotFixture([
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "你看着我，把话说完。" },
    { speakerId: "C02", listenerIds: ["C01"], spokenText: "这些年，是我错了。" }
  ]);
  const { compiled } = compileAll(project, shot, referencesFixture());
  const prompt = compiled[0].prompt;
  assert.match(prompt, /<d>\[Chinese\] 你看着我，把话说完。<\/d>/);
  assert.match(prompt, /<d>\[Chinese\] 这些年，是我错了。<\/d>/);
  assert.match(prompt, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)/);
  assert.match(prompt, /<Audio 2> is the voice-timbre reference for <Subject 2> \(S2\)/);
  assert.doesNotMatch(prompt, /样本里的词不能进入本镜|这也不是本镜对白/);
  assert.match(prompt, /From 0\.3 to [\d.]+ seconds[^\n]*<d>\[Chinese\] 你看着我，把话说完。<\/d>/);
  assert.match(prompt, /no one speaks/);
  assert.doesNotMatch(prompt, /END@|plannedSpeechSeconds|plannedAfterBeatSeconds/i);
  assert.match(prompt, /characters?\s*per\s*second/i, "current authored pace must remain executable, not be removed with internal bookkeeping");
  assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
});

test("missing optional voice uses character images plus exact text without generating dialogue audio", () => {
  const project = projectFixture();
  const shot = shotFixture([
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "这句话直接让人物图里的姐姐说。", delivery: "clear protective resolve" },
    { speakerId: "C02", listenerIds: ["C01"], spokenText: "我听明白了。", delivery: "soft relieved response" }
  ]);
  const references = { ...referencesFixture(), audios: [] };
  const { compiled } = compileAll(project, shot, references);
  const prompt = compiled[0].prompt;
  assert.doesNotMatch(prompt, /<Audio\s+\d+>/);
  assert.match(prompt, /Generate a character-consistent native voice for each exact once-only Chinese dialogue line/);
  assert.match(prompt, /<d>\[Chinese\] 这句话直接让人物图里的姐姐说。<\/d>/);
  assert.match(prompt, /<d>\[Chinese\] 我听明白了。<\/d>/);
  assert.equal(compiled[0].references.images.includes("character-c01-original.png"), true);
  assert.equal(compiled[0].references.images.includes("character-c02-original.png"), true);
  assert.equal(assertHailuoPromptVoiceBindings(project, shot, { ...compiled[0].references, hailuoApiMode: "image_to_video" }, prompt), true);
});

test("scene four-view reference remains the original whole file and cannot enter crop fallback", () => {
  const project = projectFixture();
  const shot = shotFixture([
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "这就是原来的客厅。" }
  ]);
  const references = referencesFixture();
  const { compiled } = compileAll(project, shot, references);
  const scoped = compiled[0].references;
  const sceneIndex = scoped.imageRoles.findIndex(role => role.type === "scene");
  assert.ok(sceneIndex >= 0);
  assert.equal(scoped.images[sceneIndex], "scene-four-view-original.png");
  assert.deepEqual(scoped.imageRoles[sceneIndex], references.imageRoles[2]);
  assert.match(compiled[0].prompt, /location SC01[^\n]+<Picture 3>/);
  assert.match(compiled[0].prompt, /fixed architecture, furniture, geometry and scale remain stable/);
  assert.match(compiled[0].prompt, /current authored time, lighting, object states and camera beats take precedence/);

  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(workflowSource, /const needsCrop = hasStoryboardSheet;/);
  assert.match(workflowSource, /if \(hasStoryboardSheet && !blockPanelReferences\.length && needsCrop\)/);
  assert.doesNotMatch(workflowSource, /const needsCrop = hasStoryboardSheet \|\|/);
});

test("actual-shot ASR is an explicit local audit helper and never revives retired final-film scripts", () => {
  const root = path.join(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(packageJson.build.files, ["app/**/*", "!app/**/__pycache__/**", "!app/assets/builtin-sfx/**/*", "!app/renderer/index.html", "package.json"]);
  const helper=fs.readFileSync(path.join(root,'app/local-media-asr.py'),'utf8');
  assert.match(helper,/local_files_only=True/);assert.match(helper,/word_timestamps=True/);assert.doesNotMatch(helper,/initial_prompt\s*=/);
  for (const retired of ["analyze-hailuo-ab.py", "h3-five-minute-video-qa.py", "transcribe-e2e-audio.py"]) {
    assert.equal(fs.existsSync(path.join(root, "scripts", retired)), false, `${retired} must stay removed`);
  }
  const appFiles = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (/\.(?:js|json|html)$/i.test(entry.name)) appFiles.push(fullPath);
    }
  };
  visit(path.join(root, "app"));
  const runtimeSource = appFiles.map(file => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(runtimeSource, /openai[-_ ]?whisper|faster[-_ ]?whisper|whisper\.cpp|speech_recognition|transcribe(?:Audio|Video|FinalFilm)|final[-_ ]film[-_ ]asr/i);
});
