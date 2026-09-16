"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const axeSource = require("axe-core").source;
const { defaultProject, defaultSettings } = require("../app/workbench-store");

const root = path.resolve(__dirname, "..");
const evidenceDir = path.join(root, ".codex_tests", "TASK-20260905-DRAMA-ROUGH-CUT-SFX-001", "rough-cut-ui");
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function fixtureProject() {
  const project = defaultProject("智能粗剪演示", { inputMode: "manual", executionMode: "step", mode: "asset_direct" });
  project.status = "complete";
  project.currentStage = "final";
  project.productionRevision = "audit-r1";
  project.shots = [1, 2, 3].map(number => ({ id: `S0${number}`, number, title: number === 1 ? "身份揭晓" : number === 2 ? "雨夜争执" : "产品亮相", duration: 12 }));
  project.candidates = project.shots.map(shot => ({
    id: `video-${shot.id}`,
    entityType: "shot",
    entityId: shot.id,
    stage: "shot_video",
    selected: true,
    stale: false,
    filePath: `D:/audit/${shot.id}.mp4`,
    productionRevision: project.productionRevision
  }));
  project.finalVideoPath = "D:/audit/roughcut.mp4";
  project.finalVideoSource = "generated";
  project.finalQualityAudit = { ok: true, failures: [] };
  project.mediaQualityAudit = { ok: true, failures: [] };
  project.roughCutAudioCleanup = { totalTrimmedSeconds: 0.47, shots: [] };
  project.postProductionSfxPlan = { cueCount: 8, catalogSize: 150, generatedAudio: false, shots: [] };
  project.postProductionSfxAudit = { ok: true, failures: [], cueCount: 8 };
  project.postProductionMixResult = { applied: true, cueCount: 8, uniqueAssetCount: 6, warning: "" };
  return project;
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const project = fixtureProject();
  const settings = defaultSettings();
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const reports = [];
  try {
    for (const view of [{ width: 1024, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      const context = await browser.newContext({ viewport: view });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
      await page.addInitScript(({ projectValue, settingsValue }) => {
        const clone = value => structuredClone(value);
        const ok = value => ({ ok: true, ...value });
        const handlers = {
          getSettings: async () => ok({ settings: clone(settingsValue) }),
          authStatus: async () => ok({ configured: true, active: true }),
          listProjects: async () => ok({ projects: [{ id: projectValue.id, title: projectValue.title, status: projectValue.status }] }),
          getProject: async () => ok({ project: clone(projectValue) }),
          patchProject: async () => ok({ project: clone(projectValue) }),
          getStorageLocation: async () => ok({ rootDir: "D:/audit" }),
          listVoiceLibrary: async () => ok({ voices: [] }),
          listReusableAssets: async () => ok({ assets: [] }),
          listProjectsOverview: async () => ok({ projects: [] }),
          accountSwitchStatus: async () => ok({ state: { status: "idle", pendingJobs: [] } }),
          walletStatus: async () => ok({ wallet: { availableCents: 10000, frozenCents: 0 } }),
          syncVideoJobs: async () => ok({ jobs: [] }),
          listTextModels: async () => ok({ models: [] })
        };
        window.dramaSlot = {
          defaults: async () => ({ appVersion: "audit", captureMode: true, isPackaged: false }),
          checkUpdate: async () => ({ status: "latest" }),
          onUpdateStatus: () => {},
          appMode: { select: async () => ({ ok: true }) },
          workbench: new Proxy(handlers, { get: (target, key) => target[key] || (async () => ok({})) })
        };
      }, { projectValue: project, settingsValue: settings });
      await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=final`);
      await page.waitForLoadState("domcontentloaded");
      try {
        await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 20_000 });
      } catch (error) {
        const state = await page.evaluate(() => ({ dataset: { ...document.body.dataset }, text: document.body.innerText.slice(0, 500), hasBridge: Boolean(window.dramaSlot) }));
        throw new Error(`rough-cut UI did not become ready: ${JSON.stringify({ state, pageErrors })}; ${error.message}`);
      }
      await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
      await page.locator('.stage-button[data-stage="final"]').click();
      await page.waitForFunction(() => document.querySelector('.stage-panel[data-panel="final"]')?.classList.contains("active"));
      const layout = await page.evaluate(() => {
        const stage = document.querySelector('.stage-panel[data-panel="final"]');
        const button = document.querySelector("#stitchVideo");
        const notice = document.querySelector("#finalQualityNotice");
        return {
          heading: stage?.querySelector("h2")?.textContent || "",
          body: stage?.innerText || "",
          buttonText: button?.textContent || "",
          notice: notice?.textContent || "",
          bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          stageOverflow: stage ? stage.scrollWidth > stage.clientWidth + 1 : true,
          buttonClipped: button ? button.scrollWidth > button.clientWidth + 1 : true
        };
      });
      await page.evaluate(axeSource);
      const axe = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
      const serious = axe.violations.filter(item => ["critical", "serious"].includes(item.impact));
      assert.match(layout.heading, /智能粗剪/);
      assert.match(layout.body, /150种本地固定音效/);
      assert.match(layout.notice, /Agent 已匹配 8 个固定音效/);
      assert.equal(layout.bodyOverflow, false);
      assert.equal(layout.stageOverflow, false);
      assert.equal(layout.buttonClipped, false);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(serious, []);
      const screenshot = path.join(evidenceDir, `rough-cut-${view.width}x${view.height}.png`);
      await page.screenshot({ path: screenshot, animations: "disabled", fullPage: true });
      reports.push({ view, layout, serious, pageErrors, screenshot });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const report = { ok: true, reports };
  fs.writeFileSync(path.join(evidenceDir, "audit.json"), JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
