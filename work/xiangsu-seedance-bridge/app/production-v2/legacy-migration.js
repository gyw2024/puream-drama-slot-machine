'use strict';
// T18 / §14.1: legacy project migration. Never damages existing projects:
// classify → back up → migrate in place with a manifest → re-run verifies
// instead of regenerating identity.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LEGACY_APPROVAL_STATES = Object.freeze(['legacy_imported', 'authorized_media', 'review_ready']);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// §14.1: three legacy realities.
//  - Real human confirmation records + media production → import the approval
//    evidence as legacy_imported and keep the actual content references.
//  - Videos exist but no reliable approval record → local preview/rough-cut/
//    export stay allowed; future PAID generation needs scoped authorization.
//  - Nothing produced and prompts pending → review_ready; the new gate shows
//    exactly once.
function classifyLegacyProject(project = {}) {
  const userConfirmed = project.promptReview?.items?.some(item =>
    item.userConfirmed === true || item.userConfirmedAt || item.confirmedBy === 'user');
  const hasMedia = (project.shots || []).some(shot =>
    ['shot_video', 'storyboard_sheet', 'storyboard_start', 'storyboard_end']
      .some(stage => (project.candidates || []).some(c => c.entityId === shot.id && c.stage === stage && c.status === 'completed')) ||
    (project.candidates || []).some(c => c.entityType === 'asset' && c.status === 'completed'));
  if (userConfirmed && hasMedia) return 'legacy_imported';
  if (hasMedia) return 'authorized_media';
  return 'review_ready';
}

// Idempotent: a project already migrated with the same source revision is
// verified and left untouched (identity is never regenerated).
function migrateLegacyProject(project = {}, options = {}) {
  if (project.productionV2?.migration?.migratedAt && options.sourceRevision === project.productionV2?.migration?.sourceRevision) {
    return { migrated: false, verified: true, approvalState: project.productionV2.migration.approvalState };
  }
  const approvalState = classifyLegacyProject(project);
  project.productionV2 = {
    ...(project.productionV2 || {}),
    enabled: true,
    migration: {
      migratedAt: new Date().toISOString(),
      fromVersion: String(options.fromVersion || project.schemaVersion || 'legacy'),
      toVersion: String(options.toVersion || 'production-v2'),
      sourceRevision: String(options.sourceRevision || ''),
      approvalState,
      // Only real confirmation evidence imports as approved; status=approved
      // alone is NEVER forged into a human approval.
      approvalImported: approvalState === 'legacy_imported',
      paidGenerationRequiresScopedApproval: approvalState !== 'legacy_imported'
    }
  };
  if (approvalState === 'legacy_imported') {
    project.promptReview = {
      ...(project.promptReview || {}),
      legacyImported: true,
      status: project.promptReview?.status || 'approved'
    };
  }
  if (approvalState === 'review_ready') {
    project.promptReview = { ...(project.promptReview || {}), status: 'pending' };
    project.promptReviewMayAutoOpenOnce = true;
  }
  return { migrated: true, verified: false, approvalState };
}

// §14.1: one consistent backup + manifest before touching anything.
function createMigrationManifest(store, options = {}) {
  const backupDir = options.backupDir || path.join(store.rootDir, 'migration-backup', `v2-${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const projectsDir = store.projectsDir;
  const files = [];
  let projectCount = 0;
  let mediaCount = options.mediaCount ?? 0;
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true }).filter(item => item.isDirectory())) {
      const file = path.join(projectsDir, entry.name, 'project.json');
      if (!fs.existsSync(file)) continue;
      projectCount += 1;
      const target = path.join(backupDir, `${entry.name}.project.json`);
      fs.copyFileSync(file, target);
      files.push({ file: target, sha256: sha256File(target) });
      if (options.mediaCount === undefined) {
        try { mediaCount += (JSON.parse(fs.readFileSync(file, 'utf8')).candidates || []).length; } catch { /* corrupt project is backed up but not parsed */ }
      }
    }
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    fromVersion: String(options.fromVersion || 'legacy'),
    toVersion: String(options.toVersion || 'production-v2'),
    projectCount,
    mediaCount,
    files
  };
  manifest.manifestSha256 = crypto.createHash('sha256')
    .update(JSON.stringify({ ...manifest, manifestSha256: undefined })).digest('hex');
  const manifestPath = path.join(backupDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, manifestPath, backupDir };
}

// Re-running migration must verify, not regenerate: compare the recorded
// manifest against the backup contents.
function verifyMigrationManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const recomputed = crypto.createHash('sha256')
    .update(JSON.stringify({ ...manifest, manifestSha256: undefined })).digest('hex');
  const filesOk = (manifest.files || []).every(entry => fs.existsSync(entry.file) && sha256File(entry.file) === entry.sha256);
  return { ok: recomputed === manifest.manifestSha256 && filesOk, manifest };
}

module.exports = { classifyLegacyProject, migrateLegacyProject, createMigrationManifest, verifyMigrationManifest, LEGACY_APPROVAL_STATES };
