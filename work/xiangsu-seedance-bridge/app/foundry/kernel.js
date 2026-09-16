"use strict";

const { applyAssetPassports } = require("./asset-passport");
const { fingerprint, sha256 } = require("./canonical");
const { ERROR_KINDS, FoundryError } = require("./errors");
const { applyProductionContract, assertAbsolutePolicies } = require("./production-contract");
const { evaluateProject } = require("./quality-lab");
const { FoundryRuntimeStore } = require("./runtime-store");
const { SCRIPT_UNDERSTANDING_VERSION, buildScriptUnderstanding } = require("./script-understanding");

function productionSourceFingerprint(project = {}) {
  const shotFields = shot => ({
    id: shot?.id,
    number: shot?.number,
    duration: shot?.duration,
    sceneId: shot?.sceneId,
    sourceSceneId: shot?.sourceSceneId,
    sceneName: shot?.sceneName || shot?.scene,
    characterIds: shot?.characterIds || [],
    visibleCharacterIds: shot?.visibleCharacterIds || [],
    scenePresenceCharacterIds: shot?.scenePresenceCharacterIds || [],
    speakerIds: shot?.speakerIds || [],
    action: shot?.action,
    visualBeat: shot?.visualBeat,
    performance: shot?.performance,
    stateBefore: shot?.stateBefore,
    stateAfter: shot?.stateAfter,
    causalLink: shot?.causalLink,
    transitionReason: shot?.transitionReason,
    dialogue: shot?.dialogue,
    dialogueTurns: shot?.dialogueTurns || [],
    sourceDialogueIds: shot?.sourceDialogueIds || [],
    sourceDialogueBindings: shot?.sourceDialogueBindings || [],
    subshots: shot?.subshots || [],
    propBindings: shot?.propBindings || [],
    wardrobeBindings: shot?.wardrobeBindings || []
  });
  return fingerprint({
    characters: (project?.characters || []).map(item => ({
      id: item?.id,
      name: item?.name,
      description: item?.description,
      role: item?.role,
      identity: item?.identity,
      wardrobe: item?.wardrobe,
      outfits: item?.outfits || []
    })),
    scenes: (project?.scenes || []).map(item => ({
      id: item?.id,
      name: item?.name,
      description: item?.description,
      time: item?.time,
      layout: item?.layout
    })),
    shots: (project?.shots || []).map(shotFields),
    sourceDialogueLedger: project?.script?.sourceDialogueLedger || project?.sourceDialogueLedger || [],
    sourceSceneLedger: project?.script?.sourceSceneLedger || null,
    productionPlan: project?.productionPlan || {},
    product: project?.product || {},
    generation: {
      mode: project?.generation?.mode,
      targetDurationSeconds: project?.generation?.targetDurationSeconds,
      aspectRatio: project?.generation?.aspectRatio
    }
  });
}

class AdaptiveDramaKernel {
  constructor(options = {}) {
    this.runtime = options.runtime || new FoundryRuntimeStore(options.rootDir, options.runtimeOptions);
    this.settingsProvider = typeof options.settingsProvider === "function" ? options.settingsProvider : () => ({});
  }

  settings() {
    try { return this.settingsProvider() || {}; } catch { return {}; }
  }

