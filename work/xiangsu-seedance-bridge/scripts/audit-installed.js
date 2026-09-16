"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { resolveUserDataDirectory } = require("../app/user-data-location");

async function main() {
  const root = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const executableCandidates = [
    process.env.DRAMA_SLOT_INSTALLED_EXE,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "xiangsu-seedance-bridge", `${packageJson.build.productName}.exe`),
    path.join(process.env.LOCALAPPDATA || "", "Programs", packageJson.name, `${packageJson.build.productName}.exe`)
  ].filter(Boolean);
  const executablePath = executableCandidates.find(candidate => fs.existsSync(candidate)) || executableCandidates[0];
  if (!fs.existsSync(executablePath)) throw new Error(`installed executable missing: ${executablePath}`);

  const evidenceRoot = process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
    ? path.resolve(process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR)
    : path.resolve(root, "..", "..", "..", "..", "..", ".codex_tests", process.env.DRAMA_SLOT_AUDIT_TASK_ID || "TASK-DRAMA-INSTALLED-AUDIT", "installed-ui");
  const runDir = path.join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "workspace-mode.json"), JSON.stringify({ version: 1, mode: "agent", updatedAt: new Date().toISOString() }, null, 2), "utf8");
  const reusableAssetDir = path.join(workbenchDir, "reusable-asset-library");
  const reusableFilesDir = path.join(reusableAssetDir, "files");
  fs.mkdirSync(reusableFilesDir, { recursive: true });
  const previewPath = path.join(reusableFilesDir, "安装版 人物#预览.png");
  fs.copyFileSync(path.join(root, "app", "assets", "drama-slot-mark.png"), previewPath);
  fs.writeFileSync(path.join(reusableAssetDir, "index.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    assets: [{
      id: "installed-image-decode-audit",
      kind: "character",
      mediaType: "image",
      stage: "character_sheet",
      label: "安装版图片解码验收",
      filePath: previewPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  }, null, 2), "utf8");

  const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE
    || path.join(resolveUserDataDirectory({ appDataPath: process.env.APPDATA || "" }), "drama-license.json");
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
      const foundryStatus = await api.foundryStatus();
      document.querySelector('.stage-button[data-stage="script"]')?.click();
      const scriptExampleLibrary = document.querySelector("#scriptExampleLibrary");
      document.querySelector('#scriptExampleLibrary [data-script-format-preview="dialogue"]')?.click();
      const dialogueExample = {
        dialogOpen: document.querySelector("#promptExampleDialog")?.open === true,
        filename: document.querySelector("#promptExampleDialog")?.dataset.downloadFilename || "",
        body: document.querySelector("#promptExampleText")?.value || ""
      };
      document.querySelector("#promptExampleDialog")?.close();
      document.querySelector("#rechargeDialog")?.showModal();
      document.querySelector("#rechargeAmount").value = "49";
      document.querySelector("#rechargeForm")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const rechargePolicy = {
        inputMin: Number(document.querySelector("#rechargeAmount")?.min || 0),
        help: document.querySelector("#rechargeAmountHelp")?.textContent?.trim() || "",
        invalidAmountError: document.querySelector("#rechargeError")?.textContent?.trim() || "",
        orderPanelHidden: document.querySelector("#rechargeOrderPanel")?.classList.contains("hidden") === true
      };
      document.querySelector("#rechargeDialog")?.close();
      const projects = await api.listProjects();
      const projectStates = [];
      for (const summary of projects.projects || []) {
        const loaded = await api.getProject(summary.id);
        if (loaded.ok) projectStates.push(loaded.project);
      }
      document.querySelector('.library-nav-button[data-library="characters"]')?.click();
      await new Promise(resolve => setTimeout(resolve, 250));
      const installedPreview = document.querySelector("#reusableAssetGrid img");
      const imageDecode = installedPreview ? {
        src: installedPreview.src,
        complete: installedPreview.complete,
        naturalWidth: installedPreview.naturalWidth,
        naturalHeight: installedPreview.naturalHeight
      } : null;
      document.querySelector("#reusableAssetDialog")?.close();
      document.querySelector("#newProjectDialog")?.showModal();
      const foundryIntentControls = [...document.querySelectorAll("#newProjectDialog .foundry-intent-grid select")].map(select => ({
        id: select.id,
        value: select.value,
        height: select.getBoundingClientRect().height
      }));
      document.querySelector("#newProjectDialog")?.close();
      return {
        defaults,
        foundryStatus,
        foundryIntentControls,
        projectsOk: projects.ok === true,
        projectCount: projects.projects?.length || 0,
        paidJobCount: projectStates.reduce((sum, project) => sum + (project.jobs || []).length, 0),
        runningAutomationCount: projectStates.filter(project => ["running", "pausing", "stopping"].includes(project.automation?.status)).length,
        title: document.title,
        scriptExamples: {
          present: Boolean(scriptExampleLibrary),
          previewCount: scriptExampleLibrary?.querySelectorAll("[data-script-format-preview]").length || 0,
          downloadCount: scriptExampleLibrary?.querySelectorAll("[data-script-format-example]").length || 0,
          dialogueExample
        },
        rechargePolicy,
        manualButtons: [
          "#importScriptFile",
          "#importDialogueRewrite",
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
        visibleInternalModelNames: (document.body.innerText || "").match(/(?:\bH3\b|Hailuo|海螺)/gi) || [],
        imageDecode
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
    assert.equal(result.foundryStatus?.ok, true, "installed V2 runtime status IPC must respond");
    assert.equal(result.foundryStatus?.status?.ok, true, "installed V2 SQLite runtime must pass quick_check");
    assert.deepEqual(result.foundryIntentControls.map(item => item.value), ["optimize", "natural", "balanced"], "installed project dialog must expose the recommended V2 intent defaults");
    assert.equal(result.foundryIntentControls.some(item => item.height < 43.5), false, "installed V2 intent controls must keep a 44px touch target");
    assert.equal(result.projectsOk, true, "installed project store must open");
    assert.ok(result.projectCount >= 1, "installed app must create or load a project");
    assert.equal(result.paidJobCount, 0, "startup must not submit paid generation jobs");
    assert.equal(result.runningAutomationCount, 0, "startup must not begin a production operation");
    assert.deepEqual(result.manualButtons.filter(item => !item.present), [], "manual entry buttons must be installed");
    assert.deepEqual(new Set(result.businessLibraryKinds), new Set(["characters", "voices", "props", "scenes", "products"]));
    assert.deepEqual(new Set(result.reusableImportKinds), new Set(["character", "scene", "prop", "wardrobe", "product", "image", "video", "audio", "voice"]));
    assert.deepEqual(result.ossSettingsFields.filter(item => !item.present), [], "installed app must expose the optional direct OSS controls");
    assert.deepEqual({
      present: result.scriptExamples.present,
      previewCount: result.scriptExamples.previewCount,
      downloadCount: result.scriptExamples.downloadCount,
      dialogueOpen: result.scriptExamples.dialogueExample.dialogOpen
    }, { present: true, previewCount: 3, downloadCount: 3, dialogueOpen: true }, "installed script page must expose all three persistent examples");
    assert.match(result.scriptExamples.dialogueExample.filename, /\.txt$/);
    for (const marker of ["七分钟完整上传剧本案例", "### 01", "### 42", "无背景音乐"]) {
      assert.ok(result.scriptExamples.dialogueExample.body.includes(marker), `installed dialogue example must include ${marker}`);
    }
    assert.equal(result.rechargePolicy.inputMin, 50, "installed desktop recharge must start at 50 yuan");
    assert.match(result.rechargePolicy.help, /软件内.*50.*官网.*30/);
    assert.match(result.rechargePolicy.invalidAmountError, /最低 50 元/);
    assert.equal(result.rechargePolicy.orderPanelHidden, true, "invalid installed recharge must not expose an order");
    assert.equal(result.pageHorizontalOverflow, false, "installed main page must not horizontally overflow");
    assert.deepEqual(result.visibleInternalModelNames, [], "installed user-visible system text must mask internal model names");
    assert.equal(result.imageDecode?.complete, true, "installed character image must finish decoding");
    assert.ok(result.imageDecode?.naturalWidth > 0 && result.imageDecode?.naturalHeight > 0, "installed character image must decode into real pixels");
    assert.match(result.imageDecode?.src || "", /^puream-asset:\/\//, "installed local media must use the constrained asset protocol");

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
