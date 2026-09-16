"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assetBearingCharacters,
  characterAgeBand,
  coreVisualProps,
  deactivateIneligibleProjectAssetBindings,
  decorateProjectAssetMetadata,
  deterministicAppearance,
  explicitCharacterGender,
  isDialogueLikeAppearance
} = require("../app/asset-eligibility");
const { auditVoiceFile } = require("../app/voice-profile-audit");
const { WorkbenchStore } = require("../app/workbench-store");

const voicePackDir = path.join(__dirname, "..", "app", "assets", "builtin-voices");
const voiceManifest = JSON.parse(fs.readFileSync(path.join(voicePackDir, "manifest.json"), "utf8"));

function projectFixture() {
  return {
    id: "project_asset_metadata_fixture",
    script: {
      sourceDialogueLedger: [
        { speakerId: "C04", text: "顾主席，主席通道已经打开。" },
        { speakerId: "C01", text: "我回来了。" }
      ]
    },
    product: { name: "九宝茶", imagePath: "C:\\fixture\\product.png" },
    characters: [
      { id: "C01", name: "顾云舟", role: "男主，五十多岁", castingTier: "lead", description: "五十多岁男性，灰黑背头，方脸，身形挺拔，穿深色西装。" },
      { id: "C02", name: "苏晚晴", role: "女主初恋，五十多岁", castingTier: "lead", description: "五十多岁女性，银黑短卷发，鹅蛋脸，身形匀称，穿墨绿色礼服。" },
      { id: "C03", name: "银发女士甲", role: "舞会嘉宾", description: "老年女性，银灰短发，圆脸，穿酒红色礼服。" },
      { id: "C04", name: "礼宾主管", role: "主管", description: "“顾主席，主席通道已经打开。”", voiceLibraryId: "voice_offscreen_old" },
      { id: "C05", name: "礼宾人员", role: "工作人员", description: "礼宾人员站在通道两侧。" },
      { id: "C06", name: "路人甲", role: "背景人物", description: "中年男性，短发，普通外套。" },
      { id: "C07", name: "银发女士乙", role: "舞会临时来宾", description: "老年女性，银灰短发，普通礼服。", voiceLibraryId: "voice_extra_old" }
    ],
    shots: [
      { id: "S01", visibleCharacterIds: ["C01"], focusCharacterId: "C01", dialogueTurns: [{ speakerId: "C01", text: "我回来了。", onScreen: true }] },
      { id: "S02", visibleCharacterIds: ["C01", "C02"], focusCharacterId: "C02", dialogueTurns: [] },
      { id: "S03", visibleCharacterIds: ["C01", "C02", "C03", "C07"], focusCharacterId: "C03", dialogueTurns: [{ speakerId: "C07", text: "排队，我先看见的。", onScreen: true }] },
      { id: "S04", visibleCharacterIds: ["C02", "C06"], focusCharacterId: "C02", dialogueTurns: [{ speakerId: "C04", text: "顾主席，主席通道已经打开。", onScreen: false, listenerIds: ["C06"] }], offscreenSpeakerIds: ["C04"] },
      { id: "S05", visibleCharacterIds: ["C01", "C02"], dialogueTurns: [] },
      { id: "S06", visibleCharacterIds: ["C01", "C02"], dialogueTurns: [] }
    ],
    candidates: [
      { id: "A01", entityType: "character", entityId: "C01", stage: "character_sheet", selected: true, reusableAssetId: "asset_lead" },
      { id: "A02", entityType: "character", entityId: "C04", stage: "character_voice", selected: true, voiceLibraryId: "voice_offscreen_old" },
      { id: "A03", entityType: "character", entityId: "C07", stage: "character_sheet", selected: true, reusableAssetId: "asset_extra_old" },
      { id: "A04", entityType: "library", entityId: "P05", stage: "prop_asset", selected: true, reusableAssetId: "asset_teabag_old" }
    ],
    assetLibraries: {
      wardrobes: [],
      props: [
        { id: "P01", name: "婚戒", coreStory: true, units: ["S01"], description: "顾云舟摘下婚戒，决定离婚。" },
        { id: "P02", name: "审计文件", units: ["S02", "S05"], description: "关键审计证据。" },
        { id: "P03", name: "深灰色审计文件夹", units: ["S05"], description: "装审计文件。" },
        { id: "P04", name: "九宝茶", units: ["S04", "S05"], purpose: "产品展示" },
        { id: "P05", name: "独立茶包", units: ["S04"] },
        { id: "P06", name: "透明杯", units: ["S04"] },
        { id: "P07", name: "邀请券", units: ["S03"] },
        { id: "P08", name: "离婚协议", units: ["S02", "S06"] }
      ]
    }
  };
}

