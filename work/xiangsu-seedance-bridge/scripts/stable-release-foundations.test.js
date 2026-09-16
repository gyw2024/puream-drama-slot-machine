"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectUploadedScriptFormat, parseSourceDialogueLedger } = require("../app/dialogue-parser");
const { assetUrlForPath, pathFromAssetUrl, realPathWithinRoot } = require("../app/secure-asset-protocol");
const { WorkbenchStore } = require("../app/workbench-store");
const { characterIdentityCandidate, splitUploadedScriptSections } = require("../app/workbench-workflow");
const { stageCounts } = require("../app/project-overview");

test("secure asset URLs round-trip Chinese and reserved path characters but reject files outside the data root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-asset-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "puream-asset-outside-"));
  try {
    const nested = path.join(root, "人物#1", "正脸 版本.png");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, Buffer.from([1, 2, 3]));
    const url = assetUrlForPath(nested);
    assert.equal(pathFromAssetUrl(url), path.resolve(nested));
    assert.equal(realPathWithinRoot(pathFromAssetUrl(url), root), fs.realpathSync.native(nested));

    const foreign = path.join(outside, "foreign.png");
    fs.writeFileSync(foreign, Buffer.from([1]));
    assert.throws(() => realPathWithinRoot(foreign, root), error => error.code === "ASSET_PATH_OUTSIDE_ROOT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("script intake recognizes the supported production, dialogue, timed, Chinese screenplay, Fountain and JSON families", () => {
  const cases = [
    ["structured_production", "## S01｜0-10秒｜客厅\n母亲：别开门。"],
    ["dialogue", "母亲（压低声音）：别开门。\n儿子：我也听见了。"],
    ["timed_storyboard", "[00:00-00:08] 母亲：别开门。"],
    ["chinese_screenplay", "第1场 客厅 日 内\n母亲\n（压低声音）\n别开门。"],
    ["fountain", "INT. KITCHEN - NIGHT\n\nMOTHER\n(whispering)\nDo not open the door."],
    ["json", JSON.stringify({ characters: [{ name: "母亲" }], scenes: [] })]
  ];
  for (const [expected, source] of cases) assert.equal(detectUploadedScriptFormat(source), expected, source);
});

test("dialogue ledger preserves inline, timed and standalone screenplay dialogue without treating scene headings as speakers", () => {
  const source = `第1场 客厅 日 内

母亲
（压低声音）
别开门。

儿子：我也听见了。
[00:08-00:16] 母亲（急促）：马上报警。`;
  const ledger = parseSourceDialogueLedger(source, ["母亲", "儿子"]);
  assert.deepEqual(ledger.map(item => [item.speaker, item.spokenText]), [
    ["母亲", "别开门。"],
    ["儿子", "我也听见了。"],
    ["母亲", "马上报警。"]
  ]);
  assert.match(ledger[0].tone, /压低声音/);
  assert.match(ledger[1].tone, /生活化|中速|核心词/);
  assert.match(ledger[2].tone, /急促/);
  assert.equal(ledger.some(item => /第1场|客厅/.test(item.speaker)), false);
});

test("explicitly choosing any character identity stage makes that exact asset current everywhere", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-identity-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("身份选择");
    const project = store.getProject(created.id);
    project.characters = [{ id: "C01", name: "母亲" }];
    store.saveProject(project);
    const sheetPath = path.join(root, "sheet.png");
    const threePath = path.join(root, "three.png");
    fs.writeFileSync(sheetPath, "sheet");
    fs.writeFileSync(threePath, "three");
    const sheet = store.addCandidate(created.id, { entityType: "character", entityId: "C01", stage: "character_sheet", filePath: sheetPath });
    store.confirmCandidate(created.id, sheet.id, false);
    const three = store.addCandidate(created.id, { entityType: "character", entityId: "C01", stage: "character_three_view", filePath: threePath });
    store.confirmCandidate(created.id, three.id, false, { forceManualSelection: true });
    const current = store.getProject(created.id);
    assert.equal(current.characters[0].activeIdentityCandidateId, three.id);
    assert.equal(characterIdentityCandidate(current, "C01")?.id, three.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automatic portrait selection never hides an available four-view character board", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-four-view-preview-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("人物四视图优先");
    const project = store.getProject(created.id);
    project.characters = [{ id: "C01", name: "母亲" }];
    store.saveProject(project);
    const sheetPath = path.join(root, "four-view.png");
    const introPath = path.join(root, "front-face.png");
    fs.writeFileSync(sheetPath, "four-view");
    fs.writeFileSync(introPath, "front-face");
    const sheet = store.addCandidate(created.id, { entityType: "character", entityId: "C01", stage: "character_sheet", filePath: sheetPath, qualityAudit: { ok: true } });
    store.confirmCandidate(created.id, sheet.id, false);
    const intro = store.addCandidate(created.id, { entityType: "character", entityId: "C01", stage: "character_intro", filePath: introPath, qualityAudit: { ok: true } });
    store.confirmCandidate(created.id, intro.id, false);
    const current = store.getProject(created.id);
    current.characters[0].activeIdentityCandidateId = "";
    store.saveProject(current);
    const latest = store.getProject(created.id);
    assert.equal(characterIdentityCandidate(latest, "C01")?.id, sheet.id);
    assert.equal(stageCounts(latest, store.getSettings()).characters.ready, 1);
    const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
    assert.match(renderer, /return chosenCandidate\("character", characterId, "character_sheet"\)[\s\S]{0,180}character_intro/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata before an explicit 正文 divider never enters the dramatic body", () => {
  const split = splitUploadedScriptSections("人物介绍：母亲，55岁。\n故事梗概：一次误会。\n\n正式剧情\n第1场 客厅 日 内\n母亲：别开门。");
  assert.match(split.metadata, /人物介绍/);
  assert.doesNotMatch(split.dramaticBody, /人物介绍|故事梗概|正式剧情/);
  assert.match(split.dramaticBody, /第1场/);
});
