'use strict';

// Contract-only fixtures: the PNGs are synthetic test pixels and every reviewer
// response below is a mock. No real visual/semantic approval or media is claimed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const {spawnSync} = require('node:child_process');
const editorial = require('../app/commerce-editorial-contract');
const editor = require('../app/h3-final-prompt-editor');
const {buildApprovedHailuoPrompt} = require('../app/hailuo-h3-natural-prompt');
const {speechWindowBounds} = require('../app/drama-timing');
const {WorkbenchStore} = require('../app/workbench-store');
const {validateDramaAssetPackage, importDramaAssetPackage, productionAuditFingerprint} = require('../app/drama-asset-package');
const {PROMPT_REVIEW_BUNDLE_VERSION, promptReviewSourceFingerprint, promptReviewSettingsFingerprint} = require('../app/workbench-workflow');
const evidenceRoot = path.resolve(__dirname, '../.codex_tests/TASK-20260907-COMMERCE-CONTRACT-210/extension2');
const skillRoot = 'D:/CodexData/.codex/skills/puream-drama-production-package/scripts';
const helpers = {promptReviewVersion: PROMPT_REVIEW_BUNDLE_VERSION, promptReviewSourceFingerprint, promptReviewSettingsFingerprint};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function loadExistingFixture() {
  // Load only the existing fixture definitions; never register/run its tests,
  // which use different temporary directories and own unrelated regressions.
  const filename = path.join(__dirname, 'drama-production-package-v127-regression.test.js');
  const source = fs.readFileSync(filename, 'utf8');
  const boundary = source.indexOf("\ntest('official edited source");
  assert.ok(boundary > 0, 'The fixture boundary changed; review before reuse.');
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated._compile(source.slice(0, boundary) + '\nmodule.exports = {editedFixturePayload};', filename);
  return isolated.exports.editedFixturePayload();
}

function fixture(targetRatio = 0.2) {
  const pack = loadExistingFixture(), p = pack.project, s = p.shots[0];
  s.duration=15;
  s.finalPromptEditing.detailedDescriptionEn=s.finalPromptEditing.detailedDescriptionEn.replace('From 10 to 12 seconds','From 10 to 15 seconds');
  s.providerTimedDirections=s.providerTimedDirections.map(row=>({...row,end:15}));
  const lines = {
    need: '林曼秋需要核对受邀人的姓名与编号。',
    selection: '她选择同时载明姓名与编号的邀请券。',
    introduction: '哈桑确认这是约定的测试邀请券。',
    demonstration: '林曼秋指向邀请券上的姓名栏与编号栏，核对这两项是否和受邀人一致。',
    transition: '两人核对一致后决定保留这张邀请券。',
    coverage: '镜头从同轴双人画面切至原券细节，再回到哈桑闭口确认的反应。',
    cta: '点击左下角头像进入橱窗购买'
  };
  p.commerceEditorialContractVersion = editorial.VERSION;
  p.generation.commerceMode = 'explicit';
  p.generation.commerceTargetRatio = targetRatio;
  p.product = {name: '测试邀请券', sellingPoints: '同时载明受邀人姓名与编号', description: '', price: '39.9', offer: '无促销', purchaseInstructions: lines.cta};
  s.action = [lines.need, lines.selection, lines.introduction, lines.demonstration, lines.transition, lines.coverage].join('');
  s.subshots = [{number: 1, start: 4, end: 8.5, action: lines.demonstration, actionEn: 'C01 points to the invitation name and number fields and checks them against the expected guest.'}];
  const ctaStart = 10;
  const ctaEnd = ctaStart + speechWindowBounds(lines.cta, {speechRateKind: 'normal'}).targetSeconds;
  const turn = {...structuredClone(s.dialogueTurns[0]), sourceDialogueId: 'D002', text: lines.cta,
    start: ctaStart, end: ctaEnd, startSecond: ctaStart, endSecond: ctaEnd,
    addressMode: 'viewer', directToViewer: true,
    speakerFacingEn: 'C01 faces the viewer through the lens in a readable three-quarter angle.',
    eyelineEn: 'C01 looks toward the viewer through the lens while C02 remains closed-lipped.',
    bodyActionEn: 'C01 keeps the original invitation supported in the right hand and directs the purchase instruction toward the viewer.'};
  s.dialogueTurns.push(turn);
  p.sourceDialogueLedger.push({id: 'D002', speakerId: 'C01', speaker: '林曼秋', text: lines.cta});
  p.productionAudit.layer1Story.openingEvidenceDialogueIds.push('D002');
  p.script = '  S01 玻璃长廊。' + s.action + '\n林曼秋：邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。\n林曼秋（面向观众）：' + lines.cta + '\n';
  s.finalPromptEditing.detailedDescriptionEn = s.finalPromptEditing.detailedDescriptionEn.replace(
    'The final 0.35 seconds retains both closed mouths and the lowered invitation.',
    `C01 checks the invitation name and number fields and retains the original invitation in the right hand. From ${ctaStart} to ${ctaEnd} seconds, C01 (S1) faces the viewer and says exactly once: <d>[Chinese] ${lines.cta}</d> C01 gives a clear firm invitation while C02 remains closed-lipped. The final 0.35 seconds retains both closed mouths and the lowered invitation.`);
  s.finalPromptEditing.detailedDescriptionZh = s.finalPromptEditing.detailedDescriptionEn;
  s.finalPromptEditing.fingerprint = editor.fingerprint(s);
  s.videoPromptEn = buildApprovedHailuoPrompt({project: {...p, assetLibraries: {props: p.props, wardrobes: p.wardrobes}}, shot: s,
    references: {imageRoles: s.references, images: s.references.map(r => r.assetId), audios: [], hailuoApiMode: 'reference_to_video', referenceAudioMode: 'image_only'}, dialogueTurns: s.dialogueTurns});
  s.videoPromptZh = '林曼秋（C01）与哈桑（C02）\n' + s.finalPromptEditing.detailedDescriptionZh;
  p.promptBatchReview.batches[0].promptHashes.S01 = hash(s.videoPromptEn.trim());
  const point = quote => ({unitId: 'S01', quote});
  const evidence = [lines.need, lines.selection, lines.demonstration, lines.transition, lines.transition, lines.coverage];
  const rawReport = {ok: true, issues: [], checks: [{dimension: 'fixture contract', evidence: 'Mock evidence only, no actual semantic or visual review.'}], editorial: {
    checks: editorial.DIMENSIONS.map((dimension, i) => ({dimension, ok: true, explanation: 'Synthetic source evidence for deterministic package contract testing only.', evidence: [point(evidence[i])]})),
    anchors: {need: point(lines.need), selection: point(lines.selection), introduction: point(lines.introduction), ctaTransition: point(lines.transition), cta: point(lines.cta)},
    featureEvidence: [{...point(lines.demonstration), fact: p.product.sellingPoints}],
    intervals: [{...point(lines.demonstration), start: 4, end: 8.5, purpose: 'verified_demonstration'}]
  }};
  const verdict = editorial.evaluate({units: editorial.projectUnits(p), product: p.product, mode: 'explicit', targetRatio, report: rawReport});
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  p.productionAudit.layer1Story.editorialReview = {...verdict, rawReport, executionKey: hash('mock-reviewer'), reviewedAt: '2026-09-07T18:40:00.000Z'};
  p.productionAudit.reviewedFingerprint = productionAuditFingerprint(pack);
  return pack;
}

