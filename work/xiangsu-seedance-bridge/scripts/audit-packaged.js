"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright-core");
const axeSource = require("axe-core").source;

async function main() {
  const root = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const executablePath = path.join(root, packageJson.build.directories.output, "win-unpacked", "纯梦短剧老虎机.exe");
  const evidenceDir = process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
    ? path.resolve(process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR)
    : path.resolve(root, "..", "..", "..", "..", "..", ".codex_tests", process.env.DRAMA_SLOT_AUDIT_TASK_ID || "TASK-DRAMA-PACKAGED-AUDIT", "packaged-ui");
  const runDir = path.join(evidenceDir, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const reusableAssetDir = path.join(workbenchDir, "reusable-asset-library");
  const reusableFilesDir = path.join(reusableAssetDir, "files");
  fs.mkdirSync(reusableFilesDir, { recursive: true });
  const reusableCharacterPath = path.join(reusableFilesDir, "audit-cross-project-character.png");
  fs.copyFileSync(path.join(root, "app", "assets", "drama-slot-mark.png"), reusableCharacterPath);
  const reusableCharacterSha256 = crypto.createHash("sha256").update(fs.readFileSync(reusableCharacterPath)).digest("hex");
  fs.writeFileSync(path.join(reusableAssetDir, "index.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    assets: [{
      id: "audit-cross-project-character",
      kind: "character",
      mediaType: "image",
      stage: "character_sheet",
      label: "跨项目测试人物",
      description: "来自另一个项目的已确认人物形象",
      filePath: reusableCharacterPath,
      sha256: reusableCharacterSha256,
      fingerprint: `character:${reusableCharacterSha256}`,
      source: { projectId: "another-project", projectTitle: "另一个历史项目" },
      useCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  }, null, 2), "utf8");
  const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE
    || path.join(process.env.APPDATA || "", packageJson.name, "drama-license.json");
  if (!fs.existsSync(licenseSource)) throw new Error("packaged audit requires an existing local activation snapshot; set DRAMA_SLOT_AUDIT_LICENSE_SOURCE");
  fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
  const sourceLocalState = path.join(path.dirname(licenseSource), "Local State");
  if (!fs.existsSync(sourceLocalState)) throw new Error("packaged audit requires the Electron Local State encryption key beside the activation snapshot");
  fs.copyFileSync(sourceLocalState, path.join(userDataDir, "Local State"));

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
    try {
      await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(async () => ({
        title: document.title,
        readyState: document.readyState,
        workbenchReady: document.body?.dataset?.workbenchReady || "",
        bodyText: (document.body?.innerText || "").slice(0, 5000),
        licenseGateHidden: document.querySelector("#licenseGate")?.hidden,
        licenseStatus: await window.dramaSlot?.workbench?.licenseStatus?.().catch(problem => ({ ok: false, message: problem?.message || String(problem) }))
      })).catch(problem => ({ diagnosticError: problem?.message || String(problem) }));
      fs.writeFileSync(path.join(runDir, "startup-diagnostic.json"), JSON.stringify(diagnostic, null, 2));
      const pngBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win ? (await win.webContents.capturePage()).toPNG().toString("base64") : "";
      });
      if (pngBase64) fs.writeFileSync(path.join(runDir, "startup-failure.png"), Buffer.from(pngBase64, "base64"));
      throw error;
    }
    await page.evaluate(axeSource);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));

    const screenshots = [];
    const captureBackground = async name => {
      const screenshotPath = path.join(runDir, `${name}.png`);
      const pngBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) throw new Error("Electron window is unavailable for background capture");
        return (await win.webContents.capturePage()).toPNG().toString("base64");
      });
      fs.writeFileSync(screenshotPath, Buffer.from(pngBase64, "base64"));
      screenshots.push(screenshotPath);
      return screenshotPath;
    };
    const auditViews = [
      { width: 1024, height: 720, zoom: 1 },
      { width: 1280, height: 800, zoom: 1 },
      { width: 1440, height: 900, zoom: 1 },
      { width: 1920, height: 1080, zoom: 1 },
      { width: 1280, height: 800, zoom: 2 }
    ];
    const layoutMatrix = [];
    for (const view of auditViews) {
      const viewport = { width: view.width, height: view.height };
      await page.setViewportSize(viewport);
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) { win.setContentSize(size.width, size.height); win.webContents.setZoomFactor(size.zoom); }
      }, view);
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => {
        const visible = node => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const topControls = [...document.querySelectorAll(".topbar button,.topbar select")].filter(visible);
        const overlaps = [];
        for (let leftIndex = 0; leftIndex < topControls.length; leftIndex += 1) {
          const left = topControls[leftIndex].getBoundingClientRect();
          for (let rightIndex = leftIndex + 1; rightIndex < topControls.length; rightIndex += 1) {
            const right = topControls[rightIndex].getBoundingClientRect();
            if (left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top) {
              overlaps.push([topControls[leftIndex].id || topControls[leftIndex].textContent, topControls[rightIndex].id || topControls[rightIndex].textContent]);
            }
          }
        }
        return {
          viewport: { width: innerWidth, height: innerHeight },
          pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          topbarHorizontalOverflow: document.querySelector(".topbar").scrollWidth > document.querySelector(".topbar").clientWidth + 1,
          mainStageHorizontalOverflow: document.querySelector(".main-stage").scrollWidth > document.querySelector(".main-stage").clientWidth + 1,
          topControlOverlaps: overlaps,
          navScrollable: document.querySelector(".pipeline-nav").scrollHeight > document.querySelector(".pipeline-nav").clientHeight,
          visibleStageButtons: [...document.querySelectorAll(".stage-button")].filter(visible).length
        };
      });
      layoutMatrix.push({ ...view, ...layout });
      await captureBackground(`main-window-${viewport.width}x${viewport.height}-zoom${view.zoom * 100}`);
    }
    const blueprintPopoverMatrix = [];
    for (const view of auditViews) {
      await page.setViewportSize({ width: view.width, height: view.height });
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) { win.setContentSize(size.width, size.height); win.webContents.setZoomFactor(size.zoom); }
      }, view);
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        document.querySelector("#qualityBlueprintDetails")?.removeAttribute("open");
        if (!document.querySelector("#qualityBlueprintMenu")?.classList.contains("hidden")) {
          document.querySelector("#qualityBlueprintClose")?.click();
        }
      });
      await page.click("#qualityBlueprintToggle");
      await page.waitForTimeout(100);
      const readPopover = () => page.evaluate(() => {
        const menu = document.querySelector("#qualityBlueprintMenu");
        const config = document.querySelector(".quality-blueprint-config");
        const rect = menu.getBoundingClientRect();
        const configRect = config.getBoundingClientRect();
        const style = getComputedStyle(menu);
        const colorParts = style.backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
        const alpha = colorParts.length >= 4 ? colorParts[3] : 1;
        return {
          viewport: { width: innerWidth, height: innerHeight },
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          clipped: rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1,
          horizontalOverflow: menu.scrollWidth > menu.clientWidth + 1 || config.scrollWidth > config.clientWidth + 1,
          position: style.position,
          backgroundColor: style.backgroundColor,
          backgroundOpaque: alpha >= 1,
          detailsOpen: Boolean(document.querySelector("#qualityBlueprintDetails")?.open),
          configScrollable: config.scrollHeight > config.clientHeight + 1,
          closeVisible: document.querySelector("#qualityBlueprintClose")?.getBoundingClientRect().width >= 44,
          masterVisible: document.querySelector("#qualityBlueprintMaster")?.getBoundingClientRect().width > 0,
          configRect: { top: configRect.top, bottom: configRect.bottom, height: configRect.height }
        };
      });
      const collapsed = await readPopover();
      await captureBackground(`blueprint-collapsed-${view.width}x${view.height}-zoom${view.zoom * 100}`);
      await page.click("#qualityBlueprintDetails > summary");
      await page.waitForTimeout(100);
      const expanded = await readPopover();
      await captureBackground(`blueprint-expanded-top-${view.width}x${view.height}-zoom${view.zoom * 100}`);
      const bottomReachability = await page.evaluate(() => {
        const config = document.querySelector(".quality-blueprint-config");
        config.scrollTop = config.scrollHeight;
        const last = document.querySelector("#qualityBlueprintMenu [data-blueprint-check='visualVariety']")?.closest("label")?.getBoundingClientRect();
        const configRect = config.getBoundingClientRect();
        return Boolean(last && last.top >= configRect.top - 1 && last.bottom <= configRect.bottom + 1);
      });
      await captureBackground(`blueprint-expanded-bottom-${view.width}x${view.height}-zoom${view.zoom * 100}`);
      blueprintPopoverMatrix.push({ ...view, collapsed, expanded, bottomReachability });
      await page.keyboard.press("Escape");
    }
    const scriptFormatDialogMatrix = [];
    for (const view of auditViews) {
      await page.setViewportSize({ width: view.width, height: view.height });
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) { win.setContentSize(size.width, size.height); win.webContents.setZoomFactor(size.zoom); }
      }, view);
      await page.evaluate(() => {
        document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
        document.querySelector("#scriptFormatDialog")?.showModal();
      });
      await page.waitForTimeout(120);
      const snapshot = await page.evaluate(() => {
        const dialog = document.querySelector("#scriptFormatDialog");
        const rect = dialog.getBoundingClientRect();
        dialog.scrollTop = dialog.scrollHeight;
        const confirmRect = document.querySelector("#confirmScriptFormat")?.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          optionCount: dialog.querySelectorAll('input[name="scriptFormat"]').length,
          clipped: rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1,
          horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
          verticalScrollable: dialog.scrollHeight > dialog.clientHeight + 1,
          confirmReachable: Boolean(confirmRect && confirmRect.top >= rect.top - 1 && confirmRect.bottom <= rect.bottom + 1)
        };
      });
      scriptFormatDialogMatrix.push({ ...view, ...snapshot });
      await captureBackground(`script-format-dialog-${view.width}x${view.height}-zoom${view.zoom * 100}`);
      await page.evaluate(() => document.querySelector("#scriptFormatDialog")?.close());
    }
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) { win.setContentSize(1440, 900); win.webContents.setZoomFactor(1); }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));

    const persistentScriptExampleMatrix = [];
    for (const view of auditViews) {
      await page.setViewportSize({ width: view.width, height: view.height });
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) { win.setContentSize(size.width, size.height); win.webContents.setZoomFactor(size.zoom); }
      }, view);
      await page.evaluate(() => {
        document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
        document.querySelector('.stage-button[data-stage="script"]')?.click();
        document.querySelector("#scriptExampleLibrary")?.scrollIntoView({ block: "start" });
      });
      await page.waitForTimeout(180);
      const snapshot = await page.evaluate(() => {
        const library = document.querySelector("#scriptExampleLibrary");
        const rect = library?.getBoundingClientRect();
        const buttons = [...(library?.querySelectorAll("button") || [])];
        return {
          visible: Boolean(library && rect && rect.width > 0 && rect.height > 0),
          previewCount: library?.querySelectorAll("[data-script-format-preview]").length || 0,
          downloadCount: library?.querySelectorAll("[data-script-format-example]").length || 0,
          horizontalOverflow: Boolean(library && library.scrollWidth > library.clientWidth + 1),
          clippedHorizontally: Boolean(rect && (rect.left < -1 || rect.right > innerWidth + 1)),
          undersizedButtons: buttons.map(button => ({
            label: button.textContent.trim(),
            width: Math.round(button.getBoundingClientRect().width),
            height: Math.round(button.getBoundingClientRect().height)
          })).filter(item => item.width < 44 || item.height < 44)
        };
      });
      persistentScriptExampleMatrix.push({ ...view, ...snapshot });
      await captureBackground(`script-example-library-${view.width}x${view.height}-zoom${view.zoom * 100}`);
    }

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) { win.setContentSize(1440, 900); win.webContents.setZoomFactor(1); }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
      document.querySelector('.stage-button[data-stage="script"]')?.click();
    });
    const scriptExamplePreviews = [];
    for (const format of ["production", "dialogue", "timed_storyboard"]) {
      await page.click(`#scriptExampleLibrary [data-script-format-preview="${format}"]`);
      await page.waitForTimeout(80);
      const snapshot = await page.evaluate(currentFormat => {
        const dialog = document.querySelector("#promptExampleDialog");
        const body = document.querySelector("#promptExampleText")?.value || "";
        const expected = {
          production: ["完整制作稿示例", "【商品节点】"],
          dialogue: ["简易对白稿示例", "对周远说"],
          timed_storyboard: ["秒级分镜成片稿示例", "## S01"]
        }[currentFormat];
        return {
          format: currentFormat,
          open: Boolean(dialog?.open),
          title: document.querySelector("#promptExampleDialogTitle")?.textContent?.trim() || "",
          filename: dialog?.dataset.downloadFilename || "",
          bodyLength: body.length,
          expectedContentPresent: expected.every(fragment => body.includes(fragment))
        };
      }, format);
      scriptExamplePreviews.push(snapshot);
      await captureBackground(`script-example-preview-${format}`);
      await page.evaluate(() => document.querySelector("#promptExampleDialog")?.close());
    }
    const scriptExampleDownloads = await page.evaluate(async () => {
      const captured = [];
      const blobs = new Map();
      const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = blob => {
        const url = originalCreateObjectUrl(blob);
        blobs.set(url, blob);
        return url;
      };
      HTMLAnchorElement.prototype.click = function auditExampleDownload() {
        const blob = blobs.get(this.href);
        if (this.download && blob) {
          captured.push(blob.text().then(content => ({
            filename: this.download,
            bodyLength: content.length,
            startsWithHeading: content.startsWith("# ")
          })));
          return;
        }
        return originalAnchorClick.call(this);
      };
      try {
        document.querySelectorAll("#scriptExampleLibrary [data-script-format-example]").forEach(button => button.click());
        return await Promise.all(captured);
      } finally {
        URL.createObjectURL = originalCreateObjectUrl;
        HTMLAnchorElement.prototype.click = originalAnchorClick;
      }
    });

    const stageMatrix = [];
    const stageNames = ["console", "script", "assets", "shots", "videos", "final", "settings"];
    for (const stage of stageNames) {
      await page.evaluate(currentStage => document.querySelector(`.stage-button[data-stage="${currentStage}"]`)?.click(), stage);
      await page.waitForTimeout(300);
      const snapshot = await page.evaluate(async currentStage => {
        const visible = node => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const panel = document.querySelector(`.stage-panel[data-panel="${currentStage}"]`);
        const undersized = [...document.querySelectorAll(".topbar button,.pipeline-nav button,.stage-panel.active button,.stage-panel.active select,.stage-panel.active input:not([type='radio']):not([type='checkbox'])")]
          .filter(visible)
          .map(node => ({ label: (node.getAttribute("aria-label") || node.textContent || node.id).trim().slice(0, 80), width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) }))
          .filter(item => item.width < 44 || item.height < 44);
        const result = await window.axe.run(panel, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return {
          stage: currentStage,
          active: Boolean(panel?.classList.contains("active")),
          horizontalOverflow: Boolean(panel && panel.scrollWidth > panel.clientWidth + 1),
          undersized,
          seriousAxe: result.violations.filter(item => ["critical", "serious"].includes(item.impact)).map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary })) }))
        };
      }, stage);
      stageMatrix.push(snapshot);
      await captureBackground(`stage-${stage}`);
    }

    const dialogMatrix = [];
    for (const dialogId of ["newProjectDialog", "projectStrategyDialog", "scriptFormatDialog", "rechargeDialog", "reusableAssetDialog", "candidateLibraryDialog", "restoreProjectDialog"]) {
      await page.evaluate(id => {
        document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
        document.getElementById(id)?.showModal();
      }, dialogId);
      await page.waitForTimeout(250);
      const snapshot = await page.evaluate(async id => {
        const dialog = document.getElementById(id);
        const rect = dialog.getBoundingClientRect();
        const result = await window.axe.run(dialog, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return {
          id,
          open: dialog.open,
          clipped: rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1,
          horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
          seriousAxe: result.violations.filter(item => ["critical", "serious"].includes(item.impact)).map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary })) }))
        };
      }, dialogId);
      dialogMatrix.push(snapshot);
      await captureBackground(`dialog-${dialogId}`);
      await page.evaluate(id => document.getElementById(id)?.close(), dialogId);
    }

    await page.evaluate(() => {
      document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
      document.querySelector("#rechargeDialog")?.showModal();
      document.querySelector("#rechargeAmount").value = "49";
      document.querySelector("#rechargeForm")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(80);
    const rechargePolicy = await page.evaluate(() => ({
      inputMin: Number(document.querySelector("#rechargeAmount")?.min || 0),
      help: document.querySelector("#rechargeAmountHelp")?.textContent?.trim() || "",
      invalidAmountError: document.querySelector("#rechargeError")?.textContent?.trim() || "",
      orderPanelHidden: document.querySelector("#rechargeOrderPanel")?.classList.contains("hidden") === true
    }));
    await captureBackground("dialog-recharge-policy-49");
    await page.evaluate(() => document.querySelector("#rechargeDialog")?.close());

    await page.evaluate(() => document.querySelector('.stage-button[data-stage="script"]')?.click());
    const axe = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
    }));
    const defaults = await page.evaluate(() => window.dramaSlot.defaults());
    const settings = await page.evaluate(() => window.dramaSlot.workbench.getSettings());
    await page.focus("#qualityBlueprintToggle");
    await page.keyboard.press("Enter");
    const blueprintKeyboardOpened = await page.evaluate(() => (
      !document.querySelector("#qualityBlueprintMenu")?.classList.contains("hidden")
      && document.querySelector("#qualityBlueprintToggle")?.getAttribute("aria-expanded") === "true"
    ));
    const blueprintFocusEntered = await page.evaluate(() => document.activeElement?.id === "qualityBlueprintMenu");
    await page.keyboard.press("Escape");
    const blueprintKeyboardClosed = await page.evaluate(() => (
      document.querySelector("#qualityBlueprintMenu")?.classList.contains("hidden")
      && document.querySelector("#qualityBlueprintToggle")?.getAttribute("aria-expanded") === "false"
    ));
    await page.keyboard.press("Tab");
    const keyboardTabMoved = await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.id !== "qualityBlueprintToggle");
    await page.click("#qualityBlueprintToggle");
    await page.click("#qualityBlueprintMaster");
    await page.waitForFunction(async () => (await window.dramaSlot.workbench.getSettings()).settings?.generation?.qualityGatesEnabled === false);
    const blueprintOffState = await page.evaluate(() => {
      const menu = document.querySelector("#qualityBlueprintMenu");
      const config = document.querySelector(".quality-blueprint-config");
      const note = document.querySelector(".quality-blueprint-off-note");
      const rect = menu.getBoundingClientRect();
      return {
        clipped: rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1,
        height: rect.height,
        horizontalOverflow: menu.scrollWidth > menu.clientWidth + 1,
        configHidden: getComputedStyle(config).display === "none",
        noteVisible: getComputedStyle(note).display !== "none" && note.getBoundingClientRect().height > 0,
        detailsCollapsed: document.querySelector("#qualityBlueprintDetails")?.open === false
      };
    });
    await captureBackground("blueprint-disabled-compact");
    await page.click("#qualityBlueprintMaster");
    await page.waitForFunction(async () => (await window.dramaSlot.workbench.getSettings()).settings?.generation?.qualityGatesEnabled === true);
    await page.click('#qualityBlueprintMenu [data-blueprint-bulk="none"]');
    await page.waitForFunction(async () => {
      const result = await window.dramaSlot.workbench.getSettings();
      const checks = result.settings?.generation?.blueprintAuditChecks || {};
      return Object.keys(checks).length === 13 && Object.values(checks).every(value => value === false);
    });
    const blueprintAllOff = await page.evaluate(async () => {
      const result = await window.dramaSlot.workbench.getSettings();
      return Object.values(result.settings?.generation?.blueprintAuditChecks || {}).filter(Boolean).length;
    });
    await page.click('#qualityBlueprintMenu [data-blueprint-bulk="all"]');
    await page.waitForFunction(async () => {
      const result = await window.dramaSlot.workbench.getSettings();
      const checks = result.settings?.generation?.blueprintAuditChecks || {};
      return Object.keys(checks).length === 13 && Object.values(checks).every(value => value === true);
    });
    const blueprintControls = await page.evaluate(async () => {
      const result = await window.dramaSlot.workbench.getSettings();
      return {
        detailControlCount: document.querySelectorAll("[data-blueprint-check]").length,
        bulkControlCount: document.querySelectorAll("[data-blueprint-bulk]").length,
        allOffEnabledCount: 0,
        allOnEnabledCount: Object.values(result.settings?.generation?.blueprintAuditChecks || {}).filter(Boolean).length,
        keyboardOpened: true,
        keyboardClosed: true,
        keyboardTabMoved: true,
        focusEnteredDialog: true
      };
    });
    blueprintControls.allOffEnabledCount = blueprintAllOff;
    blueprintControls.keyboardOpened = blueprintKeyboardOpened;
    blueprintControls.keyboardClosed = blueprintKeyboardClosed;
    blueprintControls.keyboardTabMoved = keyboardTabMoved;
    blueprintControls.focusEnteredDialog = blueprintFocusEntered;
    await page.keyboard.press("Escape");
    const ossSaved = await page.evaluate(async settingsValue => window.dramaSlot.workbench.saveSettings({
      ...settingsValue,
      videoProvider: {
        ...settingsValue.videoProvider,
        storageMode: "direct-oss",
        ossAccessKeyId: "LTAI-packaged-audit",
        ossAccessKeySecret: "packaged-audit-secret-never-plain",
        ossBucket: "puream-packaged-audit",
        ossEndpoint: "oss-cn-hangzhou.aliyuncs.com",
        referenceUrlTtlSeconds: 7200
      }
    }), settings.settings);
    const rawOssSettings = fs.readFileSync(path.join(workbenchDir, "settings.json"), "utf8");
    const ossPersistence = await page.evaluate(async originalSettings => {
      const persisted = await window.dramaSlot.workbench.getSettings();
      const restored = await window.dramaSlot.workbench.saveSettings(originalSettings);
      return {
        saveOk: persisted.ok === true && restored.ok === true,
        storageMode: persisted.settings?.videoProvider?.storageMode || "",
        accessKeyId: persisted.settings?.videoProvider?.ossAccessKeyId || "",
        secret: persisted.settings?.videoProvider?.ossAccessKeySecret || "",
        bucket: persisted.settings?.videoProvider?.ossBucket || "",
        endpoint: persisted.settings?.videoProvider?.ossEndpoint || "",
        ttl: persisted.settings?.videoProvider?.referenceUrlTtlSeconds || 0
      };
    }, settings.settings);
    const defaultProject = await page.evaluate(() => window.dramaSlot.workbench.createProject("packaged default audit", {}));
    await page.evaluate(() => document.querySelector("#newProject")?.click());
    const newProjectDefaults = await page.evaluate(() => ({
      selectedProvider: document.querySelector("input[name='newVideoProvider']:checked")?.value || "",
      providerOptions: [...document.querySelectorAll("input[name='newVideoProvider']")].map(input => ({
        value: input.value,
        label: input.closest("label")?.innerText?.trim() || ""
      }))
    }));
    const durationModeUi = await page.evaluate(() => {
      const target = document.querySelector("#newTargetDuration");
      const help = document.querySelector("#newTargetDurationHelp");
      const manual = document.querySelector('input[name="newInputMode"][value="manual"]');
      const ai = document.querySelector('input[name="newInputMode"][value="ai"]');
      manual.checked = true;
      manual.dispatchEvent(new Event("change", { bubbles: true }));
      const manualState = { disabled: target.disabled, required: target.required, help: help.textContent.trim() };
      ai.checked = true;
      ai.dispatchEvent(new Event("change", { bubbles: true }));
      const aiState = { disabled: target.disabled, required: target.required, help: help.textContent.trim() };
      return { manualState, aiState };
    });
    await page.evaluate(() => document.querySelector("#newProjectDialog")?.close());
    const visibilityAudit = { surfaceLength: 0, forbiddenMatches: [], stages: [] };
    for (const stage of stageNames) {
      await page.evaluate(currentStage => document.querySelector(`.stage-button[data-stage="${currentStage}"]`)?.click(), stage);
      const stageSurface = await page.evaluate(currentStage => {
        const visible = node => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const panel = document.querySelector(`.stage-panel[data-panel="${currentStage}"]`);
        const fields = [...panel.querySelectorAll("textarea,input:not([type='hidden']):not([type='radio']):not([type='checkbox']):not([type='password'])")]
          .filter(visible)
          .map(node => node.value || "");
        const surface = [panel.innerText || "", ...fields].join("\n");
        return { stage: currentStage, surfaceLength: surface.length, forbiddenMatches: surface.match(/(?:\bH3\b|Hailuo|海螺)/gi) || [] };
      }, stage);
      visibilityAudit.surfaceLength += stageSurface.surfaceLength;
      visibilityAudit.forbiddenMatches.push(...stageSurface.forbiddenMatches);
      visibilityAudit.stages.push(stageSurface);
    }
    await page.evaluate(() => document.querySelector('.stage-button[data-stage="script"]')?.click());
    const switched = await page.evaluate(async settingsValue => {
      const result = await window.dramaSlot.workbench.saveSettings({
        ...settingsValue,
        videoProvider: {
          ...settingsValue.videoProvider,
          kind: "local-xiangsu",
          baseUrl: "http://127.0.0.1:28911"
        }
      });
      const persisted = await window.dramaSlot.workbench.getSettings();
      return { ok: result.ok, kind: persisted.settings?.videoProvider?.kind || "" };
    }, settings.settings);
    const stateTransitions = await page.evaluate(async firstProject => {
      const api = window.dramaSlot.workbench;
      const confirmedGeneration = {
        ...firstProject.generation,
        engine: "hailuo-h3",
        videoProviderKind: "puream-hailuo-h3",
        mode: "storyboard_sheet",
        modeConfirmed: true,
        targetDurationSeconds: 300
      };
      const firstPatch = await api.patchProject(firstProject.id, {
        generation: confirmedGeneration,
        productionPlan: { ...(firstProject.productionPlan || {}), executionMode: "step", inputMode: "ai" },
        automation: {
          ...(firstProject.automation || {}),
          status: "running",
          operation: "storyboards",
          stage: "storyboards",
          message: "MiniMax H3 internal status must be masked",
          updatedAt: new Date().toISOString()
        }
      });
      if (!firstPatch.ok) throw new Error(firstPatch.message || "failed to seed running project");
      const created = await api.createProject("packaged concurrent audit", {
        videoProviderKind: "puream-hailuo-h3",
        generationMode: "storyboard_sheet",
        executionMode: "step",
        inputMode: "manual",
        targetDurationSeconds: 300
      });
      if (!created.ok) throw new Error(created.message || "failed to create concurrent project");
      const manualPrompt = "USER-H3-Hailuo-海螺 literal must remain exact";
      const hostileMarkup = '<img id="audit-xss" src="x" onerror="window.__auditXss=1">';
      const secondPatch = await api.patchProject(created.project.id, {
        title: `packaged concurrent audit ${hostileMarkup}`,
        generation: {
          ...created.project.generation,
          engine: "hailuo-h3",
          videoProviderKind: "puream-hailuo-h3",
          mode: "storyboard_sheet",
          modeConfirmed: true,
          targetDurationSeconds: 300
        },
        productionPlan: { ...(created.project.productionPlan || {}), executionMode: "step", inputMode: "manual" },
        script: { ...(created.project.script || {}), raw: "用户手动剧本保持原样" },
        automation: {
          ...(created.project.automation || {}),
          status: "interrupted",
          operation: "shot_videos",
          stage: "videos",
          message: "Hailuo H3 internal status must be masked",
          updatedAt: new Date().toISOString()
        },
        jobs: [{
          id: "audit-failed-job",
          type: "shot_video",
          entityType: "shot",
          entityId: "S01",
          providerKind: "puream-hailuo-h3",
          status: "failed",
          progress: null,
          message: "MiniMax H3 internal job label and D:\\Secret\\customer.mp4 must be masked",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }],
        shots: [{
          id: "S01",
          number: 1,
          title: `手动镜头 ${hostileMarkup}`,
          duration: 8,
          promptMode: "manual",
          manualVideoPrompt: manualPrompt,
          dialogue: "母亲平静地说：我自己决定。"
        }]
      });
      if (!secondPatch.ok) throw new Error(secondPatch.message || "failed to seed concurrent project");
      return { firstId: firstProject.id, secondId: created.project.id, manualPrompt, hostileMarkup };
    }, defaultProject.project);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    const switchProject = async projectId => {
      await page.evaluate(id => {
        const select = document.querySelector("#projectSelect");
        select.value = id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, projectId);
      await page.waitForFunction(id => document.querySelector("#projectSelect")?.value === id && document.body.dataset.workbenchReady === "true", projectId, { timeout: 10_000 });
      await page.waitForTimeout(180);
    };
    await switchProject(stateTransitions.firstId);
    await switchProject(stateTransitions.secondId);
    await page.click('.library-nav-button[data-library="characters"]');
    await page.waitForFunction(() => document.querySelectorAll("#sidebarCharacterGridHost .sidebar-character-card").length > 0, null, { timeout: 10_000 });
    const crossProjectCharacterLibrary = await page.evaluate(async () => {
      const current = await window.dramaSlot.workbench.getProject(document.querySelector("#projectSelect")?.value || "");
      return {
        currentProjectCharacterCount: current.project?.characters?.length || 0,
        cardCount: document.querySelectorAll("#sidebarCharacterGridHost .sidebar-character-card").length,
        text: document.querySelector("#sidebarCharacterGridHost")?.innerText || "",
        visible: !document.querySelector("#sidebarLibraryPanel")?.classList.contains("hidden")
      };
    });
    await page.mouse.move(900, 500);
    await page.waitForTimeout(300);
    await captureBackground("cross-project-character-library-empty-project");
    await page.click("#closeSidebarLibrary");
    await page.evaluate(() => document.querySelector('.stage-button[data-stage="shots"]')?.click());
    const selectedStoryboardMode = await page.evaluate(() => document.querySelector("#generationMode")?.value || "");
    await page.evaluate(() => document.querySelector('.stage-button[data-stage="videos"]')?.click());
    const concurrencyUi = await page.evaluate(async seeded => {
      const prompt = document.querySelector(`[data-shot-prompt="S01"]`)?.value || "";
      const systemSurface = document.body.innerText || "";
      const first = await window.dramaSlot.workbench.getProject(seeded.firstId);
      return {
        selectedProjectId: document.querySelector("#projectSelect")?.value || "",
        topicDisabled: Boolean(document.querySelector("#generateTopics")?.disabled),
        videoDisabled: Boolean(document.querySelector("#generateAllVideos")?.disabled),
        storyboardButtonText: document.querySelector("#generateAllStoryboards")?.innerText?.trim() || "",
        manualPrompt: prompt,
        systemForbiddenMatches: systemSurface.match(/(?:\bH3\b|Hailuo|海螺)/gi) || [],
        systemContainsRawPath: systemSurface.includes("D:\\Secret\\customer.mp4"),
        firstAutomationStatus: first.project?.automation?.status || "",
        hostileMarkupExecuted: window.__auditXss === 1,
        hostileMarkupElementPresent: Boolean(document.querySelector("#audit-xss")),
        selectedProjectLabel: document.querySelector("#projectSelect")?.selectedOptions?.[0]?.textContent || "",
        specialFileUrl: fileUrl("D:\\素材\\片段#1?.mp4")
      };
    }, stateTransitions);
    const deleted = await page.evaluate(async projectId => {
      const api = window.dramaSlot.workbench;
      const removal = await api.deleteProject(projectId);
      const archives = await api.listDeletedProjects();
      const archive = archives.projects?.find(item => item.projectId === projectId || item.id === projectId) || archives.projects?.[0];
      const restoration = archive ? await api.restoreProject(archive.archiveId) : { ok: false, message: "archive missing" };
      const projects = await api.listProjects();
      return {
        removalOk: removal.ok === true,
        archiveFound: Boolean(archive),
        restorationOk: restoration.ok === true,
        restoredVisible: Boolean(projects.projects?.some(item => item.id === projectId))
      };
    }, stateTransitions.secondId);
    const runtime = await page.evaluate(() => ({
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.trim().length || 0,
      interactiveCount: document.querySelectorAll("button,input,select,textarea,a,[tabindex]").length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      blankImages: [...document.images].filter(img => !img.complete || img.naturalWidth === 0).length
    }));
    fs.writeFileSync(path.join(runDir, "preflight.json"), JSON.stringify({
      layoutMatrix,
      blueprintPopoverMatrix,
      scriptFormatDialogMatrix,
      persistentScriptExampleMatrix,
      scriptExamplePreviews,
      scriptExampleDownloads,
      rechargePolicy,
      blueprintOffState,
      stageMatrix,
      dialogMatrix,
      visibilityAudit,
      runtime,
      axe: axe.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length, help: item.help }))
    }, null, 2));
    assert.equal(defaults.appVersion, packageJson.version, "packaged runtime version must match package.json");
    assert.equal(defaults.providerKind, "puream-hailuo-h3", "packaged fresh default must use PUREAM cloud");
    assert.equal(settings.settings?.videoProvider?.kind, "puream-hailuo-h3", "fresh settings must use PUREAM cloud");
    assert.equal(ossSaved.ok, true, "direct OSS settings must be accepted by the packaged runtime");
    assert.deepEqual(ossPersistence, {
      saveOk: true,
      storageMode: "direct-oss",
      accessKeyId: "LTAI-packaged-audit",
      secret: "packaged-audit-secret-never-plain",
      bucket: "puream-packaged-audit",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      ttl: 7200
    }, "direct OSS settings must survive a packaged runtime round trip");
    assert.equal(rawOssSettings.includes("packaged-audit-secret-never-plain"), false, "packaged settings must not persist the OSS secret in plaintext");
    assert.equal(defaultProject?.project?.generation?.videoProviderKind, "puream-hailuo-h3", "fresh project must use PUREAM cloud");
    assert.equal(newProjectDefaults.selectedProvider, "puream-hailuo-h3", "new-project dialog must preselect PUREAM cloud");
    assert.ok(newProjectDefaults.providerOptions.some(item => item.value === "local-xiangsu" && /本地像塑/.test(item.label)), "local Xiangsu must remain selectable");
    assert.deepEqual({
      detailControlCount: blueprintControls.detailControlCount,
      bulkControlCount: blueprintControls.bulkControlCount,
      allOffEnabledCount: blueprintControls.allOffEnabledCount,
      allOnEnabledCount: blueprintControls.allOnEnabledCount,
      keyboardOpened: blueprintControls.keyboardOpened,
      keyboardClosed: blueprintControls.keyboardClosed,
      keyboardTabMoved: blueprintControls.keyboardTabMoved,
      focusEnteredDialog: blueprintControls.focusEnteredDialog
    }, {
      detailControlCount: 26,
      bulkControlCount: 4,
      allOffEnabledCount: 0,
      allOnEnabledCount: 13,
      keyboardOpened: true,
      keyboardClosed: true,
      keyboardTabMoved: true,
      focusEnteredDialog: true
    }, "all blueprint details and bulk controls must persist and remain keyboard-operable");
    assert.equal(durationModeUi.manualState.disabled, true, "uploaded-script mode must disable the configured duration field");
    assert.equal(durationModeUi.manualState.required, false, "uploaded-script mode must not require a configured duration");
    assert.match(durationModeUi.manualState.help, /自适应/, "uploaded-script mode must explain adaptive duration");
    assert.equal(durationModeUi.aiState.disabled, false, "AI mode must enable configured duration");
    assert.equal(durationModeUi.aiState.required, true, "AI mode must require configured duration");
    assert.match(durationModeUi.aiState.help, /严格/, "AI mode must explain the hard duration contract");
    assert.deepEqual(visibilityAudit.forbiddenMatches, [], "user-visible flow must not expose H3/Hailuo/海螺");
    assert.deepEqual(switched, { ok: true, kind: "local-xiangsu" }, "manual local switch must persist");
    assert.equal(concurrencyUi.selectedProjectId, stateTransitions.secondId, "switching away from a running project must complete");
    assert.deepEqual({
      currentProjectCharacterCount: crossProjectCharacterLibrary.currentProjectCharacterCount,
      cardCount: crossProjectCharacterLibrary.cardCount,
      visible: crossProjectCharacterLibrary.visible
    }, { currentProjectCharacterCount: 0, cardCount: 1, visible: true }, "an empty project must still show the global cross-project character library");
    assert.match(crossProjectCharacterLibrary.text, /跨项目测试人物/);
    assert.match(crossProjectCharacterLibrary.text, /另一个历史项目/);
    assert.equal(selectedStoryboardMode, "storyboard_sheet", "storyboard-sheet mode must survive reload and project switches");
    assert.equal(concurrencyUi.topicDisabled, false, "another project's topic button must not inherit the running project's lock");
    assert.equal(concurrencyUi.videoDisabled, false, "another project's explicit video button must remain available");
    assert.match(concurrencyUi.storyboardButtonText, /逐秒合图/, "storyboard-sheet mode must expose the sheet action");
    assert.doesNotMatch(concurrencyUi.storyboardButtonText, /尾帧/, "storyboard-sheet action must not request a tail frame");
    assert.equal(concurrencyUi.manualPrompt, stateTransitions.manualPrompt, "manual prompt text must remain byte-for-byte visible");
    assert.deepEqual(concurrencyUi.systemForbiddenMatches, [], "system-rendered status must mask internal model names");
    assert.equal(concurrencyUi.systemContainsRawPath, false, "system-rendered failures must mask local filesystem paths");
    assert.equal(concurrencyUi.firstAutomationStatus, "running", "switching projects must not cancel the background project");
    assert.equal(concurrencyUi.hostileMarkupExecuted, false, "persisted project text must never execute as markup");
    assert.equal(concurrencyUi.hostileMarkupElementPresent, false, "persisted project text must be rendered as text, not HTML");
    assert.ok(concurrencyUi.selectedProjectLabel.includes(stateTransitions.hostileMarkup), "escaped hostile project text must remain visible as literal text");
    assert.match(concurrencyUi.specialFileUrl, /^file:\/\/\/D:\/.*%231%3F\.mp4$/i, "special filename characters must remain inside the file URL path");
    assert.deepEqual(deleted, { removalOk: true, archiveFound: true, restorationOk: true, restoredVisible: true }, "packaged project deletion must be recoverable");
    assert.equal(layoutMatrix.some(item => item.pageHorizontalOverflow), false, "page must not horizontally overflow in the audited matrix");
    assert.equal(layoutMatrix.some(item => item.topbarHorizontalOverflow), false, "topbar must reflow without horizontal scrolling in the audited matrix");
    assert.equal(layoutMatrix.some(item => item.mainStageHorizontalOverflow), false, "main stage must reflow without horizontal scrolling in the audited matrix");
    assert.equal(layoutMatrix.some(item => item.topControlOverlaps.length), false, "topbar controls must not overlap in the audited matrix");
    assert.equal(layoutMatrix.some(item => item.visibleStageButtons < 6), false, "all stage navigation entries must remain reachable");
    assert.equal(blueprintPopoverMatrix.some(item => (
      item.collapsed.clipped
      || item.expanded.clipped
      || item.collapsed.horizontalOverflow
      || item.expanded.horizontalOverflow
      || item.collapsed.position !== "fixed"
      || !item.collapsed.backgroundOpaque
      || !item.expanded.backgroundOpaque
      || item.collapsed.detailsOpen
      || !item.expanded.detailsOpen
      || !item.collapsed.closeVisible
      || !item.collapsed.masterVisible
      || !item.bottomReachability
    )), false, "blueprint panel must stay opaque, fixed, unclipped, compact by default, and fully reachable at every audited size and zoom");
    assert.equal(scriptFormatDialogMatrix.some(item => item.optionCount !== 3 || item.clipped || item.horizontalOverflow || !item.confirmReachable), false, "all three script formats and the confirm action must remain reachable at every audited size and zoom");
    assert.equal(persistentScriptExampleMatrix.some(item => !item.visible || item.previewCount !== 3 || item.downloadCount !== 3 || item.horizontalOverflow || item.clippedHorizontally || item.undersizedButtons.length), false, "all three script examples must stay visible, previewable, downloadable, and touch-safe on the script page");
    assert.equal(scriptExamplePreviews.some(item => !item.open || !item.filename.endsWith(".txt") || item.bodyLength < 100 || !item.expectedContentPresent), false, "every script example preview must expose a complete matching TXT example");
    assert.equal(scriptExampleDownloads.length, 3, "all three persistent script example downloads must be wired");
    assert.equal(scriptExampleDownloads.some(item => !item.filename.endsWith(".txt") || item.bodyLength < 100 || !item.startsWithHeading), false, "all script example downloads must contain non-empty TXT scripts");
    assert.equal(rechargePolicy.inputMin, 50, "desktop recharge dialog must start at 50 yuan");
    assert.match(rechargePolicy.help, /软件内.*50.*官网.*30/, "desktop recharge help must distinguish the 50 yuan app rule from the 30 yuan website rule");
    assert.match(rechargePolicy.invalidAmountError, /最低 50 元/, "49 yuan must be rejected locally before any order request");
    assert.equal(rechargePolicy.orderPanelHidden, true, "an invalid desktop recharge amount must not create or expose an order");
    assert.equal(blueprintOffState.clipped, false, "disabled blueprint panel must remain inside the viewport");
    assert.equal(blueprintOffState.horizontalOverflow, false, "disabled blueprint panel must not horizontally overflow");
    assert.equal(blueprintOffState.configHidden, true, "disabled blueprint panel must hide inactive configuration");
    assert.equal(blueprintOffState.noteVisible, true, "disabled blueprint panel must explain the closed state");
    assert.equal(blueprintOffState.detailsCollapsed, true, "disabled blueprint panel must collapse audit details");
    assert.ok(blueprintOffState.height <= 280, "disabled blueprint panel must stay compact instead of covering the workbench");
    assert.equal(stageMatrix.some(item => !item.active || item.horizontalOverflow), false, "every production stage must activate without horizontal overflow");
    assert.equal(stageMatrix.some(item => item.undersized.length), false, "visible stage controls must keep a 44px minimum target");
    assert.equal(stageMatrix.some(item => item.seriousAxe.length), false, "production stages must have no serious accessibility violation");
    assert.equal(dialogMatrix.some(item => !item.open || item.clipped || item.horizontalOverflow), false, "primary dialogs must remain visible and uncut");
    assert.equal(dialogMatrix.some(item => item.seriousAxe.length), false, "primary dialogs must have no serious accessibility violation");
    assert.equal(axe.violations.some(item => ["critical", "serious"].includes(item.impact)), false, "critical/serious accessibility violations are release blockers");
    const report = {
      executablePath,
      runDir,
      screenshots,
      defaults: { appVersion: defaults.appVersion, providerKind: defaults.providerKind, providerName: defaults.providerName },
      settingsProviderKind: settings.settings?.videoProvider?.kind || "",
      ossPersistence: { ...ossPersistence, secret: "[verified but omitted]", plaintextPersisted: rawOssSettings.includes("packaged-audit-secret-never-plain") },
      defaultProjectProviderKind: defaultProject?.project?.generation?.videoProviderKind || "",
      newProjectDefaults,
      blueprintControls,
      durationModeUi,
      visibilityAudit,
      manualSwitch: switched,
      selectedStoryboardMode,
      crossProjectCharacterLibrary,
      concurrencyUi,
      deletedProjectRoundTrip: deleted,
      runtime,
      layoutMatrix,
      blueprintPopoverMatrix,
      scriptFormatDialogMatrix,
      persistentScriptExampleMatrix,
      scriptExamplePreviews,
      scriptExampleDownloads,
      rechargePolicy,
      blueprintOffState,
      stageMatrix,
      dialogMatrix,
      axe: {
        violations: axe.violations.map(item => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.length,
          help: item.help
        })),
        criticalOrSerious: axe.violations.filter(item => ["critical", "serious"].includes(item.impact)).length
      }
    };
    fs.writeFileSync(path.join(runDir, "audit.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
