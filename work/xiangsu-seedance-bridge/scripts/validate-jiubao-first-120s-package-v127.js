"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION,
  promptReviewSettingsFingerprint,
  promptReviewSourceFingerprint
} = require("../app/workbench-workflow");
const { importDramaAssetPackage } = require("../app/drama-asset-package");
const { containsCjkOutsideDialogue } = require("../app/hailuo-h3-prompt");

const fullScope = String(process.env.JIUBAO_SCOPE || "").trim().toLowerCase() === "full";
const packagePath = process.argv[2] || path.join(
  __dirname,
  "..",
  ".codex_tests",
  "TASK-20260901-H3-IMAGE-ONLY-ENGLISH-PROMPT-127",
  fullScope ? "jiubao-full-ready-to-draw.pdramapack" : "jiubao-first-120s-ready-to-draw.pdramapack"
);
const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const expectedShotCount = packageDocument.project?.shots?.length || 0;
const expectedDialogueCount = (packageDocument.project?.shots || []).reduce((sum, shot) => sum + (shot.dialogueTurns || []).length, 0);
const expectedReusableAssetCount = new Set((packageDocument.assets || [])
  .filter(asset => asset.kind !== "shot_anchor")
  .map(asset => asset.sha256)
  .filter(Boolean)).size;
const expectedCandidateCount = (packageDocument.assets || []).filter(asset => asset.kind !== "product").length;

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-jiubao-package-smoke-"));
try {
const store = new WorkbenchStore(path.join(smokeRoot, "store"));
const imported = importDramaAssetPackage(store, packagePath, {
  promptReviewVersion: PROMPT_REVIEW_BUNDLE_VERSION,
  promptReviewSourceFingerprint,
  promptReviewSettingsFingerprint
});
const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: smokeRoot });
const project = store.getProject(imported.projectId);
const reusableAssets = store.listReusableAssets();
const importedCandidates = (project.candidates || []).filter(candidate => candidate.source === "codex-production-package");
const failures = [];
let imageReferenceCount = 0;
let dialogueCount = 0;

if (project.currentStage !== "videos") failures.push(`currentStage=${project.currentStage}`);
if (project.promptReview?.status !== "approved") failures.push(`promptReview=${project.promptReview?.status}`);
if (!workflow.promptReviewIsCurrent(project, "approved")) failures.push("prompt review is not current");
if (project.shots.length !== expectedShotCount) failures.push(`shots=${project.shots.length}/${expectedShotCount}`);

for (const shot of project.shots) {
  assert.equal(project.generation?.mode, "production_package", "导入项目必须进入独立 production_package 模式");
  const references = workflow.shotReferences(project, shot, project.generation.mode);
  dialogueCount += (shot.dialogueTurns || []).length;
  imageReferenceCount += references.images.length;
  if (shot.promptMode !== "manual") failures.push(`${shot.id}: promptMode=${shot.promptMode}`);
  if (references.referenceAudioMode !== "image_only") failures.push(`${shot.id}: referenceAudioMode=${references.referenceAudioMode}`);
  if (references.audios.length) failures.push(`${shot.id}: audio references=${references.audios.length}`);
  if (!references.images.length || references.images.length > 9) failures.push(`${shot.id}: image references=${references.images.length}`);
  if (!references.images.every(filePath => fs.existsSync(filePath))) failures.push(`${shot.id}: missing imported image`);
  if (containsCjkOutsideDialogue(shot.systemVideoPrompt || shot.videoPrompt || "")) failures.push(`${shot.id}: CJK outside dialogue`);
}

if (dialogueCount !== expectedDialogueCount) failures.push(`dialogueCount=${dialogueCount}/${expectedDialogueCount}`);
if (importedCandidates.length !== expectedCandidateCount) failures.push(`importedCandidates=${importedCandidates.length}/${expectedCandidateCount}`);
if (!project.product?.imagePath || !fs.existsSync(project.product.imagePath)) failures.push("imported product image is missing");
if (reusableAssets.length !== expectedReusableAssetCount) failures.push(`reusableAssets=${reusableAssets.length}/${expectedReusableAssetCount}`);
if (failures.length) throw new Error(failures.join("; "));

process.stdout.write(`${JSON.stringify({
  ok: true,
  projectId: imported.projectId,
  packageSha256: imported.packageSha256,
  assets: imported.assetCount,
  shots: imported.shotCount,
  dialogueCount,
  imageReferenceCount,
  audioReferenceCount: 0,
  reusableLibraryCount: reusableAssets.length,
  projectCandidateCount: importedCandidates.length,
  promptReviewCurrent: true,
  readyStage: project.currentStage,
  smokeRoot
}, null, 2)}\n`);
} finally {
  const tempBase = fs.realpathSync(os.tmpdir());
  const cleanupRoot = fs.realpathSync(smokeRoot);
  const relative = path.relative(tempBase, cleanupRoot);
  if (!relative.startsWith("puream-jiubao-package-smoke-") || relative.includes(path.sep) || path.isAbsolute(relative)) {
    throw new Error("Refusing to clean a smoke directory outside the temporary root");
  }
  fs.rmSync(cleanupRoot, { recursive: true, force: true });
}
