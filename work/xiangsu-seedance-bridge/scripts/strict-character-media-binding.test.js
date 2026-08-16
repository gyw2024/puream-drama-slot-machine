"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertStrictCharacterMediaBindings } = require("../app/workbench-workflow");

function fixture() {
  const project = {
    characters: [
      { id: "C01", name: "张三" },
      { id: "C02", name: "李四" }
    ]
  };
  const shot = {
    id: "S01",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    dialogueTurns: [
      { speakerId: "C01", speaker: "张三", listenerIds: ["C02"], text: "李四，你把账说清楚。", subshotNumber: 1, onScreen: true },
      { speakerId: "C02", speaker: "李四", listenerIds: ["C01"], text: "这笔钱不是我拿的。", subshotNumber: 2, onScreen: true }
    ],
    subshots: [
      { mouthOwnerId: "C01" },
      { mouthOwnerId: "C02" }
    ]
  };
  const references = {
    imageRoles: [
      { type: "character", entityId: "C01", path: "D:/identity/zhang-san.png" },
      { type: "character", entityId: "C02", path: "D:/identity/li-si.png" }
    ],
    audios: [
      { characterId: "C01", characterName: "张三", path: "D:/voice/zhang-san.wav" },
      { characterId: "C02", characterName: "李四", path: "D:/voice/li-si.wav" }
    ]
  };
  return { project, shot, references };
}

test("speaker, exact dialogue, identity image, voice and mouth owner form a bijection", () => {
  const { project, shot, references } = fixture();
  assert.equal(assertStrictCharacterMediaBindings(project, shot, references), true);
});

test("two characters can never share one voice file", () => {
  const { project, shot, references } = fixture();
  references.audios[1].path = references.audios[0].path;
  assert.throws(() => assertStrictCharacterMediaBindings(project, shot, references), error => error.code === "SHOT_VOICE_FILE_SHARED_BETWEEN_CHARACTERS");
});

test("voice character id and character name can never disagree", () => {
  const { project, shot, references } = fixture();
  references.audios[0].characterName = "李四";
  assert.throws(() => assertStrictCharacterMediaBindings(project, shot, references), error => error.code === "SHOT_VOICE_CHARACTER_METADATA_MISMATCH");
});

test("every speaking character must have exactly one voice and no extra voice", () => {
  const { project, shot, references } = fixture();
  references.audios.pop();
  assert.throws(() => assertStrictCharacterMediaBindings(project, shot, references), error => error.code === "SHOT_DIALOGUE_VOICE_BIJECTION_FAILED");
});

test("two visible characters can never share one identity file", () => {
  const { project, shot, references } = fixture();
  references.imageRoles[1].path = references.imageRoles[0].path;
  assert.throws(() => assertStrictCharacterMediaBindings(project, shot, references), error => error.code === "SHOT_CHARACTER_IDENTITY_FILE_SHARED");
});

test("an on-screen line can only use the speaking character's mouth", () => {
  const { project, shot, references } = fixture();
  shot.subshots[0].mouthOwnerId = "C02";
  assert.throws(() => assertStrictCharacterMediaBindings(project, shot, references), error => error.code === "SHOT_DIALOGUE_MOUTH_OWNER_MISMATCH");
});

test("duplicate speaking names are rejected before media submission", () => {
  const { project, shot, references } = fixture();
  project.characters.push({ id: "C03", name: "张三" });
  assert.throws(() => assertStrictCharacterMediaBindings(project, shot, references), error => error.code === "SHOT_SPEAKER_NAME_DUPLICATED");
});
