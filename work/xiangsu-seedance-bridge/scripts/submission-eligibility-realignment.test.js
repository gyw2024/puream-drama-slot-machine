'use strict';
// Regression for the submission-gate dead loop reported on 2026-09-16:
// a project whose prompts were confirmed under the pre-0.16.357 reference
// rules (asset-ineligible silent entrants still enumerated) could never
// submit a shot video — every attempt bounced back to the 57-item prompt
// confirmation dialog even though everything was already confirmed.
//
// Contract after the fix:
// 1. Reference shrinkage that ONLY removes asset-ineligible character images
//    (same relative order, audio roles untouched) does not invalidate the
//    approval, provided the submitted prompt is the deterministic re-render
//    of the SAME approved story facts over the corrected manifest.
// 2. The stored confirmed text itself still never passes when the manifest
//    realigned (its <Picture N> bindings would mis-bind).
// 3. Reference drift beyond eligibility (e.g. a missing scene image) still
//    bounces to confirmation.
// 4. Legacy audit receipts without promptSha256 no longer permanently brick
//    submission when the bundle is current and the texts match.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const workflow = require("../app/workbench-workflow");
const review = require("../app/submission-agent-review");

const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");

function buildProject() {
  const project = {
    productionRevision: "",
    generation: { mode: "asset_direct" },
    script: { raw: "测试剧本" },
    product: { name: "测试商品" },
    characters: [
      { id: "char-hero", name: "主角", assetRequired: true },
      { id: "char-silent", name: "沉默亲戚", assetRequired: false }
    ],
    scenes: [{ id: "scene-room", name: "房间", assetRequired: true }],
    assetLibraries: { props: [], wardrobes: [] },
    shots: [],
    promptReview: null
  };
  const shot = {
    id: "shot-01",
    number: 1,
    duration: 10,
    sceneId: "scene-room",
    visibleCharacterIds: ["char-hero", "char-silent"],
    dialogueTurns: []
  };
  project.shots.push(shot);
  // Fresh manifest under current rules: scene + hero only. The confirmed plan
  // below still enumerates the silent entrant (pre-fix bundle).
  const references = workflow.promptReviewReferencePlan(project, shot, "asset_direct", "image_only", "auto");
  const realignedPrompt = workflow.renderApprovedVideoPrompt(project, shot, references);
  const staleImages = [
    { index: 1, type: "scene", entityId: "scene-room", characterId: "" },
    { index: 2, type: "character", entityId: "char-hero", characterId: "" },
    { index: 3, type: "character", entityId: "char-silent", characterId: "" }
  ];
  const stalePrompt = realignedPrompt.replace(
    "</subject_definitions>",
    "<S3> (S3) is the recurring character char-silent; exact face bound to <Picture 3>.\n</subject_definitions>"
  ).replace(/<Picture 2>/g, "<Picture 2>").concat("\n<S3> stands in the background, silent, bound to <Picture 3>.");
  shot.promptReviewReferencePlan = {
    hailuoApiMode: "reference_to_video",
    referenceAudioMode: "image_only",
    frameSourceImageRoles: [],
    images: staleImages,
    videos: [],
    audios: []
  };
  project.promptReview = {
    version: workflow.PROMPT_REVIEW_BUNDLE_VERSION,
    status: "approved",
    productionRevision: "",
    sourceFingerprint: "",
    settingsFingerprint: "",
    items: [{
      id: "shot:shot-01:shot_video",
      entityType: "shot",
      entityId: "shot-01",
      stage: "shot_video",
      status: "confirmed",
      userConfirmed: true,
      language: "en",
      executionLanguage: "en",
      translationStatus: "structured",
      prompt: stalePrompt,
      displayPrompt: "中文对照",
      // Legacy audit receipt: no promptSha256, not_verified — must not brick
      // submission on its own.
      agentAudit: { status: "not_verified", issues: [], source: "legacy-bundle" }
    }],
    counts: { total: 1, confirmed: 1, videos: 1, characters: 0, scenes: 0, objects: 0, assets: 0, storyboards: 0 }
  };
  project.promptReview.sourceFingerprint = workflow.promptReviewSourceFingerprint(project);
  project.promptReview.settingsFingerprint = workflow.promptReviewSettingsFingerprint({});
  return { project, shot, references, realignedPrompt, stalePrompt };
}

test("eligibility-only reference shrinkage submits the deterministic re-render", async () => {
  const fx = buildProject();
  // buildShotPrompt must NOT hand back the stale confirmed text.
  const built = workflow.WorkbenchWorkflow.prototype.buildShotPrompt.call({}, fx.project, {}, fx.shot, "asset_direct", fx.references);
  assert.notStrictEqual(built, fx.stalePrompt);
  assert.equal(built, fx.realignedPrompt);
  const out = await review.prepare({ project: fx.project, shot: fx.shot, prompt: built, references: fx.references, settings: {} });
  assert.equal(out, built);
});

test("the stale confirmed text itself still bounces when the manifest realigned", async () => {
  const fx = buildProject();
  await assert.rejects(
    review.prepare({ project: fx.project, shot: fx.shot, prompt: fx.stalePrompt, references: fx.references, settings: {} }),
    error => error.code === "PROMPT_CONFIRMATION_REQUIRED"
  );
});

test("reference drift beyond eligibility still requires confirmation", async () => {
  const fx = buildProject();
  const broken = { ...fx.references, imageRoles: fx.references.imageRoles.filter(role => role.type !== "scene") };
  const built = workflow.renderApprovedVideoPrompt(fx.project, fx.shot, broken);
  await assert.rejects(
    review.prepare({ project: fx.project, shot: fx.shot, prompt: built, references: broken, settings: {} }),
    error => error.code === "PROMPT_CONFIRMATION_REQUIRED"
  );
});

test("legacy audit receipt without promptSha256 passes when bundle and text are current", async () => {
  const fx = buildProject();
  const matching = workflow.promptReviewReferencePlan(fx.project, fx.shot, "asset_direct", "image_only", "auto");
  // No drift at all: audios empty on both sides; images identical.
  fx.shot.promptReviewReferencePlan.images = matching.imageRoles.map((role, index) => ({
    index: index + 1, type: role.type, entityId: role.entityId, characterId: role.characterId || ""
  }));
  const prompt = workflow.renderApprovedVideoPrompt(fx.project, fx.shot, matching);
  // A legacy bundle whose confirmed text matches its own plan render: the
  // missing promptSha256 receipt alone must not brick submission.
  fx.project.promptReview.items[0].prompt = prompt;
  const out = await review.prepare({ project: fx.project, shot: fx.shot, prompt, references: matching, settings: {} });
  assert.equal(out, prompt);
});

test("referenceManifestEligibilityAligned rejects added or reordered roles", () => {
  const fx = buildProject();
  assert.equal(workflow.referenceManifestEligibilityAligned(fx.project, fx.shot, fx.references), true);
  const reordered = { ...fx.references, imageRoles: [...fx.references.imageRoles].reverse() };
  assert.equal(workflow.referenceManifestEligibilityAligned(fx.project, fx.shot, reordered), false);
  const extra = { ...fx.references, imageRoles: [...fx.references.imageRoles, { type: "character", entityId: "char-hero" }] };
  assert.equal(workflow.referenceManifestEligibilityAligned(fx.project, fx.shot, extra), false);
  void digest;
});