test("dialogue stays in the ledger while only direct-shot meaningful people get identity assets", () => {
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(projectFixture()));
  assert.equal(isDialogueLikeAppearance("“顾主席，主席通道已经打开。”", project.script.sourceDialogueLedger), true);
  assert.deepEqual(assetBearingCharacters(project).map(item => item.id), ["C01", "C02", "C03"]);

  const offscreen = project.characters.find(item => item.id === "C04");
  assert.equal(offscreen.castingTier, "offscreen");
  assert.equal(offscreen.assetRequired, false);
  assert.equal(offscreen.voiceAssetRequired, false);
  assert.equal(offscreen.appearanceDescription, "");
  assert.match(offscreen.assetDecision.reason, /画外/);

  const extra = project.characters.find(item => item.id === "C06");
  assert.ok(["extra", "background"].includes(extra.castingTier));
  assert.equal(extra.assetRequired, false);
  assert.equal(project.characters.find(item => item.id === "C07").assetRequired, false, "one-line visible extras must not create identity assets");
  assert.equal(project.characters.find(item => item.id === "C05").assetRequired, false);
  assert.equal(project.characters.find(item => item.id === "C04").voiceLibraryId, "");
  assert.equal(project.characters.find(item => item.id === "C07").voiceLibraryId, "");
  assert.equal(project.candidates.find(item => item.id === "A01").selected, true, "eligible lead asset stays selected");
  for (const id of ["A02", "A03"]) {
    const candidate = project.candidates.find(item => item.id === id);
    assert.equal(candidate.selected, false, id);
    assert.equal(candidate.stale, true, id);
    assert.equal(candidate.reusableAssetId, "", id);
    assert.equal(candidate.assetPolicyExcluded, true, id);
  }
  for (const character of assetBearingCharacters(project)) {
    assert.ok(character.appearanceDescription.length >= 20);
    assert.doesNotMatch(character.appearanceDescription, /主席通道已经打开/);
    assert.ok(["lead", "supporting", "cameo"].includes(character.castingTier));
  }
});

test("legacy silver-haired named roles receive stable senior gender metadata and matching hair", () => {
  const woman = { id: "C20", name: "银发女士甲", role: "舞会来宾" };
  const representative = { id: "C21", name: "银发代表甲", role: "退休员工代表" };
  assert.equal(explicitCharacterGender(woman), "female");
  assert.equal(characterAgeBand(woman), "老年");
  assert.equal(explicitCharacterGender(representative), "male");
  assert.equal(characterAgeBand(representative), "老年");
  assert.match(deterministicAppearance(woman), /(?:银发|银灰|银白|白发|灰白|花白)/);
  assert.match(deterministicAppearance(representative), /(?:银发|银灰|银白|白发|灰白|花白)/);
});

test("only continuity-critical props remain; products, components, duplicates and one-shot paper stay out", () => {
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(projectFixture()));
  const selected = coreVisualProps(project);
  assert.deepEqual(selected.map(item => item.name), ["婚戒", "审计文件", "离婚协议"]);
  for (const name of ["九宝茶", "独立茶包", "透明杯", "邀请券", "深灰色审计文件夹"]) {
    const prop = project.assetLibraries.props.find(item => item.name === name);
    assert.equal(prop.assetRequired, false, name);
    assert.ok(prop.assetDecisionReason, name);
  }
  assert.equal(project.assetLibraries.props.find(item => item.name === "深灰色审计文件夹").assetMergedIntoId, "P02");
  const oldTeaBagAsset = project.candidates.find(item => item.id === "A04");
  assert.equal(oldTeaBagAsset.selected, false);
  assert.equal(oldTeaBagAsset.stale, true);
  assert.equal(oldTeaBagAsset.reusableAssetId, "");
  assert.equal(oldTeaBagAsset.assetPolicyExcluded, true);
});

