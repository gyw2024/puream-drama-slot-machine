"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { resolveUserDataDirectory } = require("../app/user-data-location");

async function main() {
  const root = path.resolve(__dirname, "..");
  const packagePath = path.resolve(process.argv[2] || path.join(
    root,
    ".codex_tests",
    "TASK-20260901-H3-IMAGE-ONLY-ENGLISH-PROMPT-127",
    "jiubao-first-120s-ready-to-draw.pdramapack"
  ));
  const executablePath = path.resolve(process.env.DRAMA_SLOT_INSTALLED_EXE || path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "xiangsu-seedance-bridge",
    "纯梦短剧老虎机.exe"
  ));
  assert.ok(fs.existsSync(packagePath), `Package missing: ${packagePath}`);
  assert.ok(fs.existsSync(executablePath), `Installed executable missing: ${executablePath}`);
  const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const expectedShotCount = packageDocument.project.shots.length;
  const expectedDialogueCount = packageDocument.project.shots.reduce((sum, shot) => sum + (shot.dialogueTurns || []).length, 0);
  const expectedSelectedCandidateCount = packageDocument.assets.filter(asset => asset.kind !== "product").length;
  const expectedMaterializedAssetCount = packageDocument.assets.length;
  const expectedReusableLibraryCount = new Set(packageDocument.assets
    .filter(asset => asset.kind !== "shot_anchor")
    .map(asset => asset.sha256)
    .filter(Boolean)).size;

  const taskRoot = path.join(root, ".codex_tests", "TASK-20260902-DRAMA-PACKAGE-DIRECT-MODE-012", "installed-ui");
  const runDir = path.join(taskRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workbenchDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "workspace-mode.json"), JSON.stringify({
    version: 1,
    mode: "package",
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");

  const currentUserData = resolveUserDataDirectory({ appDataPath: process.env.APPDATA || "" });
  for (const filename of ["drama-license.json", "Local State"]) {
    const source = path.join(currentUserData, filename);
    assert.ok(fs.existsSync(source), `Activation audit input missing: ${source}`);
    fs.copyFileSync(source, path.join(userDataDir, filename));
  }

  const runtimeIssues = { consoleErrors: [], pageErrors: [], requestFailures: [] };
  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: workbenchDir }
  });
  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    page.on("console", message => {
      if (message.type() !== "error") return;
      const value = message.text();
      if (!/net::ERR_(?:ABORTED|FAILED).*puream\.cn/i.test(value)) runtimeIssues.consoleErrors.push({ text: value, location: message.location() });
    });
    page.on("pageerror", error => runtimeIssues.pageErrors.push(String(error?.stack || error)));
    page.on("requestfailed", request => runtimeIssues.requestFailures.push({
      url: request.url(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText || ""
    }));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await electronApp.evaluate(({ dialog }, selectedPackagePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPackagePath] });
    }, packagePath);

    await page.click("#importProductionPackage");
    await page.waitForFunction(() => (
      document.querySelector('.stage-panel[data-panel="videos"]')?.classList.contains("active")
      && /Codex 资产包直抽/.test(document.querySelector("#toast")?.textContent || "")
    ), null, { timeout: 30_000 });
    const projectId = await page.locator("#projectSelect").inputValue();
    const response = await page.evaluate(id => window.dramaSlot.workbench.getProject(id), projectId);
    const project = response?.project;
    assert.ok(project, "Imported project is unavailable through the installed renderer API");
    const libraryResponse = await page.evaluate(() => window.dramaSlot.workbench.listReusableAssets());
    assert.equal(libraryResponse?.ok, true, libraryResponse?.message || "Reusable library query failed");

    const dialogueCount = project.shots.reduce((sum, shot) => sum + (shot.dialogueTurns || []).length, 0);
    const selectedAssets = project.candidates.filter(candidate => candidate.selected && !candidate.stale);
    const productImageExists = Boolean(project.product?.imagePath && fs.existsSync(project.product.imagePath));
    const reusableVisualAssets = libraryResponse.assets.filter(item => item.kind !== "voice");
    const reusableVoices = libraryResponse.assets.filter(item => item.kind === "voice");
    const importedShotReferenceCandidates = selectedAssets.filter(candidate => (
      candidate.entityType === "shot"
      && Boolean(candidate.importedAssetId)
    ));
    const importedAnchorCandidates = importedShotReferenceCandidates.filter(candidate => (
      candidate.stage === "shot_anchor" || candidate.stage === "storyboard_start"
    ));
    const strategyKinds = [...new Set(project.shots.map(shot => shot.videoStrategy))].sort();
    const frameStageSets = [...new Set(project.shots.map(shot => JSON.stringify(shot.videoFrameStages || [])))];
    const referenceTypes = [...new Set(project.shots.flatMap(shot => (shot.promptReviewReferencePlan?.images || []).map(item => item.type)))].sort();
    const uiContract = await page.evaluate(() => ({
      projectVideoMode: document.querySelector("#projectVideoMode")?.textContent || "",
      projectStrategyHelp: document.querySelector("#projectStrategyHelp")?.textContent || "",
      generationMode: document.querySelector("#generationMode")?.value || "",
      storyboardButtonHidden: document.querySelector("#generateAllStoryboards")?.hidden === true,
      editStrategyDisabled: document.querySelector("#editProjectStrategy")?.disabled === true,
      activeStage: document.querySelector(".stage-panel.active")?.dataset.panel || ""
    }));
    const report = {
      ok: true,
      executablePath,
      packagePath,
      packageSha256: crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex"),
      runDir,
      projectId,
      projectTitle: project.title,
      currentStage: project.currentStage,
      promptReviewStatus: project.promptReview?.status || "",
      importedValidation: project.importedProductionPackage?.validation || "",
      referenceAudioMode: project.importedProductionPackage?.referenceAudioMode || "",
      generationMode: project.generation?.mode || "",
      workflowMode: project.importedProductionPackage?.workflowMode || "",
      strategyKinds,
      frameStageSets,
      importedAnchorStages: [...new Set(importedAnchorCandidates.map(candidate => candidate.stage))].sort(),
      importedShotReferenceStages: [...new Set(importedShotReferenceCandidates.map(candidate => candidate.stage))].sort(),
      referenceTypes,
      shotCount: project.shots.length,
      dialogueCount,
      selectedAssetCount: selectedAssets.length,
      materializedAssetCount: selectedAssets.length + (productImageExists ? 1 : 0),
      productImageExists,
      reusableLibraryCount: reusableVisualAssets.length,
      reusableLibraryKinds: [...new Set(reusableVisualAssets.map(item => item.kind))].sort(),
      builtInVoiceCount: reusableVoices.length,
      audioReferenceCount: project.shots.reduce((sum, shot) => sum + (shot.references?.audios || []).length, 0),
      videoJobCount: project.jobs.filter(job => job.type === "shot_video").length,
      renderedVideoCount: project.shots.filter(shot => shot.videoPath).length,
      onceOnly: project.story?.everyStoryboardMayBeGeneratedOnlyOnce === true,
      paidVideoGenerationPerformed: project.story?.paidVideoGenerationPerformed === true,
      toast: await page.locator("#toast").textContent(),
      uiContract,
      runtimeIssues
    };

    assert.equal(report.currentStage, "videos");
    assert.equal(report.promptReviewStatus, "approved");
    assert.equal(report.importedValidation, "strict-zero-submit");
    assert.equal(report.referenceAudioMode, "image_only");
    assert.equal(report.generationMode, "production_package");
    assert.equal(report.workflowMode, "production_package");
    assert.deepEqual(report.strategyKinds, ["production_package"]);
    assert.deepEqual(report.frameStageSets, ["[]"]);
    assert.ok(report.importedAnchorStages.every(stage => stage === "shot_anchor"));
    assert.ok(!report.importedAnchorStages.includes("storyboard_start"));
    assert.ok(!report.importedShotReferenceStages.includes("storyboard_start"));
    assert.equal(report.shotCount, expectedShotCount);
    assert.equal(report.dialogueCount, expectedDialogueCount);
    assert.equal(report.selectedAssetCount, expectedSelectedCandidateCount);
    assert.equal(report.materializedAssetCount, expectedMaterializedAssetCount);
    assert.equal(report.productImageExists, true);
    assert.equal(report.reusableLibraryCount, expectedReusableLibraryCount);
    assert.deepEqual(report.reusableLibraryKinds, ["character", "product", "prop", "scene", "wardrobe"]);
    assert.equal(report.builtInVoiceCount, 40);
    assert.equal(report.audioReferenceCount, 0);
    assert.equal(report.videoJobCount, 0);
    assert.equal(report.renderedVideoCount, 0);
    assert.equal(report.onceOnly, true);
    assert.equal(report.paidVideoGenerationPerformed, false);
    assert.match(report.uiContract.projectVideoMode, /Codex 资产包直抽/);
    assert.match(report.uiContract.projectStrategyHelp, /资产包原提示词|资产包/);
    assert.equal(report.uiContract.generationMode, "production_package");
    assert.equal(report.uiContract.storyboardButtonHidden, true);
    assert.equal(report.uiContract.editStrategyDisabled, true);
    assert.equal(report.uiContract.activeStage, "videos");
    assert.deepEqual(runtimeIssues, { consoleErrors: [], pageErrors: [], requestFailures: [] });

    const videoScreenshotPath = path.join(runDir, "installed-production-package-videos.png");
    await page.screenshot({ path: videoScreenshotPath, animations: "disabled", fullPage: true });
    await page.click('.stage-button[data-stage="shots"]');
    await page.waitForFunction(() => document.querySelector('.stage-panel[data-panel="shots"]')?.classList.contains("active"));
    const shotsUi = await page.evaluate(() => ({
      storyboardButtonHidden: document.querySelector("#generateAllStoryboards")?.hidden === true,
      manualStoryboardEntryHidden: document.querySelector("#storyboardManualEntryBar")?.hidden === true,
      bodyText: document.querySelector('.stage-panel[data-panel="shots"]')?.innerText || ""
    }));
    assert.equal(shotsUi.storyboardButtonHidden, true);
    assert.equal(shotsUi.manualStoryboardEntryHidden, true);
    assert.match(shotsUi.bodyText, /资产包图片引用/);
    assert.doesNotMatch(shotsUi.bodyText, /抽卡：全部首尾帧/);
    assert.doesNotMatch(shotsUi.bodyText, /批量上传分镜提示词|批量上传分镜图/);
    const shotsScreenshotPath = path.join(runDir, "installed-production-package-shot-references.png");
    await page.screenshot({ path: shotsScreenshotPath, animations: "disabled", fullPage: true });
    report.screenshotPaths = { videos: videoScreenshotPath, shots: shotsScreenshotPath };
    fs.writeFileSync(path.join(runDir, "audit.json"), JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await electronApp.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
