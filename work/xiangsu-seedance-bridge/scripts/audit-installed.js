"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

async function main() {
  const root = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const executablePath = process.env.DRAMA_SLOT_INSTALLED_EXE
    || path.join(process.env.LOCALAPPDATA || "", "Programs", packageJson.name, `${packageJson.build.productName}.exe`);
  if (!fs.existsSync(executablePath)) throw new Error(`installed executable missing: ${executablePath}`);

  const evidenceRoot = path.resolve(root, "..", "..", "..", "..", "..", ".codex_tests", "TASK-20260812-DRAMA-ADVERSARIAL-FIX-060", "installed-ui");
  const runDir = path.join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  fs.mkdirSync(userDataDir, { recursive: true });

  const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE
    || path.join(process.env.APPDATA || "", packageJson.name, "drama-license.json");
  const localStateSource = path.join(path.dirname(licenseSource), "Local State");
  if (!fs.existsSync(licenseSource) || !fs.existsSync(localStateSource)) {
    throw new Error("installed audit requires the local activation snapshot and its Electron Local State");
  }
  fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
  fs.copyFileSync(localStateSource, path.join(userDataDir, "Local State"));

  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: workbenchDir }
  });
  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) { win.setPosition(-32000, -32000); win.showInactive(); }
    });
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));

    const result = await page.evaluate(async () => {
      const api = window.dramaSlot.workbench;
      const defaults = await window.dramaSlot.defaults();
      const projects = await api.listProjects();
      const projectStates = [];
      for (const summary of projects.projects || []) {
        const loaded = await api.getProject(summary.id);
        if (loaded.ok) projectStates.push(loaded.project);
      }
      return {
        defaults,
        projectsOk: projects.ok === true,
        projectCount: projects.projects?.length || 0,
        paidJobCount: projectStates.reduce((sum, project) => sum + (project.jobs || []).length, 0),
        runningAutomationCount: projectStates.filter(project => ["running", "pausing", "stopping"].includes(project.automation?.status)).length,
        title: document.title,
        manualButtons: [
          "#importScriptFile",
          "#importStoryboardBatch",
          "#importShotPromptsBatch",
          "#importShotVideosBatch",
          "#importFinalVideo"
        ].map(selector => ({ selector, present: Boolean(document.querySelector(selector)) })),
        businessLibraryKinds: [...document.querySelectorAll(".library-nav-button[data-library]")].map(button => button.dataset.library),
        reusableImportKinds: [...document.querySelectorAll('[data-action="import-reusable-library"]')].map(button => button.dataset.kind),
        ossSettingsFields: ["videoStorageMode", "videoOssAccessKeyId", "videoOssAccessKeySecret", "videoOssBucket", "videoOssEndpoint", "videoReferenceUrlTtl"]
          .map(id => ({ id, present: Boolean(document.getElementById(id)) })),
        pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        visibleInternalModelNames: (document.body.innerText || "").match(/(?:\bH3\b|Hailuo|海螺)/gi) || []
      };
    });
    const screenshotPath = path.join(runDir, "installed-background.png");
    const pngBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win ? (await win.webContents.capturePage()).toPNG().toString("base64") : "";
    });
    if (pngBase64) fs.writeFileSync(screenshotPath, Buffer.from(pngBase64, "base64"));

    assert.equal(result.defaults.appVersion, packageJson.version, "installed version must match package.json");
    assert.equal(result.defaults.providerKind, "puream-hailuo-h3", "fresh installed data must default to PUREAM cloud");
    assert.equal(result.projectsOk, true, "installed project store must open");
    assert.ok(result.projectCount >= 1, "installed app must create or load a project");
    assert.equal(result.paidJobCount, 0, "startup must not submit paid generation jobs");
    assert.equal(result.runningAutomationCount, 0, "startup must not begin a production operation");
    assert.deepEqual(result.manualButtons.filter(item => !item.present), [], "manual entry buttons must be installed");
    assert.deepEqual(new Set(result.businessLibraryKinds), new Set(["characters", "voices", "props", "scenes", "products"]));
    assert.deepEqual(new Set(result.reusableImportKinds), new Set(["character", "scene", "image", "video", "audio"]));
    assert.deepEqual(result.ossSettingsFields.filter(item => !item.present), [], "installed app must expose the optional direct OSS controls");
    assert.equal(result.pageHorizontalOverflow, false, "installed main page must not horizontally overflow");
    assert.deepEqual(result.visibleInternalModelNames, [], "installed user-visible system text must mask internal model names");

    const report = { executablePath, runDir, screenshotPath, ...result };
    fs.writeFileSync(path.join(runDir, "audit.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
