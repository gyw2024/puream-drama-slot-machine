'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {fail,hash,stableId,unique}=require('./contracts');
// Invoke in maintenance mode with all writers stopped, OUTSIDE any transaction.
function backupDatabase(db,destination){
  if(fs.existsSync(destination))throw fail('BACKUP_EXISTS',destination);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  db.prepare('VACUUM INTO ?').run(destination);
  const copy=new DatabaseSync(destination,{readOnly:true});
  try{const check=copy.prepare('PRAGMA quick_check').all();if(check.some(r=>Object.values(r)[0]!=='ok'))throw fail('BACKUP_DATABASE_INVALID',destination);}
  finally{copy.close();}
  return {file:destination,sha256:crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex'),bytes:fs.statSync(destination).size};
}
// Source/schema/provider facts are supplied by trusted migration inspection, never guessed from version/name.
function migrateProject(original,{sourceRevision,sourceFactHash,policyHash,resolveProviderContract,at}){
  if(original.productionV2?.migrationVersion==='r2')return {project:original,changed:false,blockers:original.productionV2.migrationBlockers||[]};
  if(!sourceRevision||!sourceFactHash||!policyHash||typeof resolveProviderContract!=='function')throw fail('MIGRATION_SOURCE_EVIDENCE_REQUIRED',original.id);
  const p=structuredClone(original),beforeHash=hash(original),blockers=[];unique(p.shots||[]);unique(p.candidates||[]);
  const prior=p.productionV2||{},hasProduced=(p.candidates||[]).some(c=>c.stage==='shot_video'&&c.filePath);
  const epoch=prior.epoch||stableId('creation');
  const byNumber=[...(p.shots||[])].sort((a,b)=>(a.number??Infinity)-(b.number??Infinity));
  if((p.shots||[]).some((s,i)=>s.id!==byNumber[i].id))blockers.push({code:'LEGACY_ORDER_CONFLICT',arrayOrder:p.shots.map(s=>s.id),numberOrder:byNumber.map(s=>s.id)});
  for(const shot of p.shots||[]){
    const selected=(p.candidates||[]).filter(c=>c.entityId===shot.id&&c.entityType==='shot'&&c.stage==='shot_video'&&c.selected===true).map(c=>c.id);
    const alias=p.videoSelections?.[shot.id]?.candidateId||shot.selectedVideo?.candidateId||null;
    if(selected.length>1||(alias&&(selected.length!==1||selected[0]!==alias)))blockers.push({code:'LEGACY_SELECTION_CONFLICT',shotId:shot.id,selected,alias});
  }
  for(const item of p.promptReview?.items||[]){
    item.itemRevision=Number.isSafeInteger(item.itemRevision)?item.itemRevision:0;
    item.displayPrompt=typeof item.displayPrompt==='string'?item.displayPrompt:(item.prompt||'');
    item.providerContractId=item.providerContractId||resolveProviderContract(item)||'';
    item.sourceFactHash ||= sourceFactHash;item.policyHash ||= policyHash;
    // Preserve old evidence as evidence, not automatically as a new trusted approval.
    item.legacyApprovalEvidence={userConfirmed:item.userConfirmed===true,confirmedAt:item.confirmedAt||null,status:item.status||null};
    item.validation=null;
    if(!item.providerContractId)blockers.push({code:'PROVIDER_CONTRACT_UNAVAILABLE',itemId:item.id});
  }
  p.productionV2={...prior,enabled:true,migrationVersion:'r2',epoch,sourceRevision,
    phase:hasProduced?'producing':prior.phase||'collecting',textComplete:false,
    // Presence of old media is explicitly a migration fact, not a runtime readiness inference.
    productionStartedAt:prior.productionStartedAt||(hasProduced?at:null),
    reviewGate:{...prior.reviewGate,epoch,status:hasProduced?'legacy_readonly':'not_ready',autoOpenConsumedAt:prior.reviewGate?.autoOpenConsumedAt||(hasProduced?at:null)},
    options:{...prior.options,continueToPost:prior.options?.continueToPost===true},
    postPolicy:prior.postPolicy||{audioMode:'none'},migrationOriginalHash:beforeHash,migrationBlockers:blockers};
  // No candidate, source text, user template, historical media or manual override is removed.
  return {project:p,changed:true,blockers,beforeHash,afterHash:hash(p)};
}

function classifyLegacyProject(project) {
  if (!project) return 'review_ready';
  const hasMedia = (project.candidates || []).some(c => (c.stage === 'shot_video' || c.filePath) && (c.status === 'completed' || c.status === undefined));
  const hasShots = (project.shots || []).length > 0;
  if (hasMedia && hasShots) {
    const hasUserConfirmed = (project.promptReview?.items || []).some(i => i.userConfirmed === true);
    return hasUserConfirmed ? 'legacy_imported' : 'authorized_media';
  }
  return 'review_ready';
}

function migrateLegacyProject(project, options = {}) {
  if (!project) return { migrated: false, verified: false };
  if (project.productionV2?.enabled) {
    return { migrated: false, verified: true, approvalState: classifyLegacyProject(project) };
  }
  const approvalState = classifyLegacyProject(project);
  project.productionV2 = { enabled: true, sourceRevision: options.sourceRevision || 'r1', ...(project.productionV2 || {}) };
  if (approvalState === 'legacy_imported') {
    project.promptReview = { ...(project.promptReview || {}), legacyImported: true };
  } else if (approvalState === 'review_ready') {
    project.promptReviewMayAutoOpenOnce = true;
  }
  return { migrated: true, approvalState };
}

function createMigrationManifest(store) {
  const manifestPath = path.join(store.rootDir, 'migration-manifest.json');
  const files = [];
  let projectCount = 0, mediaCount = 0;
  if (store.projectsDir && fs.existsSync(store.projectsDir)) {
    for (const d of fs.readdirSync(store.projectsDir)) {
      const projFile = path.join(store.projectsDir, d, 'project.json');
      if (fs.existsSync(projFile)) {
        projectCount++;
        const content = fs.readFileSync(projFile);
        try {
          const parsed = JSON.parse(content.toString('utf8'));
          mediaCount += (parsed.candidates || []).length;
        } catch {}
        files.push({ file: projFile, sha256: crypto.createHash('sha256').update(content).digest('hex') });
      }
    }
  }
  const manifest = { projectCount, mediaCount, files };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { manifestPath, manifest };
}

function verifyMigrationManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { ok: false };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const f of manifest.files || []) {
    if (!fs.existsSync(f.file)) return { ok: false, manifest };
    const currentSha = crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
    if (currentSha !== f.sha256) return { ok: false, manifest };
  }
  return { ok: true, manifest };
}

module.exports={backupDatabase,migrateProject,classifyLegacyProject,migrateLegacyProject,createMigrationManifest,verifyMigrationManifest};