  prepareProject(project, options = {}) {
    if (!project?.id) return { project, contract: null, understanding: null, quality: null, passports: [] };
    const contract = applyProductionContract(project, options.settings || this.settings(), { source: options.source || "kernel", now: options.now });
    assertAbsolutePolicies(contract);
    const source = String(project.script?.raw || "");
    let understanding = project.foundry?.scriptUnderstanding || null;
    if (source.trim()) {
      const sourceFingerprint = fingerprint(source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
      const sourceRawSha256 = sha256(source);
      const structuredFingerprint = productionSourceFingerprint(project);
      if (options.forceUnderstanding
        || understanding?.version !== SCRIPT_UNDERSTANDING_VERSION
        || understanding?.sourceFingerprint !== sourceFingerprint
        || understanding?.productionSourceFingerprint !== structuredFingerprint
        || understanding?.contractFingerprint !== contract.fingerprint) {
        const userAuthored = project.productionPlan?.inputMode === "manual" && !String(project.script?.generatedFromTopicId || "").trim();
        const sourceSceneLedger = userAuthored && project.script?.sourceSceneLedger?.explicit
          ? project.script.sourceSceneLedger
          : undefined;
        const sourceDialogueLedger = userAuthored
          && project.script?.sourceFingerprint
          && project.script.sourceFingerprint === sourceRawSha256
          && Array.isArray(project.script?.sourceDialogueLedger)
          ? project.script.sourceDialogueLedger
          : undefined;
        understanding = buildScriptUnderstanding(source, project, {
          contract,
          now: options.now,
          sceneLedger: sourceSceneLedger,
          dialogueLedger: sourceDialogueLedger
        });
        understanding.contractFingerprint = contract.fingerprint;
        understanding.productionSourceFingerprint = structuredFingerprint;
      }
    } else {
      understanding = null;
    }
    const { passports, bindings } = applyAssetPassports(project, contract);
    const quality = source.trim() ? evaluateProject(project, { contract, understanding }) : null;
    project.foundry = {
      ...(project.foundry || {}),
      version: 2,
      engine: "PUREAM Adaptive Drama Compiler",
      scriptUnderstanding: understanding,
      quality,
      activeBindings: bindings,
      updatedAt: String(options.now || new Date().toISOString())
    };
    return { project, contract, understanding, quality, passports };
  }

  commitProject(project, context = {}) {
    const prepared = this.prepareProject(project, context);
    const committed = this.runtime.commitProject(project, context);
    project.foundry.runtimeRevision = committed.revision;
    project.foundry.runtimeSnapshotSha256 = committed.snapshotSha256;
    this.runtime.syncAssetPassports(project.id, prepared.passports);
    return { ...prepared, committed };
  }

  importLegacyProject(project) {
    if (!project?.id) return null;
    const current = this.runtime.loadProject(project.id);
    if (current) return current;
    this.commitProject(project, { eventType: "project.legacy_imported", actor: "migration", source: "legacy_json" });
    return project;
  }

  loadProject(projectId) {
    const project = this.runtime.loadProject(projectId);
    if (!project) return null;
    const row = this.runtime.projectRow(projectId);
    project.foundry = {
      ...(project.foundry || {}),
      runtimeRevision: Number(row?.revision) || 0,
      runtimeSnapshotSha256: String(row?.snapshot_sha256 || "")
    };
    return project;
  }

  deleteProject(projectId) {
    return this.runtime.deleteProject(projectId);
  }

  beginOperation(project, operation, targetId = "", payload = {}) {
    const contractFingerprint = String(project?.foundry?.contract?.fingerprint || "");
    const inputFingerprint = fingerprint({
      projectId: project?.id,
      runtimeRevision: project?.foundry?.runtimeRevision || this.runtime.projectRow(project?.id)?.revision || 0,
      productionRevision: project?.productionRevision || "",
      sourceFingerprint: project?.script?.sourceFingerprint || project?.foundry?.scriptUnderstanding?.sourceFingerprint || "",
      operation,
      targetId,
      generationIndex: project?.ideation?.generationIndex || 0,
      payload
    });
    return this.runtime.beginOperation({ projectId: project?.id, kind: operation, targetId, inputFingerprint, contractFingerprint, payload });
  }

  finishOperation(handle, result = {}) {
    if (!handle?.operationKey) return null;
    return this.runtime.finishOperation(handle.operationKey, result);
  }

  failOperation(handle, error) {
    if (!handle?.operationKey) return null;
    return this.runtime.failOperation(handle.operationKey, error);
  }

  saveCheckpoint(projectId, handle, stage, key, state, status = "ready") {
    if (!handle?.operationKey) return null;
    return this.runtime.saveCheckpoint({ projectId, operationKey: handle.operationKey, stage, key, state, status });
  }

  assertPaidGenerationReady(project, stage = "assets") {
    const prepared = this.prepareProject(project, { source: `preflight:${stage}` });
    const report = prepared.quality;
    // Kept as a compatibility entry point for existing callers.  Foundry no
    // longer uses a subjective/creative score as an authorization system.
    // The report remains attached for prompt improvement and traceability;
    // concrete requirements are checked by the stage that actually needs them.
    if (report) {
      report.preflightStage = stage;
      report.preflightDecision = report.paidGenerationAllowed ? "continue" : "continue_with_stage_preflight";
    }
    return prepared;
  }

  health() {
    return this.runtime.health();
  }

  close() {
    this.runtime.close();
  }
}

module.exports = { AdaptiveDramaKernel, productionSourceFingerprint };
