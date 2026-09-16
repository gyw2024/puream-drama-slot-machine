"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const axeSource = require("axe-core").source;
const { WorkbenchStore, defaultSettings } = require("../app/workbench-store");

const root = path.resolve(__dirname, "..");
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const evidenceDir = path.resolve(process.env.PRODUCT_CONTEXT_UI_EVIDENCE_DIR
  || path.join(root, ".codex_tests", "TASK-20260825-DRAMA-CONTINUOUS-RECOVERY-002", "product-context-ui"));
const views = [
  { name: "1024x720-100", width: 1024, height: 720, dpr: 1 },
  { name: "1280x800-100", width: 1280, height: 800, dpr: 1 },
  { name: "1280x800-200", width: 640, height: 400, dpr: 2 }
];

function recoveredFixture() {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "drama-product-ui-"));
  const store = new WorkbenchStore(storeRoot);
  const project = store.createProject("商品自动适配界面审计", {
    inputMode: "ai",
    executionMode: "step",
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    commerceMode: "natural",
    mode: "storyboard_sheet",
    modeConfirmed: true
  });
  project.product = { name: "护眼台灯", sellingPoints: "柔光；定时关闭", description: "柔光；定时关闭", imagePath: "D:/audit/product.png", publicUrl: "" };
  project.ideation = {
    ...(project.ideation || {}),
    status: "failed",
    errorCode: "TOPIC_PRODUCT_CONTEXT_STALE",
    message: "商品资料在选题生成后发生了变化，请重新生成一轮适配当前商品的选题",
    selectedTopicId: "topic-1",
    topics: [{ id: "topic-1", title: "灯亮以后", relationship: "母女", logline: "女儿在雨夜发现母亲多年隐瞒的付出", hook: "母亲把旧灯放到门外", reversal: "灯里藏着缴费单", highlights: ["冲突", "证据", "和解"], productPlacement: "旧商品节点" }],
    topicProductContext: { commerceMode: "natural", name: "旧商品", sellingPoints: "旧卖点", imagePath: "D:/old.png" }
  };
  project.script = {
    ...(project.script || {}),
    qualityAudit: { ok: true, skipped: true, failures: [], ignoredFailures: [{ code: "ADVISORY", message: "仅供审计" }] },
    semanticReview: { ok: true, skipped: true, scored: false, verdict: "skipped", scores: {}, hardFailures: [], summary: "审核蓝图已关闭" }
  };
  project.automation = { ...(project.automation || {}), status: "failed", operation: "idea_script", stage: "script", message: project.ideation.message, errorCode: "TOPIC_PRODUCT_CONTEXT_STALE" };
  store.saveProject(project);
  const recovered = store.getProject(project.id);
  return { recovered, storeRoot };
}

async function installBridge(page, projectValue) {
  await page.addInitScript(({ fixture, settings }) => {
    let project = structuredClone(fixture);
    const clone = value => structuredClone(value);
    const ok = value => ({ ok: true, ...value });
    window.dramaSlot = {
      defaults: async () => ({ appVersion: "audit", captureMode: true, isPackaged: true }),
      checkUpdate: async () => ({ status: "latest" }), installUpdate: async () => ({ ok: true }), onUpdateStatus: () => () => {},
      health: async () => ({ ok: true, ready: true, sessionReady: true, remote: true }), startBridge: async () => ({ ok: true }), hideXiangsu: async () => ({ ok: true }),
      appMode: { select: async () => ({ ok: true, mode: "agent" }) },
      workbench: {
        getSettings: async () => ok({ settings: clone(settings) }), authStatus: async () => ok({ configured: true, masked: "audit" }),
        listProjects: async () => ok({ projects: [{ id: project.id, title: project.title, status: project.status, updatedAt: project.updatedAt }] }),
        getProject: async () => ok({ project: clone(project) }),
        patchProject: async (_id, patch) => { project = { ...project, ...clone(patch || {}) }; return ok({ project: clone(project) }); },
        getStorageLocation: async () => ok({ rootDir: "D:/audit/product-context" }),
        listVoiceLibrary: async () => ok({ voices: [] }), listReusableAssets: async () => ok({ assets: [] }),
        accountSwitchStatus: async () => ok({ state: { status: "idle", pendingJobs: [], message: "" } }),
        listProjectsOverview: async () => ok({ projects: [] }), walletStatus: async () => ok({ wallet: { availableCents: 10000, frozenCents: 0 } }),
        syncVideoJobs: async () => ok({ jobs: [] })
      }
    };
  }, { fixture: projectValue, settings: defaultSettings() });
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const { recovered, storeRoot } = recoveredFixture();
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const results = [];
  try {
    for (const view of views) {
      const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: view.dpr });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
      await installBridge(page, recovered);
      await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=script`);
      await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 15_000 });
      await page.waitForTimeout(200);
      await page.evaluate(axeSource);
      const state = await page.evaluate(async () => ({
        bodyText: document.body.innerText,
        help: document.querySelector("#topicProductGateHelp")?.textContent || "",
        writeDisabled: Boolean(document.querySelector("#generateCompleteScript")?.disabled),
        pipelineDisabled: Boolean(document.querySelector("#runIdeaPipeline")?.disabled),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        seriousAxe: (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })).violations.filter(item => ["serious", "critical"].includes(item.impact)).length
      }));
      assert.deepEqual(pageErrors, [], `${view.name} renderer errors`);
      assert.doesNotMatch(state.bodyText, /商品资料在选题生成后发生了变化|重新生成一轮适配当前商品的选题|写作失败/);
      assert.match(state.help, /保留现有选题.*自动.*不用重新抽题/);
      assert.equal(state.writeDisabled, false);
      assert.equal(state.pipelineDisabled, false);
      assert.equal(state.horizontalOverflow, false);
      assert.equal(state.seriousAxe, 0);
      await page.locator('.stage-button[data-stage="final"]').click();
      await page.waitForTimeout(50);
      const qualityText = await page.locator("#qualityGatePanel").textContent();
      assert.match(qualityText, /不评分、不拦截/);
      assert.match(qualityText, /未评分.*虚假100分/);
      assert.doesNotMatch(qualityText, /均≥80分/);
      const qualityScreenshot = path.join(evidenceDir, `${view.name}-quality-unscored.png`);
      await page.locator("#qualityGatePanel").screenshot({ path: qualityScreenshot, animations: "disabled" });
      await page.locator('.stage-button[data-stage="script"]').click();
      const screenshot = path.join(evidenceDir, `${view.name}.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      const contextScreenshot = path.join(evidenceDir, `${view.name}-product-context.png`);
      await page.locator("#topicProductSetup").scrollIntoViewIfNeeded();
      await page.locator("#topicProductSetup").screenshot({ path: contextScreenshot, animations: "disabled" });
      results.push({ view: view.name, help: state.help, screenshot, contextScreenshot, qualityScreenshot });
      await context.close();
    }
    const report = { ok: true, recoveredState: { ideationStatus: recovered.ideation.status, automationStatus: recovered.automation.status }, results };
    fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await browser.close();
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
