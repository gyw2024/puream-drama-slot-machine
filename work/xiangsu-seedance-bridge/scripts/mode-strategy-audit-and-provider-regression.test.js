"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BridgeClient } = require("../app/bridge-client");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, isQualityGatesEnabled } = require("../app/workbench-workflow");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("an unconfigured audit blueprint never enables any blocker", () => {
  const root = temporaryDirectory("puream-explicit-audit-");
  try {
    const settings = new WorkbenchStore(root).getSettings();
    assert.equal(settings.generation.qualityGatesEnabled, false);
    assert.equal(Object.values(settings.generation.qualityGateModules).some(Boolean), false);
    assert.equal(Object.values(settings.generation.blueprintAuditChecks).some(Boolean), false);
    for (const moduleName of ["script", "assets", "storyboards", "videos", "delivery"]) {
      assert.equal(isQualityGatesEnabled({}, moduleName), false);
      assert.equal(isQualityGatesEnabled({ generation: { qualityGatesEnabled: true } }, moduleName), false);
      assert.equal(isQualityGatesEnabled(settings, moduleName), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new-project and project-strategy contracts expose all three script modes and examples", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  for (const scope of ["newScriptFormat", "projectScriptFormat"]) {
    for (const format of ["production", "dialogue", "timed_storyboard"]) {
      assert.match(html, new RegExp(`name="${scope}" value="${format}"`));
    }
  }
  assert.match(renderer, /scriptFormatConfirmed: inputMode === "ai"/);
  assert.match(renderer, /scriptFormatConfirmed: nextInputMode === "ai"/);
  assert.match(renderer, /plan\.inputMode === "manual" \|\| plan\.scriptFormatConfirmed === true/);
  assert.match(renderer, /const firstExplicitEnable = enabled/);
  assert.ok((html.match(/data-script-format-example=/g) || []).length >= 9);
  assert.doesNotMatch(html, /id="qualityBlueprintMaster"[^>]*\schecked/);
  assert.doesNotMatch(html, /data-quality-module="[^"]+"[^>]*\schecked/);
  assert.doesNotMatch(html, /data-blueprint-check="[^"]+"[^>]*\schecked/);
});

test("an explicit 云端算力节点 quarantine response is preserved instead of mislabeled as an unknown submission", async () => {
  const root = temporaryDirectory("puream-cloud-node-code-");
  try {
    const client = new BridgeClient({
      tokenPath: path.join(root, "bridge-token"),
      fetchImpl: async () => jsonResponse({ code: "PROVIDER_QUARANTINED", message: "云端算力节点 服务已隔离" }, 503)
    });
    client.configure({ kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", apiKey: "test-activation", hailuoApiMode: "text_to_video" });
    await assert.rejects(() => client.submit({
      providerKind: "puream-hailuo-h3",
      clientRequestId: "quarantine-contract-test",
      prompt: "A person speaks to camera.",
      duration: 5,
      hailuoApiMode: "text_to_video",
      aspectRatio: "9:16",
      images: [], videos: [], videoAudios: [], audios: [],
      outputDir: root
    }), error => {
      assert.equal(error.code, "PROVIDER_QUARANTINED");
      assert.equal(error.remoteSubmissionUnknown, undefined);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("character-video and voice prerequisites follow the selected project engine", () => {
  const root = temporaryDirectory("puream-character-provider-matrix-");
  try {
    const store = new WorkbenchStore(root);
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
    const local = store.createProject("本地像塑", { engine: "seedance", mode: "keyframe" });
    store.patchProject(local.id, { characters: [{ id: "C01", name: "林梅" }], generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true } });
    const localKinds = workflow.buildAssetBatchPlan(local.id).map(item => item.kind);
    assert.equal(localKinds.includes("character_video"), false);
    assert.equal(localKinds.includes("character_voice"), false);

    const cloud = store.createProject("云端算力", { engine: "hailuo-h3", mode: "storyboard_sheet" });
    store.patchProject(cloud.id, { characters: [{ id: "C01", name: "林梅" }], generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true } });
    const cloudKinds = workflow.buildAssetBatchPlan(cloud.id).map(item => item.kind);
    assert.equal(cloudKinds.includes("character_video"), true);
    assert.equal(cloudKinds.includes("character_voice"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a recoverable character-video outage does not block independent visual assets", async () => {
  const root = temporaryDirectory("puream-asset-dependency-");
  try {
    const store = new WorkbenchStore(root);
    const settings = store.getSettings();
    settings.videoProvider = { ...settings.videoProvider, kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", model: "hailuo-h3", apiKey: "" };
    store.saveSettings(settings);
    const created = store.createProject("依赖分层", { engine: "hailuo-h3", mode: "smart" });
    store.patchProject(created.id, {
      characters: [{ id: "C01", name: "林梅" }],
      generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "smart", modeConfirmed: true }
    });
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
    workflow.ensureProjectShotScenes = () => {};
    workflow.syncReferenceLibraries = () => ({});
    workflow.reconcileProductionContracts = () => ({ ok: true });
    const addImage = (stage, entityId) => {
      const filePath = path.join(root, `${stage}-${entityId}.png`);
      fs.writeFileSync(filePath, Buffer.from("image"));
      return store.addCandidate(created.id, { entityType: "character", entityId, stage, filePath, qualityAudit: { ok: false } });
    };
    workflow.generateImageCandidate = async (_projectId, stage, entityId) => addImage(stage, entityId);
    workflow.ensureCharacterIntroCandidate = async (_projectId, entityId) => addImage("character_intro", entityId);
    workflow.generateQualityCharacterVideo = async () => {
      throw Object.assign(new Error("云端算力节点 服务已隔离"), { code: "PROVIDER_QUARANTINED" });
    };
    const results = await workflow.generateAllAssets(created.id, { track: false });
    assert.ok(results.some(item => item.stage === "character_sheet"));
    assert.ok(results.some(item => item.stage === "character_intro"));
    const progress = store.getProject(created.id).automation.progress;
    assert.equal(progress.items.find(item => item.kind === "character_video").status, "queued");
    assert.equal(progress.items.find(item => item.kind === "character_voice").status, "queued");
    assert.equal(progress.failed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
