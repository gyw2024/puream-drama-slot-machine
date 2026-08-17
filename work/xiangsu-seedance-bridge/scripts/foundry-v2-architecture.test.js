"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const { buildAssetPassports, assetPromptPolicy } = require("../app/foundry/asset-passport");
const { FoundryError, ERROR_KINDS } = require("../app/foundry/errors");
const {
  assertAbsolutePolicies,
  compileProductionContract,
  contractPromptBlock
} = require("../app/foundry/production-contract");
const { evaluateProject } = require("../app/foundry/quality-lab");
const { FoundryRuntimeStore, PROJECT_SAVED_REVISION_LIMIT } = require("../app/foundry/runtime-store");
const { SCRIPT_UNDERSTANDING_VERSION, buildScriptUnderstanding } = require("../app/foundry/script-understanding");
const { AdaptiveDramaKernel } = require("../app/foundry/kernel");
const { WorkbenchStore, atomicWriteJson, defaultProject } = require("../app/workbench-store");
const { relocateCopiedWorkbenchData } = require("../app/foundry/storage-relocation");
const { assetUrlForPath, pathFromAssetUrl, realPathWithinRoot } = require("../app/secure-asset-protocol");
const {
  buildNovelTopicBatch,
  rememberTopicBatch,
  topicSignature
} = require("../app/foundry/topic-diversity");

function projectFixture(overrides = {}) {
  return {
    id: "foundry-v2-fixture",
    title: "门外那只旧布鞋",
    status: "ready",
    currentStage: "storyboard",
    productionRevision: "rev-story-001",
    productionPlan: {
      inputMode: "manual",
      executionMode: "full",
      scriptFormat: "production",
      scriptHandling: "respect",
      commerceMode: "none",
      priorityProfile: "balanced"
    },
    product: { name: "", sellingPoints: "" },
    generation: { targetDurationSeconds: 40, aspectRatio: "9:16" },
    script: {
      raw: [
        "# 人物介绍",
        "林姨：62岁，母亲。",
        "制作备注：开头配BGM，显示字幕和人物介绍。",
        "## SC01 门厅 0-20秒",
        "林姨按住门，把缴费单递给周敏。",
        "林姨：你先看完日期，再说我骗你。",
        "周敏翻到背面，发现签名不是母亲的。",
        "## SC02 调解室 20-40秒",
        "周敏把流水拍在桌上，逼迫者当场沉默。",
        "周敏：这笔钱今天必须一分不少地还回来。",
        "调解员签下归还协议，母女一起走出门。"
      ].join("\n")
    },
    characters: [
      { id: "C01", name: "林姨" },
      { id: "C02", name: "周敏" }
    ],
    scenes: [
      { id: "SC01", name: "门厅" },
      { id: "SC02", name: "调解室" }
    ],
    shots: [
      { id: "S01", duration: 10, sceneId: "SC01", sourceSceneId: "SC01", action: "林姨后退一步按住门，把缴费单举到周敏眼前", causalLink: "周敏不得不核对日期", mainlineStage: "hook" },
      { id: "S02", duration: 10, sceneId: "SC01", sourceSceneId: "SC01", action: "周敏翻到缴费单背面，用手指停在陌生签名上", causalLink: "怀疑转向真正签字人", mainlineStage: "escalation" },
      { id: "S03", duration: 10, sceneId: "SC02", sourceSceneId: "SC02", action: "周敏把银行流水逐张排开，调解员核对金额", causalLink: "逼迫者无法继续否认", mainlineStage: "reversal" },
      { id: "S04", duration: 10, sceneId: "SC02", sourceSceneId: "SC02", action: "调解员签下归还协议，逼迫者交回银行卡", causalLink: "母女带着协议离开", mainlineStage: "resolution" }
    ],
    candidates: [],
    ideation: { topicHistory: [] },
    ...overrides
  };
}