function workspace(label) {
  fs.mkdirSync(evidenceRoot, {recursive: true});
  return fs.mkdtempSync(path.join(evidenceRoot, label + '-'));
}

function prepareManifest(pack, root) {
  const manifest = structuredClone(pack);
  for (const asset of manifest.assets) {
    asset.sourcePath = path.join(root, asset.fileName);
    fs.writeFileSync(asset.sourcePath, Buffer.from(asset.dataBase64, 'base64'));
    delete asset.dataBase64;
  }
  const manifestPath = path.join(root, 'manifest.json'), auditPath = path.join(root, 'fixture-visual-audit.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const prepared = spawnSync(process.execPath, [path.join(skillRoot, 'prepare-asset-audit.js'), manifestPath, auditPath], {encoding: 'utf8', timeout: 15000});
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  audit.fixtureOnly = 'Synthetic pixels and mocked check fields; no real visual inspection has occurred.';
  for (const row of audit.assets) Object.assign(row, {status: 'approved', reviewMethod: 'codex_visual_inspection', reviewedAt: '2026-09-07T18:40:00.000Z', checks: Object.fromEntries(Object.keys(row.checks).map(key => [key, true])), issues: [], fixtureOnly: true});
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  return {manifest, manifestPath, auditPath};
}

function build(pack, root, name = 'fixture') {
  const prepared = prepareManifest(pack, root), outputPath = path.join(root, name + '.pdramapack');
  const result = spawnSync(process.execPath, [path.join(skillRoot, 'build-package.js'), prepared.manifestPath, outputPath, prepared.auditPath], {encoding: 'utf8', timeout: 15000});
  fs.writeFileSync(path.join(root, name + '-builder-result.json'), JSON.stringify({status: result.status, stdout: result.stdout, stderr: result.stderr, fixtureOnly: true}, null, 2));
  return {result, outputPath, ...prepared};
}

test('commerce package: real builder and isolated import preserve exact source, dialogue and timing', () => {
  const pack = fixture(0.3), root = workspace('positive');
  assert.doesNotThrow(() => validateDramaAssetPackage(pack));
  const built = build(pack, root);
  assert.equal(built.result.status, 0, built.result.stderr || built.result.stdout);
  const output = JSON.parse(fs.readFileSync(built.outputPath, 'utf8'));
  const store = new WorkbenchStore(path.join(root, 'isolated-store'));
  const imported = importDramaAssetPackage(store, built.outputPath, helpers), actual = store.getProject(imported.projectId);
  assert.equal(actual.script.raw, pack.project.script);
  assert.deepEqual(actual.shots[0].dialogueTurns.map(t => [t.sourceDialogueId, t.speakerId, t.text, t.start, t.end]), pack.project.shots[0].dialogueTurns.map(t => [t.sourceDialogueId, t.speakerId, t.text, t.start, t.end]));
  assert.equal(actual.shots[0].duration, pack.project.shots[0].duration);
  assert.equal(actual.shots[0].manualVideoPrompt, output.project.shots[0].videoPromptEn);
  assert.deepEqual(actual.shots[0].subshots.map(s => [s.action, s.start, s.end]), pack.project.shots[0].subshots.map(s => [s.action, s.start, s.end]));
  assert.deepEqual(actual.script.editorialReview, output.project.productionAudit.layer1Story.editorialReview);
  assert.equal(actual.script.editorialReview.inputFingerprint, editorial.fingerprint(editorial.projectUnits(actual), actual.product, actual.productionPlan.commerceMode, actual.generation.commerceTargetRatio), 'Deposited local paths must not invalidate the original source/fact receipt.');
  assert.equal(actual.productionPlan.commerceMode, pack.project.generation.commerceMode);
  assert.equal(actual.generation.commerceTargetRatio, 0.3);
  assert.equal(actual.importedProductionPackage.commerceEditorialTargetRatio, pack.project.generation.commerceTargetRatio);
  assert.equal(actual.importedProductionPackage.commerceEditorialStatus, 'approved');
  assert.equal(editor.current(actual.shots[0]), true);
  fs.writeFileSync(path.join(root, 'roundtrip-receipt.json'), JSON.stringify({fixtureOnly: true, packageSha256: hash(fs.readFileSync(built.outputPath)), importedProjectId: actual.id, exactSource: true, exactDialogueTiming: true, exactPrompt: true, preservedEditorialReceipt: true, realVisualReview: false}, null, 2));
});

for (const variant of ['missing', 'stale', 'stale-action-time', 'negative']) test(`commerce package: ${variant} new-contract receipt is rejected before importing a project`, () => {
  const pack = fixture(), root = workspace(variant), layer = pack.project.productionAudit.layer1Story;
  if (variant === 'missing') delete layer.editorialReview;
  if (variant === 'stale') pack.project.product.price = '49.9';
  if (variant === 'stale-action-time') pack.project.shots[0].subshots[0].start = 4.6;
  if (variant === 'negative') {layer.editorialReview.rawReport.ok = false; layer.editorialReview.rawReport.issues = [{message: 'Synthetic unresolved finding'}];}
  pack.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(pack);
  const built = build(pack, root);
  assert.notEqual(built.result.status, 0, 'Builder accepted an invalid commerce receipt.');
  assert.match(built.result.stderr, /commerce|带货|editorial/i);
  const packagePath = path.join(root, 'untrusted-direct-import.pdramapack');
  fs.writeFileSync(packagePath, JSON.stringify(pack));
  const store = new WorkbenchStore(path.join(root, 'isolated-store'));
  assert.throws(() => importDramaAssetPackage(store, packagePath, helpers), error => /^DRAMA_PACKAGE_COMMERCE_/.test(error.code));
  assert.equal(store.listProjects().length, 0);
});

test('commerce package: receipt without marker is validated and old unmarked packages remain explicitly legacy', () => {
  const pack = fixture();
  delete pack.project.commerceEditorialContractVersion;
  pack.project.productionAudit.layer1Story.editorialReview.inputFingerprint = '0'.repeat(64);
  pack.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(pack);
  assert.throws(() => validateDramaAssetPackage(pack), error => error.code === 'DRAMA_PACKAGE_COMMERCE_REVIEW_STALE');
  const legacy = loadExistingFixture(), root = workspace('legacy'), file = path.join(root, 'legacy.pdramapack');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new WorkbenchStore(path.join(root, 'isolated-store'));
  const result = importDramaAssetPackage(store, file, helpers), project = store.getProject(result.projectId);
  assert.equal(project.importedProductionPackage.commerceEditorialStatus, 'legacy_not_reviewed');
  assert.equal(project.script.editorialReview, undefined);
  assert.equal(project.commerceEditorialContractVersion, undefined);
});
