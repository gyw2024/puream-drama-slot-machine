"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright-core");
const axeSource = require("axe-core").source;

async function main() {
  const root = path.resolve(__dirname, "..");
  const executablePath = path.join(root, "dist-fixed-0.13.16", "win-unpacked", "纯梦短剧老虎机.exe");
  const evidenceDir = path.resolve(root, "..", "..", "..", ".codex_tests", "TASK-20260812-DRAMA-SCRIPT-SPEED-EMOTION-051", "packaged-ui");
  const runDir = path.join(evidenceDir, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });

  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: workbenchDir }
  });

  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await page.evaluate(() => {
      const licenseGate = document.querySelector("#licenseGate");
      if (licenseGate) licenseGate.hidden = true;
    });

    const screenshots = [];
    for (const viewport of [{ width: 1180, height: 820 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.setContentSize(size.width, size.height);
      }, viewport);
      await page.waitForTimeout(250);
      const screenshotPath = path.join(runDir, `main-window-${viewport.width}x${viewport.height}.png`);
      const pngBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) throw new Error("Electron window is unavailable for background capture");
        return (await win.webContents.capturePage()).toPNG().toString("base64");
      });
      fs.writeFileSync(screenshotPath, Buffer.from(pngBase64, "base64"));
      screenshots.push(screenshotPath);
    }
    await page.evaluate(axeSource);
    const axe = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
    }));
    const defaults = await page.evaluate(() => window.dramaSlot.defaults());
    const settings = await page.evaluate(() => window.dramaSlot.workbench.getSettings());
    const defaultProject = await page.evaluate(() => window.dramaSlot.workbench.createProject("packaged default audit", {}));
    await page.evaluate(() => document.querySelector("#newProject")?.click());
    const newProjectDefaults = await page.evaluate(() => ({
      selectedProvider: document.querySelector("input[name='newVideoProvider']:checked")?.value || "",
      providerOptions: [...document.querySelectorAll("input[name='newVideoProvider']")].map(input => ({
        value: input.value,
        label: input.closest("label")?.innerText?.trim() || ""
      }))
    }));
    await page.evaluate(() => document.querySelector("#newProjectDialog")?.close());
    const visibilityAudit = await page.evaluate(() => {
      const fields = [...document.querySelectorAll("textarea,input:not([type='hidden']):not([type='radio']):not([type='checkbox']):not([type='password'])")]
        .filter(node => !node.hidden)
        .map(node => node.value || "");
      const surface = [document.body?.innerText || "", ...fields].join("\n");
      return {
        surfaceLength: surface.length,
        forbiddenMatches: surface.match(/(?:\bH3\b|Hailuo|海螺)/gi) || []
      };
    });
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
    assert.equal(defaults.providerKind, "puream-hailuo-h3", "packaged fresh default must use PUREAM cloud");
    assert.equal(settings.settings?.videoProvider?.kind, "puream-hailuo-h3", "fresh settings must use PUREAM cloud");
    assert.equal(defaultProject?.project?.generation?.videoProviderKind, "puream-hailuo-h3", "fresh project must use PUREAM cloud");
    assert.equal(newProjectDefaults.selectedProvider, "puream-hailuo-h3", "new-project dialog must preselect PUREAM cloud");
    assert.ok(newProjectDefaults.providerOptions.some(item => item.value === "local-xiangsu" && /本地像塑/.test(item.label)), "local Xiangsu must remain selectable");
    assert.deepEqual(visibilityAudit.forbiddenMatches, [], "user-visible flow must not expose H3/Hailuo/海螺");
    assert.deepEqual(switched, { ok: true, kind: "local-xiangsu" }, "manual local switch must persist");
    const report = {
      executablePath,
      runDir,
      screenshots,
      defaults: { providerKind: defaults.providerKind, providerName: defaults.providerName },
      settingsProviderKind: settings.settings?.videoProvider?.kind || "",
      defaultProjectProviderKind: defaultProject?.project?.generation?.videoProviderKind || "",
      newProjectDefaults,
      visibilityAudit,
      manualSwitch: switched,
      runtime,
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