test("the bundled pack contains 40 distinct playable WAV voices across genders and ages", () => {
  assert.equal(voiceManifest.voices.length, 40);
  const ids = new Set();
  const hashes = new Set();
  const genders = { male: 0, female: 0 };
  const ages = { 青年: 0, 中年: 0, 老年: 0 };
  for (const voice of voiceManifest.voices) {
    assert.ok(!ids.has(voice.id), voice.id);
    ids.add(voice.id);
    genders[voice.gender] += 1;
    ages[voice.ageBand] += 1;
    const filePath = path.join(voicePackDir, voice.file);
    assert.ok(fs.existsSync(filePath), voice.file);
    hashes.add(crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"));
    const audit = auditVoiceFile(filePath);
    assert.equal(audit.ok, true, voice.file);
    assert.ok(audit.duration > 0.5, voice.file);
  }
  assert.equal(hashes.size, 40);
  assert.ok(genders.male >= 16);
  assert.ok(genders.female >= 16);
  assert.ok(ages.青年 >= 8);
  assert.ok(ages.中年 >= 8);
  assert.ok(ages.老年 >= 8);
});

test("a fresh store protects 40 built-in voices and never marks low-confidence acoustic gender as verified", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-voice-pack-v118-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const voices = store.listVoiceLibrary();
  assert.equal(voices.length, 40);
  assert.equal(voices.filter(item => item.builtIn === true).length, 40);
  assert.equal(voices.filter(item => item.profileVerified === true).length, 39);
  const pending = voices.filter(item => item.profileVerified !== true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "builtin_voice_40");
  assert.equal(pending[0].profileVerificationSource, "curated-source-pending-acoustic");
  assert.throws(() => store.deleteVoiceLibraryEntry("builtin_voice_01"), error => error?.code === "BUILTIN_VOICE_DELETE_FORBIDDEN");
});

test("confirmed core asset candidates receive durable reverse links to the reusable library", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-reusable-asset-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const project = store.createProject("asset link fixture");
  const filePath = path.join(store.assetDir(project.id, "characters"), "lead.png");
  fs.writeFileSync(filePath, Buffer.from("lead-image"));
  const mutable = store.getProject(project.id);
  mutable.productionRevision = "R01";
  mutable.characters = [{ id: "C01", name: "顾云舟", gender: "male", ageBand: "中年", castingTier: "lead", assetRequired: true }];
  store.saveProject(mutable);
  const candidate = store.addCandidate(project.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_intro",
    productionRevision: "R01",
    filePath,
    selected: true
  });
  const links = store.linkConfirmedProjectAssetsToLibrary(project.id);
  const persisted = store.getProject(project.id).candidates.find(item => item.id === candidate.id);
  assert.equal(links.length, 1);
  assert.match(persisted.reusableAssetId, /^asset_/);
  assert.equal(store.readReusableAssetLibrary().some(item => item.id === persisted.reusableAssetId && item.gender === "male" && item.castingTier === "lead"), true);
});

test("confirming a new portrait does not stale an independently materialized library voice", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-independent-library-voice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const project = store.createProject("independent voice fixture");
  const mutable = store.getProject(project.id);
  mutable.productionRevision = "R01";
  mutable.characters = [{ id: "C01", name: "银发代表甲", gender: "male", ageBand: "老年", assetRequired: true, voiceAssetRequired: true }];
  store.saveProject(mutable);

  const voicePath = path.join(store.assetDir(project.id, "audio"), "voice.wav");
  fs.copyFileSync(path.join(voicePackDir, voiceManifest.voices[0].file), voicePath);
  const voice = store.addCandidate(project.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_voice",
    source: "voice-library",
    voiceLibraryId: voiceManifest.voices[0].id,
    filePath: voicePath,
    selected: true
  });
  const portraitPath = path.join(store.assetDir(project.id, "characters"), "portrait.png");
  fs.writeFileSync(portraitPath, Buffer.from("portrait"));
  const portrait = store.addCandidate(project.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_intro",
    filePath: portraitPath
  });
  store.confirmCandidate(project.id, portrait.id, false);

  const persisted = store.getProject(project.id).candidates.find(item => item.id === voice.id);
  assert.equal(persisted.stale, undefined);
  assert.equal(persisted.selected, true);
});

test("prompt review only enumerates asset-bearing people, required voices and core assets", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const start = workflow.indexOf("async preparePromptReviewBundle(projectId, options = {})");
  const end = workflow.indexOf("async requestPromptReview", start);
  assert.ok(start >= 0 && end > start);
  const source = workflow.slice(start, end);
  assert.match(source, /reviewCharacterIds = new Set\(assetBearingCharacters\(project\)/);
  assert.match(source, /if \(!reviewCharacterIds\.has\(String\(character\.id \|\| ""\)\)\) return character/);
  assert.match(source, /reviewVoiceIds = new Set/);
  assert.match(source, /reviewPropIds = new Set\(coreVisualProps\(project\)/);
  assert.match(source, /libraryType === "props" && !reviewPropIds\.has/);
  assert.match(source, /libraryType === "wardrobes" && entry\.changeRequired === false/);
});

test("renderer exposes asset eligibility, verified voice tags and casting filters", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.match(renderer, /character\.assetRequired === true/);
  assert.match(renderer, /item\.assetRequired === true/);
  assert.match(renderer, /声纹标签已核验/);
  assert.match(renderer, /内置音色/);
  assert.match(renderer, /data-reusable-asset-filter="castingTier"/);
  assert.match(renderer, /未建立独立资产/);
  assert.match(renderer, /已跳过 .*非核心物品/);
});
