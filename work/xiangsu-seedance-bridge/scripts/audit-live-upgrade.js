"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright-core");

function recoverableDeletedProjectIds(databasePath) {
  const deletedProjectsRoot = path.join(path.dirname(databasePath || ""), "deleted-projects");
  if (!databasePath || !fs.existsSync(deletedProjectsRoot)) return [];
  const projectIds = new Set();
  for (const entry of fs.readdirSync(deletedProjectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(deletedProjectsRoot, entry.name, "deleted-project.json");
    if (!fs.existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (typeof metadata.projectId === "string" && metadata.projectId.trim()) {
        projectIds.add(metadata.projectId.trim());
      }
    } catch {
      // Invalid archive metadata is deliberately not counted as recoverable authority.
    }
  }
  return [...projectIds].sort();
}

async function settleAssetImages(page) {
  return page.evaluate(async () => {
    const images = [...document.querySelectorAll('img[src^="puream-asset://"]')];
    await Promise.all(images.map(image => {
      if (image.complete) return Promise.resolve();
      return new Promise(resolve => {
        const done = () => resolve();
        image.addEventListener("load", done, { once: true });
        image.addEventListener("error", done, { once: true });
        setTimeout(done, 1500);
      });
    }));
    return images.map(image => ({
      src: image.getAttribute("src") || "",
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      visible: (() => {
        const rect = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })()
    }));
  });
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const executablePath = process.env.DRAMA_SLOT_INSTALLED_EXE
    || path.join(process.env.LOCALAPPDATA || "", "Programs", packageJson.name, `${packageJson.build.productName}.exe`);
  if (!fs.existsSync(executablePath)) throw new Error(`installed executable missing: ${executablePath}`);
  const evidenceRoot = process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
    ? path.resolve(process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR)
    : path.resolve(root, "..", "..", "..", "..", "..", ".codex_tests", process.env.DRAMA_SLOT_AUDIT_TASK_ID || "TASK-DRAMA-LIVE-UPGRADE-AUDIT", "live-upgrade");
  const runDir = path.join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(runDir, { recursive: true });

  const electronApp = await electron.launch({ executablePath, env: { ...process.env } });
  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) { win.setPosition(-32000, -32000); win.showInactive(); }
    });
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    const appState = await page.evaluate(async () => {
      const api = window.dramaSlot.workbench;
      const defaults = await window.dramaSlot.defaults();
      const foundryStatus = await api.foundryStatus();
      const projects = await api.listProjects();
      const states = [];
      for (const summary of projects.projects || []) {
        const loaded = await api.getProject(summary.id);
        if (loaded.ok) states.push(loaded.project);
      }
      return {
        version: defaults.appVersion,
        foundryStatus,
        projectIds: (projects.projects || []).map(item => item.id),
        projectCount: projects.projects?.length || 0,
        loadCount: states.length,
        activeAutomationCount: states.filter(project => ["running", "pausing", "stopping"].includes(project.automation?.status)).length,
        activeJobCount: states.reduce((sum, project) => sum + (project.jobs || []).filter(job => ["submitted", "queued", "running", "processing"].includes(job.status)).length, 0)
      };
    });

    const projectMedia = [];
    for (const projectId of appState.projectIds) {
      await page.selectOption("#projectSelect", projectId);
      await page.dispatchEvent("#projectSelect", "change");
      await page.waitForTimeout(350);
      await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
      const stages = [];
      for (const stage of ["assets", "shots"]) {
        await page.click(`.stage-button[data-stage="${stage}"]`);
        await page.waitForTimeout(180);
        const images = await settleAssetImages(page);
        stages.push({
          stage,
          assetImageCount: images.length,
          blankImages: images.filter(image => !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0)
        });
      }
      projectMedia.push({ projectId, stages });
    }

    const reusableLibraryStartedAt = Date.now();
    await page.click('.library-nav-button[data-library="characters"]', { timeout: 10_000 });
    await page.waitForSelector('#reusableAssetDialog[open]', { timeout: 5_000 });
    const reusableLibraryOpenMs = Date.now() - reusableLibraryStartedAt;
    await page.waitForTimeout(250);
    const reusableImages = await settleAssetImages(page);
    await page.evaluate(() => document.querySelector("#reusableAssetDialog")?.close());
    const blankProjectImages = projectMedia.flatMap(project => project.stages.flatMap(stage => stage.blankImages.map(image => ({ projectId: project.projectId, stage: stage.stage, ...image }))));
    const blankReusableImages = reusableImages.filter(image => !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0);
    const recoverableDeletedIds = recoverableDeletedProjectIds(appState.foundryStatus?.status?.databasePath);
    const visibleProjectIds = new Set(appState.projectIds);
    const recoverableDeletedOnlyIds = recoverableDeletedIds.filter(projectId => !visibleProjectIds.has(projectId));
    const expectedAuthoritativeProjectStateCount = appState.projectCount + recoverableDeletedOnlyIds.length;

    const screenshotPath = path.join(runDir, "live-upgrade-background.png");
    const pngBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win ? (await win.webContents.capturePage()).toPNG().toString("base64") : "";
    });
    if (pngBase64) fs.writeFileSync(screenshotPath, Buffer.from(pngBase64, "base64"));
    const report = {
      ok: appState.version === packageJson.version
        && appState.foundryStatus?.status?.ok === true
        && appState.projectCount === appState.loadCount
        && appState.foundryStatus?.status?.counts?.project_state === expectedAuthoritativeProjectStateCount
        && appState.activeAutomationCount === 0
        && appState.activeJobCount === 0
        && reusableLibraryOpenMs <= 5_000
        && blankProjectImages.length === 0
        && blankReusableImages.length === 0,
      executablePath,
      runDir,
      screenshotPath,
      ...appState,
      projectMedia,
      recoverableDeletedProjectIds: recoverableDeletedOnlyIds,
      recoverableDeletedProjectCount: recoverableDeletedOnlyIds.length,
      expectedAuthoritativeProjectStateCount,
      reusableLibraryOpenMs,
      reusableLibraryBudgetMs: 5_000,
      reusableAssetImageCount: reusableImages.length,
      blankProjectImages,
      blankReusableImages
    };
    fs.writeFileSync(path.join(runDir, "audit.json"), `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(report.ok, true, "live upgraded projects, SQLite authority and constrained asset decoding must all pass");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