test("production contract keeps absolute bans above uploaded-document directions", () => {
  const project = projectFixture();
  const contract = compileProductionContract(project, {}, { now: "2026-08-15T00:00:00.000Z" });
  assert.equal(contract.intent.scriptHandling, "respect");
  assert.equal(contract.intent.commerceMode, "none");
  assert.equal(contract.policies.subtitles.allowed, false);
  assert.equal(contract.policies.backgroundMusic.allowed, false);
  assert.equal(contract.policies.characterIntroductionInFinal.allowed, false);
  assert.equal(contract.policies.characterSheet.background.fixedColor, "#E9E9E9");
  assert.equal(assertAbsolutePolicies(contract), true);
  assert.match(contractPromptBlock(contract), /不得出现任何字幕/);
  assert.match(contractPromptBlock(contract), /背景音乐/);
  assert.match(contractPromptBlock(contract), /人物介绍/);

  const tampered = structuredClone(contract);
  tampered.policies.subtitles.allowed = true;
  assert.throws(() => assertAbsolutePolicies(tampered), error => error.code === "FOUNDRY_ABSOLUTE_POLICY_VIOLATION");
});

test("local script understanding treats document instructions as evidence and suppresses conflicting cues", () => {
  const project = projectFixture();
  const contract = compileProductionContract(project);
  project.foundry = { contract };
  const report = buildScriptUnderstanding(project.script.raw, project, { contract, now: "2026-08-15T00:00:00.000Z" });
  assert.equal(report.sourceAuthority.documentDirectionsAreUserRequest, false);
  assert.ok(report.summary.sceneCount >= 2);
  assert.ok(report.summary.dialogueCount >= 2);
  assert.ok(report.summary.characterCount >= 2);
  assert.ok(report.summary.suppressedDirectionCount >= 1);
  assert.ok(report.directions.forbidden.every(item => item.resolution === "preserve_as_source_evidence_but_exclude_from_generated_media"));
});

test("compound scene headings stay split while transition notes never become characters", () => {
  const project = projectFixture();
  project.script.raw = [
    "【场景】高档公寓客厅",
    "秦深：先把门关上。",
    "【场景】大平层公寓走廊 -> 集团总裁办",
    "（转场：宽大的总裁办公桌前）",
    "小李：房产证取出来了。",
    "【场景】机场免税店 / 豪华公寓门口",
    "（机器发出刺耳的滴滴声：余额不足）",
    "收银员：余额不足。",
    "【场景】集团总部 / 总裁办公室",
    "看房大妈：合同已经签了。"
  ].join("\n");
  const contract = compileProductionContract(project);
  project.foundry = { contract };
  const report = buildScriptUnderstanding(project.script.raw, project, { contract });
  assert.deepEqual(report.scenes.catalogue.map(item => item.name), ["高档公寓客厅", "大平层公寓走廊", "总裁办公室", "机场免税店", "豪华公寓门口", "集团总部"]);
  assert.ok(report.scenes.occurrences.some(item => item.sceneName === "总裁办公室"));
  assert.equal(report.scenes.catalogue.some(item => /\/|->/.test(item.name)), false);
  assert.deepEqual(report.cast.names.sort(), ["小李", "收银员", "看房大妈", "秦深"].sort());
});

