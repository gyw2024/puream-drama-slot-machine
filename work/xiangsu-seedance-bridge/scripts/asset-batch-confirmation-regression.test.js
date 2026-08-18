"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");

test("asset confirmation uses the persisted backend plan and never counts retired identity stages", () => {
  const start = renderer.indexOf('$("#generateAllAssets").addEventListener');
  const end = renderer.indexOf('$("#importVoiceLibrary")', start);
  assert.ok(start >= 0 && end > start);
  const handler = renderer.slice(start, end);

  assert.match(handler, /progress\?\.items/);
  assert.match(handler, /const missing = plannedItems\.length - ready/);
  assert.doesNotMatch(handler, /missing \+ failed\.length/);
  assert.doesNotMatch(handler, /character_intro/);
  assert.doesNotMatch(handler, /character_three_view/);
});
