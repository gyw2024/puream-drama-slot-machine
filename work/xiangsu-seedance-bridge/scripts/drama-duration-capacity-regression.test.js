"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  estimateActedSpeechSeconds,
  estimatePhysicalActionSeconds,
  generationUnitTiming,
  speechWindowBounds
} = require("../app/drama-timing");
const { dialogueTimingPlan, buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { generationBlockShotForValidation } = require("../app/agent-director");

test("normal dialogue is locked to 5-6 cps and arguments to at least 8 cps", () => {
  assert.equal(estimateActedSpeechSeconds("他早就不行了。"), 1.09);
  assert.deepEqual(speechWindowBounds("他早就不行了。"), {
    kind: "dialogue", targetCps: 5.5, minCps: 5, maxCps: 6,
    characters: 6, minSeconds: 1, targetSeconds: 1.09, maxSeconds: 1.2
  });
  assert.equal(speechWindowBounds("你马上给我滚出去！", { tone: "愤怒争吵" }).minCps, 8);

  const valid = dialogueTimingPlan([{ text: "他早就不行了。" }], 2.4);
  assert.equal(valid.slots[0].start, 0.3);
  assert.ok(Math.abs(valid.slots[0].end - 1.4) < 0.001, "natural speech uses its calculated window instead of filling the shot");
  assert.equal(valid.overflow, false);

  const short = dialogueTimingPlan([{ text: "他早就不行了。" }], 2.1);
  assert.ok(Math.abs(short.slots[0].end - 1.4) < 0.001);
  assert.ok(short.reactionTail >= 0.35, "the complete final syllable must retain a closed-mouth tail");
});

test("physical actions have an independent execution clock and contribute to block duration", () => {
  assert.equal(estimatePhysicalActionSeconds("C01 walks across the room and fully exits through the door."), 2.6);
  assert.ok(estimatePhysicalActionSeconds("C01 kisses C02; then C02 recoils and exits.") >= 2.95);
  assert.equal(
    estimatePhysicalActionSeconds("C01 kisses C02 in profile; show clear lip contact."),
    1.8,
    "a semicolon detail of the same action must not be charged as a second sequential action"
  );

  const timing = generationUnitTiming([{
    start: 0,
    end: 1,
    actionEn: "C01 walks across the room and fully exits through the door.",
    dialogueTurns: [{ text: "走吧。" }]
  }]);
  assert.ok(timing.requiredSeconds >= 2.95, "walk/exit execution plus a clean tail must set the request duration");
  assert.ok(timing.providerDuration >= 4);
});

test("an indivisible block above H3's 15-second ceiling is rejected at a complete boundary", () => {
  const longLine = "这句话必须按照规定语速完整说完，不能因为分镜时间不足就在最后一个字之前截断。".repeat(6);
  assert.throws(() => generationBlockShotForValidation({
    id: "S99",
    duration: 15,
    characterIds: ["C01"],
    characterNames: ["甲"]
  }, {
    id: "S99-B01",
    start: 0,
    end: 15,
    providerDuration: 15,
    takes: [{
      id: "S99-T01",
      start: 0,
      end: 15,
      actionEn: "C01 holds the listener's eyeline and completes the full statement.",
      visibleCharacterIds: ["C01"],
      dialogueTurns: [{ speakerId: "C01", text: longLine }]
    }]
  }), error => error?.code === "HAILUO_GENERATION_BLOCK_DURATION_OVERFLOW");
});

test("authored dialogue ending near the boundary expands the request for a closed-mouth tail", () => {
  const result = generationBlockShotForValidation({
    id: "S08",
    duration: 11,
    characterIds: ["C01"]
  }, {
    id: "S08-B02",
    start: 0,
    end: 11,
    providerDuration: 11,
    takes: [{
      id: "S08-T01",
      start: 0,
      end: 11,
      actionEn: "C01 completes the statement and holds a visible closed-mouth reaction.",
      visibleCharacterIds: ["C01"],
      dialogueTurns: [{ speakerId: "C01", text: "这句话完整说完。", start: 0, end: 10.7 }]
    }]
  });
  const lastDialogueEnd = Math.max(...result.dialogueTurns.map(turn => Number(turn.end)));
  assert.equal(result.duration, 12);
  assert.ok(result.duration - lastDialogueEnd >= 0.35, "provider request must preserve a visible closed-mouth tail");
});

test("the same physical action spanning camera cuts is continued, not restarted after every cut", () => {
  const project = {
    generation: { engine: "hailuo-h3", mode: "production_package", aspectRatio: "9:16" },
    characters: [{ id: "C01", name: "甲" }, { id: "C02", name: "乙" }]
  };
  const action = "C01 walks to C02 and extends one hand; C02 places one hand in C01's hand.";
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: {
      id: "S01",
      duration: 6,
      characterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      actionEn: action,
      stateBeforeEn: "C01 stands three steps away from C02.",
      stateAfterEn: "C01 and C02 hold one joined pair of hands.",
      providerTimedDirections: [
        { start: 0, end: 2.6, actionEn: action, cameraEn: "Hold a readable medium two-shot." },
        { start: 2.6, end: 4.2, actionEn: action, cameraEn: "Cut to the approaching feet and extended hand." },
        { start: 4.2, end: 6, actionEn: action, cameraEn: "Cut to the joined hands and both reactions." }
      ]
    },
    references: {
      promptMode: "production_package",
      hailuoApiMode: "reference_to_video",
      images: ["c01.png", "c02.png"],
      imageRoles: [
        { type: "character", entityId: "C01" },
        { type: "character", entityId: "C02" }
      ],
      audios: []
    },
    dialogueTurns: []
  });
  const shotLines = prompt.split(/\r?\n/).filter(line => /^\[Shot\s+\d+\]/i.test(line));
  assert.equal(shotLines.length, 3);
  assert.match(shotLines[0], /walks to <Subject 2> and extends one hand/i);
  assert.doesNotMatch(shotLines[1], /walks to/i);
  assert.match(shotLines[1], /continue the same single authored action/i);
  assert.doesNotMatch(shotLines[2], /walks to/i);
  assert.match(shotLines[2], /complete the same single authored action/i);
});

test("both script and director system contracts require duration-first deterministic recalculation", () => {
  const root = path.join(__dirname, "..");
  const source = [
    fs.readFileSync(path.join(root, "app", "drama-writing-contract.js"), "utf8"),
    fs.readFileSync(path.join(root, "app", "agent-director.js"), "utf8")
  ].join("\n");
  assert.match(source, /时长必须先算后定/);
  assert.match(source, /普通对话必须保持5–6个中文有效字符\/秒/);
  assert.match(source, /争吵[^\n]*至少8个有效字符\/秒/);
  assert.match(source, /总需求超过15秒必须[^\n]*(?:拆|split)/i);
  assert.match(source, /禁止截断对白/);
});