test("compiler-version changes invalidate stale scene semantics even when the raw script is unchanged", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-foundry-understanding-version-"));
  const kernel = new AdaptiveDramaKernel({ rootDir: temp });
  t.after(() => {
    kernel.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const project = projectFixture({
    generation: { targetDurationSeconds: 20, aspectRatio: "9:16" },
    script: {
      raw: [
        "全片20秒。",
        "唯一场景固定：SC01旧宅客厅，雨夜。",
        "S01【0-10秒｜旧宅客厅｜林娜近景切秦添反应】林娜按住信封：你凭什么烧掉它？",
        "S02【10-20秒｜同一客厅｜秦添反打近景切林娜反应】秦添松手：是我错怪了她。"
      ].join("\n")
    },
    scenes: [{ id: "SRC_SC001", name: "旧宅客厅" }],
    shots: [
      { id: "S01", duration: 10, sceneId: "SRC_SC001", sourceSceneId: "SRC_SC001", action: "林娜按住信封质问", causalLink: "秦添被迫停手", mainlineStage: "hook" },
      { id: "S02", duration: 10, sceneId: "SRC_SC001", sourceSceneId: "SRC_SC001", action: "秦添松手承认误会", causalLink: "信封回到林娜手中", mainlineStage: "resolution" }
    ]
  });
  const contract = compileProductionContract(project);
  project.foundry = { contract };
  const current = buildScriptUnderstanding(project.script.raw, project, { contract });
  assert.equal(current.scenes.catalogue.length, 1);
  project.script.sourceSceneLedger = current.scenes;
  project.foundry.scriptUnderstanding = {
    ...current,
    version: "foundry.script-understanding.v1",
    contractFingerprint: contract.fingerprint,
    scenes: {
      ...current.scenes,
      catalogue: [
        { id: "SRC_SC001", name: "0-10秒" },
        { id: "SRC_SC002", name: "旧宅客厅" },
        { id: "SRC_SC003", name: "整段动作误识别场景" }
      ]
    }
  };
  const prepared = kernel.prepareProject(project, { settings: {} });
  assert.equal(prepared.understanding.version, SCRIPT_UNDERSTANDING_VERSION);
  assert.deepEqual(prepared.understanding.scenes.catalogue.map(item => item.name), ["旧宅客厅"]);
  assert.equal(prepared.quality.levels.story.issues.some(item => item.id === "source_scene_coverage"), false);
});

test("quality laboratory blocks policy conflicts and admits a coherent complete story", () => {
  const project = projectFixture();
  const contract = compileProductionContract(project);
  project.foundry = { contract };
  const understanding = buildScriptUnderstanding(project.script.raw, project, { contract });
  const sourceSceneIds = understanding.scenes.catalogue.map(item => item.id);
  project.shots[0].sourceSceneId = sourceSceneIds[0];
  project.shots[1].sourceSceneId = sourceSceneIds[0];
  project.shots[2].sourceSceneId = sourceSceneIds[1];
  project.shots[3].sourceSceneId = sourceSceneIds[1];
  const good = evaluateProject(project, { contract, understanding });
  assert.equal(good.achievedLevel, 3);
  assert.equal(good.paidGenerationAllowed, true);

  const broken = structuredClone(project);
  broken.shots[0].videoPrompt = "添加醒目字幕，并配上背景音乐，再显示人物介绍";
  const blocked = evaluateProject(broken, { contract, understanding });
  assert.equal(blocked.paidGenerationAllowed, false);
  assert.ok(blocked.levels.technical.issues.some(item => item.id === "absolute_media_policy"));
});

test("legacy AI drafts are not misclassified as uploaded-source scene contracts after a mode switch", () => {
  const project = projectFixture();
  project.productionPlan.inputMode = "manual";
  project.script.generatedFromTopicId = "TOPIC_03";
  const contract = compileProductionContract(project);
  project.foundry = { contract };
  const understanding = buildScriptUnderstanding(project.script.raw, project, { contract });
  assert.equal(understanding.sourceAuthority.level, "model_authored_draft");
  const report = evaluateProject(project, { contract, understanding });
  assert.equal(report.levels.story.issues.some(item => item.id === "source_scene_coverage"), false);
  assert.equal(report.paidGenerationAllowed, true);
});

test("asset passports bind exactly one current candidate and never allow identity cards into the final film", () => {
  const project = projectFixture({
    candidates: [
      { id: "sheet-old", entityType: "character", entityId: "C01", stage: "character_sheet", remoteUrl: "https://example.invalid/old.png", selected: false, updatedAt: "2026-08-14T00:00:00.000Z", qualityAudit: { uniformBackground: true } },
      { id: "sheet-new", entityType: "character", entityId: "C01", stage: "character_sheet", remoteUrl: "https://example.invalid/new.png", selected: true, updatedAt: "2026-08-15T00:00:00.000Z", qualityAudit: { uniformBackground: true } },
      { id: "intro", entityType: "character", entityId: "C01", stage: "character_intro", remoteUrl: "https://example.invalid/intro.png", selected: true, updatedAt: "2026-08-15T00:00:00.000Z" }
    ]
  });
  const contract = compileProductionContract(project);
  const { passports, bindings } = buildAssetPassports(project, contract);
  assert.equal(passports.filter(item => item.bindingKey === "character:C01:character_sheet" && item.active).length, 1);
  assert.match(bindings["character:C01:character_sheet"], /passport_/);
  assert.ok(passports.find(item => item.candidateId === "intro").downstream.forbidden.includes("final_video"));
  assert.match(assetPromptPolicy("character_sheet", contract), /#E9E9E9/);
  assert.match(assetPromptPolicy("character_sheet", contract), /无肖像大头/);
});

test("transactional runtime preserves revisions, audit history, and retryable operations", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-foundry-v2-"));
  const runtime = new FoundryRuntimeStore(temp);
  t.after(() => {
    runtime.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const first = projectFixture();
  const commit1 = runtime.commitProject(first, { eventType: "project.test_created" });
  const second = structuredClone(first);
  second.title = "门外那只旧布鞋·修订版";
  const commit2 = runtime.commitProject(second, { eventType: "project.test_saved" });
  assert.equal(commit1.revision, 1);
  assert.equal(commit2.revision, 2);
  assert.equal(runtime.loadRevision(first.id, 1).title, first.title);
  assert.equal(runtime.loadProject(first.id).title, second.title);

  const operation = runtime.beginOperation({ projectId: first.id, kind: "generate.asset", targetId: "C01", inputFingerprint: "same-input" });
  const failure = runtime.failOperation(operation.operationKey, new FoundryError("provider timeout", { code: "PROVIDER_TIMEOUT", kind: ERROR_KINDS.PROVIDER_TRANSIENT, retryable: true }));
  assert.equal(failure.status, "failed");
  const resumed = runtime.beginOperation({ projectId: first.id, kind: "generate.asset", targetId: "C01", inputFingerprint: "same-input" });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.attempts, 2);
  assert.equal(runtime.finishOperation(operation.operationKey, { assetId: "asset-1" }).status, "completed");
  assert.equal(runtime.health().ok, true);
  assert.ok(runtime.listAuditEvents(first.id).length >= 6);
});

test("ordinary project snapshots are bounded while important revisions remain loadable", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-foundry-retention-"));
  const runtime = new FoundryRuntimeStore(temp);
  t.after(() => {
    runtime.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const project = projectFixture({ id: "revision-retention-fixture" });
  runtime.commitProject(project, { eventType: "project.created" });
  for (let index = 1; index <= PROJECT_SAVED_REVISION_LIMIT + 7; index += 1) {
    project.status = `saved-${index}`;
    runtime.commitProject(project);
  }

  const savedCount = runtime.db.prepare("SELECT COUNT(*) AS count FROM project_revisions WHERE project_id=? AND event_type='project.saved'").get(project.id).count;
  const importantCount = runtime.db.prepare("SELECT COUNT(*) AS count FROM project_revisions WHERE project_id=? AND event_type<>'project.saved'").get(project.id).count;
  assert.equal(savedCount, PROJECT_SAVED_REVISION_LIMIT);
  assert.equal(importantCount, 1);
  assert.equal(runtime.loadRevision(project.id, 1).title, project.title);
  assert.equal(runtime.loadProject(project.id).status, `saved-${PROJECT_SAVED_REVISION_LIMIT + 7}`);
});

test("workspace project names stay visible when the generated story title changes", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-workspace-title-"));
  const store = new WorkbenchStore(temp);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const initial = defaultProject("新的带货漫剧 19");
  assert.equal(initial.workspaceTitle, "新的带货漫剧 19");
  const created = store.createProject("新的带货漫剧 19");
  const generated = store.getProject(created.id);
  generated.title = "校门口扇耳光";
  store.saveProject(generated);

  assert.equal(store.getProject(created.id).title, "校门口扇耳光");
  assert.equal(store.listProjects().find(item => item.id === created.id)?.title, "新的带货漫剧 19");
});

test("SQLite current state wins over a stale or missing JSON mirror without losing concurrent changes", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-foundry-authority-"));
  const kernel = new AdaptiveDramaKernel({ rootDir: temp });
  const store = new WorkbenchStore(temp, { foundryKernel: kernel });
  t.after(() => {
    kernel.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const created = store.createProject("初始标题", { mode: "keyframe", modeConfirmed: true, inputMode: "manual" });
  const staleMirror = structuredClone(created);
  const current = store.getProject(created.id);
  current.title = "SQLite 权威标题";
  current.status = "assets_ready";
  store.saveProject(current);

  fs.writeFileSync(store.projectPath(created.id), JSON.stringify(staleMirror, null, 2));
  const recovered = store.getProject(created.id);
  assert.equal(recovered.title, "SQLite 权威标题");
  assert.equal(recovered.status, "assets_ready");
  recovered.currentStage = "shots";
  store.saveProject(recovered);
  const healedMirror = JSON.parse(fs.readFileSync(store.projectPath(created.id), "utf8"));
  assert.equal(healedMirror.title, "SQLite 权威标题");
  assert.equal(healedMirror.currentStage, "shots");

  fs.rmSync(store.projectPath(created.id));
  assert.ok(store.listProjects().some(item => item.id === created.id && item.title === "初始标题"));
  assert.equal(store.getProject(created.id).title, "SQLite 权威标题");
  assert.equal(store.getProject(created.id).currentStage, "shots");
});

test("moving the save location rebases SQLite, JSON, file URLs and secure asset URLs while preserving the old copy", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-foundry-relocate-"));
  const sourceRoot = path.join(temp, "source-workbench");
  const targetRoot = path.join(temp, "target-workbench");
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const sourceKernel = new AdaptiveDramaKernel({ rootDir: sourceRoot });
  const sourceStore = new WorkbenchStore(sourceRoot, { foundryKernel: sourceKernel });
  const created = sourceStore.createProject("保存位置迁移", { mode: "keyframe", modeConfirmed: true, inputMode: "manual" });
  const assetDir = path.join(sourceStore.projectDir(created.id), "assets", "characters");
  fs.mkdirSync(assetDir, { recursive: true });
  const sourceAsset = path.join(assetDir, "人物 01#定妆.png");
  fs.writeFileSync(sourceAsset, Buffer.from("real-asset-bytes"));
  const project = sourceStore.getProject(created.id);
  project.candidates = [{
    id: "character-current",
    entityType: "character",
    entityId: "C01",
    stage: "character_sheet",
    selected: true,
    filePath: sourceAsset,
    fileUrl: pathToFileURL(sourceAsset).href,
    previewUrl: assetUrlForPath(sourceAsset),
    source: "manual",
    qualityAudit: { ok: true, uniformBackground: true }
  }];
  sourceStore.saveProject(project);
  const reusableIndex = path.join(sourceRoot, "reusable-asset-library", "index.json");
  atomicWriteJson(reusableIndex, { version: 1, assets: [{ id: "shared", filePath: sourceAsset, fileUrl: pathToFileURL(sourceAsset).href }] });
  sourceKernel.runtime.checkpoint();
  sourceKernel.close();

  fs.cpSync(sourceRoot, targetRoot, { recursive: true, force: false, errorOnExist: true });
  const targetKernel = new AdaptiveDramaKernel({ rootDir: targetRoot });
  const relocation = relocateCopiedWorkbenchData({ sourceRoot, targetRoot, kernel: targetKernel, writeJson: atomicWriteJson });
  const moved = targetKernel.loadProject(created.id);
  targetKernel.close();

  const expectedAsset = path.join(targetRoot, path.relative(sourceRoot, sourceAsset));
  assert.equal(relocation.criticalSkippedJson.length, 0);
  assert.ok(relocation.projectReplacements >= 3);
  assert.equal(moved.candidates[0].filePath, expectedAsset);
  assert.equal(pathFromAssetUrl(moved.candidates[0].previewUrl), expectedAsset);
  assert.equal(realPathWithinRoot(expectedAsset, targetRoot), fs.realpathSync.native(expectedAsset));
  assert.equal(fs.existsSync(sourceAsset), true, "old data must remain intact for rollback");
  assert.equal(fs.existsSync(expectedAsset), true);
  const movedLibrary = JSON.parse(fs.readFileSync(path.join(targetRoot, "reusable-asset-library", "index.json"), "utf8"));
  assert.equal(movedLibrary.assets[0].filePath, expectedAsset);
  assert.equal(JSON.parse(fs.readFileSync(path.join(targetRoot, "projects", created.id, "project.json"), "utf8")).candidates[0].filePath, expectedAsset);
});

test("an existing reusable asset index is authoritative and never triggers an all-project startup rescan", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "puream-foundry-library-authority-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const filePath = path.join(temp, "reusable-asset-library", "files", "character.png");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from("indexed-character"));
  atomicWriteJson(path.join(temp, "reusable-asset-library", "index.json"), {
    version: 1,
    assets: [{ id: "indexed", kind: "character", mediaType: "image", filePath, updatedAt: new Date().toISOString() }]
  });
  const store = new WorkbenchStore(temp);
  store.syncReusableAssetLibraryFromProjects = () => { throw new Error("existing authoritative index must not rescan projects"); };
  assert.equal(store.reusableAssetLibraryHydrated, true);
  assert.deepEqual(store.listReusableAssets("character").map(item => item.id), ["indexed"]);

  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.match(renderer, /listReusableAssets\(requestedKind\)/);
  assert.match(renderer, /loading="lazy" decoding="async"/);
  assert.match(renderer, /preload="none"/);
  assert.match(renderer, /candidate\?\.filePath && placeholder !== "audio"/);
});

test("every repeated one-click topic request produces a fresh ten-topic batch", () => {
  const project = projectFixture({ ideation: { topicHistory: [] } });
  const allTitles = new Set();
  const allSignatures = new Set();
  for (let index = 1; index <= 20; index += 1) {
    const { topics } = buildNovelTopicBatch(project, index, { nonce: `regression-${index}` });
    assert.equal(topics.length, 10);
    for (const topic of topics) {
      assert.equal(allTitles.has(topic.title), false, `duplicate title: ${topic.title}`);
      assert.equal(allSignatures.has(topicSignature(topic)), false, `duplicate signature: ${topic.title}`);
      allTitles.add(topic.title);
      allSignatures.add(topicSignature(topic));
    }
    rememberTopicBatch(project, topics, "test");
  }
  assert.equal(allTitles.size, 200);
  assert.equal(project.ideation.topicHistory.length, 200);
});

test("existing dialogs expose the three V2 intent controls without adding a new workflow", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "app", "renderer", "workbench.js"), "utf8");
  for (const id of ["newScriptHandling", "newCommerceMode", "newPriorityProfile", "projectScriptHandling", "projectCommerceMode", "projectPriorityProfile"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.match(renderer, new RegExp(`#${id}`));
  }
  for (const value of ["respect", "optimize", "recreate", "none", "natural", "explicit", "speed", "balanced", "quality"]) {
    assert.match(html, new RegExp(`value=["']${value}["']`));
  }
  assert.match(html, /绝对禁令始终不可关闭/);
});
