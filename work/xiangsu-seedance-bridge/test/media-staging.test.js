"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { stageSubmissionMedia, validateSubmission } = require("../app/media-staging");

const taskTestRoot = path.resolve(__dirname, "..", "..", "..", ".codex_tests", "puream-drama-corpus-prompts-v1", "staging-unit");

test("staging uses ASCII filenames and preserves original paths", () => {
  fs.mkdirSync(taskTestRoot, { recursive: true });
  const source = path.join(taskTestRoot, "中文参考图.png");
  fs.writeFileSync(source, "image-bytes");
  const staged = stageSubmissionMedia({ images: [{ path: source, name: "中文参考图.png" }], audios: [] }, path.join(taskTestRoot, "runtime"));
  try {
    assert.equal(staged.payload.images[0].originalPath, source);
    assert.match(path.basename(staged.payload.images[0].path), /^image-01\.png$/);
    assert.equal(fs.readFileSync(staged.payload.images[0].path, "utf8"), "image-bytes");
  } finally {
    fs.rmSync(staged.requestDir, { recursive: true, force: true });
    fs.rmSync(source, { force: true });
  }
});

test("Seedance multimodal limits are enforced before upload", () => {
  assert.doesNotThrow(() => validateSubmission({ images: [], audios: [], duration: 5, aspectRatio: "9:16" }));
  assert.throws(() => validateSubmission({ images: Array.from({ length: 10 }, () => ({})) }), /最多 9 张/);
  assert.throws(() => validateSubmission({ audios: [{ duration: 6 }, { duration: 5 }, { duration: 5 }] }), /最长 15 秒/);
  assert.throws(() => validateSubmission({ video: { duration: 10.2 } }), /最长 10 秒/);
  assert.throws(() => validateSubmission({ duration: 4 }), /5-10 秒整数/);
  assert.doesNotThrow(() => validateSubmission({ images: Array.from({ length: 9 }, () => ({})), audios: [{ duration: 5 }, { duration: 5 }, { duration: 5 }], video: { duration: 10 }, duration: 10, aspectRatio: "9:16" }));
});
