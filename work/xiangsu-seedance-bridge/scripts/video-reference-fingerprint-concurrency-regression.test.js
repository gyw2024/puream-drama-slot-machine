"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { videoSubmissionFingerprint } = require("../app/workbench-workflow");

test("four concurrent H3 submissions finish reference fingerprinting deterministically", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-h3-reference-hash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "character-reference.png");
  fs.writeFileSync(imagePath, Buffer.alloc(1024 * 1024, 0x5a));
  const project = {
    id: "fingerprint-project",
    productionRevision: "revision-1",
    generation: { aspectRatio: "9:16" }
  };
  const references = {
    images: [imagePath],
    imageRoles: [{ type: "character", entityId: "C01" }],
    audios: [],
    aspectRatio: "9:16"
  };

  const started = Date.now();
  const fingerprints = await Promise.all(Array.from({ length: 4 }, (_, index) => (
    videoSubmissionFingerprint(
      project,
      "puream-hailuo-h3",
      "character",
      `C0${index + 1}`,
      "character_video",
      "deterministic character intro",
      references,
      5,
      "image_to_video",
      "480"
    )
  )));

  assert.equal(new Set(fingerprints).size, 4, "entity identity remains part of the paid-task fingerprint");
  assert.ok(fingerprints.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.ok(Date.now() - started < 5000, "local fingerprint preparation must not look like a remote generation stall");
});
