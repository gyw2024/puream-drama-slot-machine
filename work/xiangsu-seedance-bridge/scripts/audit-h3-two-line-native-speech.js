"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  AGENT_DIRECTOR_VERSION,
  HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK,
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  filterReferencesForGenerationBlock,
  generationBlockTakes,
  validateCameraTakePlan
} = require("../app/agent-director");

const root = path.join(__dirname, "..");
const outputDirectory = path.resolve(process.argv[2] || path.join(root, ".codex_tests", "h3-two-line-native-speech"));
const timingPattern = /final word by|\bFrom\s+\d+(?:\.\d+)?s|\bAt\s+\d+(?:\.\d+)?\s*seconds?|END@|plannedSpeechSeconds|plannedAfterBeatSeconds|characters?\s*per\s*second/i;

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
      { characterId: "C01", path: "c01-timbre-sample.wav", recordedWords: "样本词不得进入本镜" },
      { characterId: "C02", path: "c02-timbre-sample.wav", recordedWords: "另一段样本词也不得进入本镜" }
    ]
  };
}

function compileCase(name, turns, options = {}) {
  const project = projectFixture();
  const shot = shotFixture(turns);
  const references = referencesFixture();
  if (options.withAudios === false) references.audios = [];
  const plan = buildCameraTakePlan(project, shot);
  const validPlan = validateCameraTakePlan(plan, project, shot);
  const blocks = plan.generationBlocks.map(source => {
    const block = { ...source, takes: generationBlockTakes(plan, source) };
    const scopedReferences = filterReferencesForGenerationBlock(references, block, {
      blockCount: plan.generationBlocks.length,
      multiBlock: plan.generationBlocks.length > 1
    });
    const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, scopedReferences);
    const sceneIndex = scopedReferences.imageRoles.findIndex(role => role.type === "scene");
    const dialogue = block.takes.flatMap(take => take.dialogueTurns.map(turn => turn.text));
    return {
      id: block.id,
      dialogueLineCount: block.dialogueLineCount,
      dialogue,
      prompt,
      promptLength: prompt.length,
      exactDialogueOccurrenceCounts: Object.fromEntries(dialogue.map(text => [text, prompt.split(text).length - 1])),
      hasPerLineTimingFormula: timingPattern.test(prompt),
      saysAudioIsTimbreOnly: /timbre reference only/i.test(prompt) && /ignore its recorded words/i.test(prompt),
      usesNativeVoiceFromCharacterWhenAudioMissing: !scopedReferences.audios.length
        && /Generate the voice natively for this locked character from the exact dialogue tag/i.test(prompt),
      leaksRecordedAudioWords: /样本词不得进入本镜|另一段样本词也不得进入本镜/.test(prompt),
      sceneReference: sceneIndex >= 0 ? scopedReferences.images[sceneIndex] : "",
      sceneReferenceRole: sceneIndex >= 0 ? scopedReferences.imageRoles[sceneIndex] : null,
      saysSceneIsFullUnchanged: /full unchanged four-view location reference/i.test(prompt) && /without cropping/i.test(prompt)
    };
  });
  return { name, validPlan, blockCounts: blocks.map(block => block.dialogueLineCount), blocks };
}

function runFullTestSuite() {
  const testFiles = fs.readdirSync(__dirname)
    .filter(name => name.endsWith(".test.js"))
    .sort()
    .map(name => path.join(__dirname, name));
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const metric = key => Number(combined.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] || 0);
  return {
    exitCode: result.status,
    tests: metric("tests"),
    passed: metric("pass"),
    failed: metric("fail"),
    failingLines: combined.split(/\r?\n/).filter(line => /^not ok /.test(line)).slice(0, 20)
  };
}

const cases = [
  compileCase("same-speaker-two-lines", [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "妈，你先坐下。", delivery: "gentle but urgent" },
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "这回让我护着你。", delivery: "voice firms with protective resolve" }
  ]),
  compileCase("two-speaker-exchange", [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "你为什么一直瞒着我？", delivery: "hurt accusation, rising pitch" },
    { speakerId: "C02", listenerIds: ["C01"], spokenText: "我怕拖累你。", delivery: "ashamed low voice, breath catches" }
  ]),
  compileCase("third-line-starts-next-task", [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "第一句完整保留。" },
    { speakerId: "C02", listenerIds: ["C01"], spokenText: "第二句完整回应。" },
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "第三句进入下一条任务。" }
  ]),
  compileCase("no-voice-file-native-character-speech", [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "没有音色文件也直接按这句说。" },
    { speakerId: "C02", listenerIds: ["C01"], spokenText: "人物图和台词已经足够。" }
  ], { withAudios: false })
];

const runtimeSource = fs.readdirSync(path.join(root, "app"), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:js|json|html)$/i.test(entry.name))
  .map(entry => fs.readFileSync(path.join(entry.parentPath || entry.path, entry.name), "utf8"))
  .join("\n");
const asrRuntimePattern = /openai[-_ ]?whisper|faster[-_ ]?whisper|whisper\.cpp|speech_recognition|transcribe(?:Audio|Video|FinalFilm)|final[-_ ]film[-_ ]asr/i;
const fullSuite = runFullTestSuite();
const allBlocks = cases.flatMap(item => item.blocks);
const audit = {
  taskId: "TASK-20260829-DRAMA-H3-TWO-LINE-NATIVE-SPEECH-001",
  generatedAt: new Date().toISOString(),
  agentDirectorVersion: AGENT_DIRECTOR_VERSION,
  paidSubmissions: 0,
  fullSuite,
  contract: {
    maxDialogueLinesPerProviderTask: HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK,
    currentDialogueAudioPreGenerated: false,
    existingAudioPurpose: "optional identity/timbre reference only",
    sceneFourViewTransport: "one full unchanged original file",
    finalFilmAsrEnabled: false
  },
  cases,
  assertions: {
    allPlansValid: cases.every(item => item.validPlan),
    noBlockExceedsTwoLines: allBlocks.every(block => block.dialogueLineCount <= 2),
    everyDialogueAppearsExactlyOnce: allBlocks.every(block => Object.values(block.exactDialogueOccurrenceCounts).every(count => count === 1)),
    noPerLineTimingFormula: allBlocks.every(block => !block.hasPerLineTimingFormula),
    audioIsOptionalTimbreOnlyAndRecordedWordsDoNotLeak: allBlocks.every(block => (
      (block.saysAudioIsTimbreOnly || block.usesNativeVoiceFromCharacterWhenAudioMissing)
      && !block.leaksRecordedAudioWords
    )),
    sceneFourViewRemainsFullOriginal: allBlocks.every(block => block.sceneReference === "scene-four-view-original.png" && block.saysSceneIsFullUnchanged),
    noPackagedFinalFilmAsr: !asrRuntimePattern.test(runtimeSource),
    fullSuitePassed: fullSuite.exitCode === 0 && fullSuite.failed === 0
  }
};

fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "h3-two-line-native-speech-audit.json");
fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n`);
if (!Object.values(audit.assertions).every(Boolean)) process.exitCode = 1;
