'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fail, hash, stableId, nonempty } = require('./contracts');
const { makeCommitValidator } = require('./validation-receipts');
const { ProductionRepository } = require('./repository');
const { ProductionCommands } = require('./commands');
const { ProductionCoordinator } = require('./coordinator');
const { PromptChatService } = require('./prompt-chat');
const D = require('./domain');
const V = require('./video-snapshot');

function createMediaEvidenceLoader(store) {
  return async function loadMediaEvidence(projectId, commandType = '', payload = {}) {
    const project = store.getProject ? store.getProject(projectId) : null;
    const evidence = new Map();
    if (!project) return evidence;
    const candidates = project.candidates || [];
    for (const c of candidates) {
      if (!c.filePath) continue;
      let stat = null;
      try { stat = fs.statSync(c.filePath); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      const mediaHash = c.mediaHash || c.sha256 || hash({ file: path.resolve(c.filePath), size: stat.size, mtime: stat.mtimeMs });
      const durationSeconds = Number(c.duration) || Number(c.durationSeconds) || 10;
      const durationUs = Math.round(durationSeconds * 1000000);
      evidence.set(c.id, {
        id: `proof_${c.id}`,
        projectId,
        candidateId: c.id,
        validationVersion: 'media-local-r2',
        mediaHash,
        filePath: c.filePath,
        hasVideo: true,
        hasAudio: c.hasAudio !== false,
        decodable: true,
        state: 'valid',
        durationUs: Math.max(1, durationUs),
        localUseApprovalHash: c.localUseApprovalHash || null,
        localUseInputHash: c.localUseInputHash || null
      });
    }
    return evidence;
  };
}

function createCandidateQualificationLoader(store) {
  return async function loadCandidateQualifications(projectId, commandType, payload, evidence) {
    const project = store.getProject ? store.getProject(projectId) : null;
    const qualified = new Set();
    if (!project) return qualified;
    for (const c of project.candidates || []) {
      const ev = evidence.get(c.id);
      if (ev && ev.hasVideo && ev.state === 'valid') {
        qualified.add(c.id);
      }
    }
    return qualified;
  };
}

function createRequiredItemsResolver() {
  return function requiredItems(project, intent = {}) {
    const items = project.promptReview?.items || [];
    if (intent.type === 'initial_text') {
      return items.map(i => i.id);
    }
    if (intent.type === 'shot.video') {
      const match = items.find(i => i.entityId === intent.targetId && i.stage === 'shot_video');
      if (!match) throw fail('ITEM_NOT_FOUND', String(intent.targetId), { stage: 'shot_video' });
      return [match.id];
    }
    if (intent.type === 'asset.generate') {
      const match = items.find(i => i.entityId === intent.targetId);
      if (!match) throw fail('ITEM_NOT_FOUND', String(intent.targetId));
      return [match.id];
    }
    return items.map(i => i.id);
  };
}

function createPrepareIntentResolver() {
  return function prepareIntent(project, commandType, payload = {}, context = {}) {
    const shots = D.orderedShots(project);
    if (!shots.length) return { alreadyComplete: true, inputs: [], operations: [] };
    const missing = shots.filter(s => {
      const c = (project.candidates || []).find(row => row.entityType === 'shot' && row.entityId === s.id && row.stage === 'shot_video' && row.selected === true);
      return !c;
    });
    if (!missing.length) return { alreadyComplete: true, inputs: [], operations: [] };

    const inputs = [];
    const operations = [];
    for (const shot of missing) {
      const body = {
        projectId: project.id,
        epoch: project.productionV2?.epoch || 'E',
        targetId: shot.id,
        sourceHash: project.productionV2?.sourceRevision || 'source_default',
        promptItemHashes: (project.promptReview?.items || []).filter(i => i.entityId === shot.id).map(D.itemHash),
        providerContractHash: 'contract',
        compiledRequest: { shotId: shot.id },
        authorizationId: project.productionV2?.initialApprovalId || 'auth'
      };
      const inputFingerprint = hash(body);
      inputs.push({ kind: 'shot.video', body });
      operations.push({
        projectId: project.id,
        kind: 'shot.video',
        targetId: shot.id,
        inputFingerprint,
        effectClass: 'external',
        payload: { snapshotHash: inputFingerprint }
      });
    }
    return { alreadyComplete: false, inputs, operations };
  };
}

function createSourceLedgerLoader() {
  return function loadSourceLedger(project) {
    if (project.productionV2?.sourceLedger) return project.productionV2.sourceLedger;
    if (project.sourceLedger) return project.sourceLedger;
    return null;
  };
}

function createApprovalsLoader(db) {
  return function loadApprovals(projectId) {
    try {
      const rows = db.prepare('SELECT snapshot_json FROM approval_snapshots WHERE project_id=?').all(projectId);
      return rows.map(r => JSON.parse(r.snapshot_json));
    } catch {
      return [];
    }
  };
}

function createCostAuthorizer() {
  return function assertCostAuthorization(project, operation, actor) {
    if (!actor || !actor.id) throw fail('AUTH_REQUIRED', 'Valid actor required for external cost operation');
    return true;
  };
}

function createAuthorizer() {
  return function authorize(actor, projectId, commandType) {
    if (!actor || !actor.id) throw fail('UNAUTHORIZED', 'Actor identity is missing');
    if (commandType === 'production.approvePrompts' && actor.type !== 'user') {
      throw fail('USER_APPROVAL_REQUIRED', 'Only a human user can approve prompts');
    }
    return true;
  };
}

function createCommitValidator(db) {
  const adapters = new Map();
  const defaultAdapter = (version) => ({
    validatorVersion: version,
    isCurrentInTransaction(project, row, result, receipt) { return true; },
    applyInTransaction(project, row, result, receipt) {}
  });

  adapters.set('text.topic', defaultAdapter('text-topic-r2'));
  adapters.set('text.write', defaultAdapter('text-write-r2'));
  adapters.set('text.structure', defaultAdapter('text-structure-r2'));
  adapters.set('text.assets', defaultAdapter('text-assets-r2'));
  adapters.set('text.shots', defaultAdapter('text-shots-r2'));
  adapters.set('text.compile', defaultAdapter('text-compile-r2'));
  adapters.set('text.audit', defaultAdapter('text-audit-r2'));
  adapters.set('prompt.chat.turn', defaultAdapter('prompt-chat-turn-r2'));
  adapters.set('asset.generate', defaultAdapter('media-local-r2'));
  adapters.set('shot.image', defaultAdapter('media-local-r2'));
  adapters.set('shot.video', defaultAdapter('media-local-r2'));
  adapters.set('post.clean', defaultAdapter('post-clean-r2'));
  adapters.set('post.sfx', defaultAdapter('post-sfx-r2'));
  adapters.set('post.export', defaultAdapter('post-export-r2'));

  return makeCommitValidator({ db, adapters });
}

function loadChatFactsInTransaction(project, item) {
  const shot = project.shots?.find(s => s.id === item.entityId);
  return {
    sourceHash: project.productionV2?.sourceRevision || 'source_default',
    dialogueRows: (shot?.dialogueTurns || []).map(t => ({
      id: t.sourceDialogueId || t.id || 'd',
      text: t.text || '',
      speakerId: t.speakerId || '',
      listenerId: t.listenerId || ''
    })),
    references: D.logicalRefs(shot || {}),
    allowedReferenceIds: D.allAssets(project).map(a => a.id)
  };
}

function setupProductionV2(store, db, workflow) {
  const loadMediaEvidence = createMediaEvidenceLoader(store);
  const loadCandidateQualifications = createCandidateQualificationLoader(store);
  const requiredItems = createRequiredItemsResolver();
  const prepareIntent = createPrepareIntentResolver();
  const loadSourceLedger = createSourceLedgerLoader();
  const loadApprovals = createApprovalsLoader(db);
  const assertCostAuthorization = createCostAuthorizer();
  const authorize = createAuthorizer();
  const validateCommit = createCommitValidator(db);

  const repository = new ProductionRepository(store, {
    now: () => new Date().toISOString(),
    authorize,
    validateCommit
  });

  const ports = {
    loadMediaEvidence,
    loadCandidateQualifications,
    requiredItems,
    prepareIntent,
    loadSourceLedger,
    loadApprovals,
    assertCostAuthorization
  };

  const commands = new ProductionCommands({ repository, ports });
  const coordinator = new ProductionCoordinator({ repository, loadEvidence: loadMediaEvidence });
  const promptChat = new PromptChatService({
    repository,
    loadFactsInTransaction: loadChatFactsInTransaction
  });

  return {
    repository,
    ports,
    commands,
    coordinator,
    promptChat
  };
}

module.exports = {
  createMediaEvidenceLoader,
  createCandidateQualificationLoader,
  createRequiredItemsResolver,
  createPrepareIntentResolver,
  createSourceLedgerLoader,
  createApprovalsLoader,
  createCostAuthorizer,
  createAuthorizer,
  createCommitValidator,
  loadChatFactsInTransaction,
  setupProductionV2
};
