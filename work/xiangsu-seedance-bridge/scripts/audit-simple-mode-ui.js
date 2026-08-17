"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const axeSource = require("axe-core").source;
const { WorkbenchStore } = require("../app/workbench-store");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function electronLaunchOptions(root, userDataDir, env) {
  const executablePath = String(process.env.DRAMA_SLOT_SIMPLE_AUDIT_EXE || "").trim();
  if (executablePath) {
    assert.ok(fs.existsSync(executablePath), `Packaged executable missing: ${executablePath}`);
    return { executablePath, args: [`--user-data-dir=${userDataDir}`], env };
  }
  return { args: [root, `--user-data-dir=${userDataDir}`], env };
}

function preparePackagedUserData(root, userDataDir, mode = "") {
  if (!String(process.env.DRAMA_SLOT_SIMPLE_AUDIT_EXE || "").trim()) return;
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE
    || path.join(process.env.APPDATA || "", packageJson.name, "drama-license.json");
  assert.ok(fs.existsSync(licenseSource), "Packaged Simple audit requires an existing activation snapshot");
  const localStateSource = path.join(path.dirname(licenseSource), "Local State");
  assert.ok(fs.existsSync(localStateSource), "Packaged Simple audit requires the Electron Local State encryption key");
  fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
  fs.copyFileSync(localStateSource, path.join(userDataDir, "Local State"));
  if (mode) {
    fs.writeFileSync(path.join(userDataDir, "workspace-mode.json"), JSON.stringify({
      version: 1,
      mode,
      updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
  }
}

function selectedCandidate({ id, entityType, entityId, stage, filePath, revision }) {
  return {
    id,
    entityType,
    entityId,
    stage,
    filePath,
    selected: true,
    stale: false,
    productionRevision: revision,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function seedSimpleWorkspace(root, workbenchDir) {
  const simpleRoot = path.join(workbenchDir, "simple-mode");
  const store = new WorkbenchStore(simpleRoot, { sharedLibraryRoot: workbenchDir });
  const project = store.createProject("审计样片：旧信里的真相", {
    inputMode: "manual",
    executionMode: "step",
    scriptFormat: "dialogue",
    scriptFormatConfirmed: true,
    commerceMode: "none",
    targetDurationSeconds: 20,
    mode: "storyboard_sheet",
    videoProviderKind: "puream-hailuo-h3"
  });
  const revision = "simple-ui-audit-r1";
  const projectAssetDir = path.join(simpleRoot, "projects", project.id, "assets", "audit");
  fs.mkdirSync(projectAssetDir, { recursive: true });
  const sourceImage = path.join(root, "app", "assets", "drama-slot-mark.png");
  const characterImage = path.join(projectAssetDir, "character.png");
  const sharedImage = path.join(workbenchDir, "reusable-asset-library", "files", "shared-character.png");
  fs.mkdirSync(path.dirname(sharedImage), { recursive: true });
  fs.copyFileSync(sourceImage, characterImage);
  fs.copyFileSync(sourceImage, sharedImage);

  project.productionRevision = revision;
  project.status = "producing";
  project.currentStage = "assets";
  project.script = {
    ...project.script,
    raw: "【客厅，雨夜】\n林娜（压住怒气）：你把那封信还给我。\n秦添（愧疚低声）：我看完才知道错怪你了。",
    analyzedAt: new Date().toISOString()
  };
  project.generation = {
    ...project.generation,
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "storyboard_sheet",
    modeConfirmed: true,
    targetDurationSeconds: 20
  };
  project.characters = [
    { id: "C01", name: "林娜", description: "四十岁，短发，深灰风衣，神情克制但坚定", identitySignature: "短发、清晰眉骨、左眼下小痣" },
    { id: "C02", name: "秦添", description: "四十五岁，深色衬衫，眼神躲闪", identitySignature: "窄脸、细框眼镜、微驼背" }
  ];
  project.scenes = [
    { id: "SC01", name: "旧宅客厅", description: "固定空间结构，雨夜窗光，木桌与旧信封", atmosphere: "窗外雨声，室内安静" }
  ];
  project.assetLibraries = {
    ...(project.assetLibraries || {}),
    props: [{ id: "prop_letter", name: "旧信封", description: "推动误会反转的唯一核心证物", storyFunction: "揭示真相" }],
    wardrobes: [],
    voices: []
  };
  project.shots = [
    {
      id: "S01", number: 1, title: "夺回旧信", duration: 10, sceneName: "旧宅客厅", shotSize: "林娜近景",
      action: "林娜按住桌上的旧信封，直视秦添。", visualBeat: "手掌压住信封，雨光掠过脸侧。",
      dialogue: "林娜（压住怒气）：你把那封信还给我。", cameraMove: "稳定近景后轻推",
      manualVideoPrompt: "0-6秒林娜近景压住旧信封，带怒意但克制地说完整对白；6-10秒切秦添反应近景。"
    },
    {
      id: "S02", number: 2, title: "承认误会", duration: 10, sceneName: "旧宅客厅", shotSize: "秦添近景",
      action: "秦添松开信封，低头承认错误。", visualBeat: "手指离开信封，视线下垂。",
      dialogue: "秦添（愧疚低声）：我看完才知道错怪你了。", cameraMove: "反打近景",
      manualVideoPrompt: "0-7秒切秦添近景，愧疚低声说完整对白；7-10秒切林娜听者反应。"
    }
  ];
  project.candidates = [
    selectedCandidate({ id: "card-c01", entityType: "character", entityId: "C01", stage: "character_sheet", filePath: characterImage, revision })
  ];
  project.jobs = [{
    id: "job-c02", type: "character_sheet", entityType: "character", entityId: "C02", status: "running",
    message: "AI 正在生成固定纯色背景人物四视图", progress: 46, productionRevision: revision,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }];
  project.automation = {
    ...(project.automation || {}),
    // "pausing" is a genuine live state: the local scheduler has stopped
    // opening new work while an already-submitted upstream item continues to
    // sync. Unlike a fabricated pre-start "running" flag it must survive the
    // detached-operation reconciler and remain visible in the renderer.
    status: "pausing",
    stage: "assets",
    progress: { completed: 1, total: 4, items: [{ key: "character:C02", entityId: "C02", status: "running" }] },
    concurrency: { image: 8, video: 16 }
  };
  project.activity = [
    { id: "activity-1", at: new Date().toISOString(), type: "asset_generation", summary: "人物林娜资产已就绪，秦添正在生成" },
    { id: "activity-2", at: new Date(Date.now() - 60_000).toISOString(), type: "script_analysis", summary: "AI 已保留原对白并完成两个分镜" }
  ];
  store.saveProject(project);

  const sharedIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    assets: [{
      id: "shared-character-audit",
      kind: "character",
      mediaType: "image",
      stage: "character_sheet",
      label: "跨模式共享人物",
      description: "只通过共享资产库复用，不携带任何项目、任务或费用数据",
      filePath: sharedImage,
      sha256: sha256(sharedImage),
      fingerprint: `character:${sha256(sharedImage)}`,
      source: { projectId: "agent-audit-project", projectTitle: "Agent 模式历史项目" },
      useCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  };
  fs.mkdirSync(path.join(workbenchDir, "reusable-asset-library"), { recursive: true });
  fs.writeFileSync(path.join(workbenchDir, "reusable-asset-library", "index.json"), JSON.stringify(sharedIndex, null, 2), "utf8");
  return { projectId: project.id, characterImage, sharedImage };
}

function publicConsoleError(message) {
  const text = String(message || "");
  return !/net::ERR_(?:ABORTED|FAILED).*puream\.cn/i.test(text);
}

async function setWindowView(electronApp, page, view) {
  await electronApp.evaluate(({ BrowserWindow }, next) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("Electron window is unavailable");
    win.webContents.setZoomFactor(1);
    win.setContentSize(next.width, next.height);
    win.webContents.setZoomFactor(next.zoom);
  }, view);
  await page.waitForTimeout(250);
}

async function capture(page, filePath) {
  await page.screenshot({ path: filePath, animations: "disabled" });
  return filePath;
}

async function openPanel(page, panelName) {
  const button = page.locator(`.nav-button[data-panel="${panelName}"]`);
  if (!await button.isVisible()) await page.locator("#simpleMore > summary").click();
  await button.click();
}

async function runAxe(page, panelName) {
  await page.evaluate(axeSource);
  if (panelName) await openPanel(page, panelName);
  const result = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
  }));
  return result.violations
    .filter(item => ["critical", "serious"].includes(item.impact))
    .map(item => ({
      id: item.id,
      impact: item.impact,
      help: item.help,
      nodes: item.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary }))
    }));
}

async function auditSimple(root, runDir, workbenchDir) {
  const userDataDir = path.join(runDir, "simple-user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  preparePackagedUserData(root, userDataDir, "simple");
  const runtime = { consoleErrors: [], pageErrors: [], requestFailures: [] };
  const env = {
    ...process.env,
    DRAMA_LICENSE_BYPASS: "1",
    DRAMA_SLOT_WORKSPACE_MODE: "simple",
    DRAMA_SLOT_DATA_ROOT: workbenchDir
  };
  const electronApp = await electron.launch(electronLaunchOptions(root, userDataDir, env));
  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    page.on("console", message => {
      if (message.type() === "error" && publicConsoleError(message.text())) runtime.consoleErrors.push(message.text());
    });
    page.on("pageerror", error => runtime.pageErrors.push(String(error?.stack || error)));
    page.on("requestfailed", request => runtime.requestFailures.push({ url: request.url(), error: request.failure()?.errorText || "" }));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.dataset.simpleModeReady === "true" || document.body.dataset.modeSelectorReady === "true", null, { timeout: 30_000 });
    if (await page.evaluate(() => document.body.dataset.modeSelectorReady === "true")) {
      await page.locator('[data-mode="simple"]').click();
      await page.waitForFunction(() => document.body.dataset.simpleModeReady === "true", null, { timeout: 30_000 });
    }

    const viewMatrix = [
      { width: 1280, height: 800, zoom: 1 },
      { width: 1440, height: 900, zoom: 1 },
      { width: 1920, height: 1080, zoom: 1 },
      { width: 1280, height: 800, zoom: 1.25 },
      { width: 1280, height: 800, zoom: 1.5 },
      { width: 1280, height: 800, zoom: 2 }
    ];
    const layouts = [];
    const screenshots = [];
    for (const view of viewMatrix) {
      await setWindowView(electronApp, page, view);
      await page.locator('.nav-button[data-panel="overview"]').click();
      const layout = await page.evaluate(() => {
        const visible = node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const controls = [...document.querySelectorAll(".topbar button,.topbar select")].filter(visible);
        const overlaps = [];
        controls.forEach((leftNode, leftIndex) => {
          const left = leftNode.getBoundingClientRect();
          controls.slice(leftIndex + 1).forEach(rightNode => {
            const right = rightNode.getBoundingClientRect();
            if (left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top) {
              overlaps.push([leftNode.id || leftNode.textContent.trim(), rightNode.id || rightNode.textContent.trim()]);
            }
          });
        });
        const currentStatus = document.querySelector("#currentStatus")?.textContent || "";
        const rightmostTopControl = controls.reduce((maximum, node) => Math.max(maximum, node.getBoundingClientRect().right), 0);
        const modeSwitchRect = document.querySelector("#switchAgentTop")?.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          workspaceHorizontalOverflow: document.querySelector(".workspace").scrollWidth > document.querySelector(".workspace").clientWidth + 1,
          topControlOverlaps: overlaps,
          topControlMaxRight: Math.round(rightmostTopControl),
          windowControlSafeLeft: innerWidth - 144,
          topModeSwitchVisible: visible(document.querySelector("#switchAgentTop")),
          topModeSwitchRect: modeSwitchRect ? {
            left: Math.round(modeSwitchRect.left),
            right: Math.round(modeSwitchRect.right),
            width: Math.round(modeSwitchRect.width)
          } : null,
          visibleNavCount: [...document.querySelectorAll(".nav-button")].filter(visible).length,
          visibleCoreNavCount: [...document.querySelectorAll(".sidebar > nav > .nav-button")].filter(visible).length,
          visibleSecondaryNavCount: [...document.querySelectorAll(".sidebar-more-menu .nav-button")].filter(visible).length,
          moreOpen: Boolean(document.querySelector("#simpleMore")?.open),
          currentStatus,
          progressPercent: document.querySelector("#progressPercent")?.textContent || "",
          activeJobCount: [...document.querySelectorAll(".job-row")].filter(row => ["queued", "submitting", "submitted", "processing", "running", "downloading"].includes(String(row.querySelector("small")?.textContent || ""))).length
        };
      });
      layouts.push({ ...view, ...layout });
      const filePath = path.join(runDir, `simple-overview-${view.width}x${view.height}-zoom${Math.round(view.zoom * 100)}.png`);
      screenshots.push(await capture(page, filePath));
    }

    await setWindowView(electronApp, page, { width: 1440, height: 900, zoom: 1 });
    for (const panel of ["assets", "storyboard", "generate", "tasks", "library", "settings"]) {
      await openPanel(page, panel);
      await page.waitForTimeout(panel === "library" ? 400 : 100);
      screenshots.push(await capture(page, path.join(runDir, `simple-${panel}-1440x900.png`)));
    }
    await openPanel(page, "settings");
    await page.locator("#textProviderKind").selectOption("openai-compatible");
    await page.waitForTimeout(100);
    const providerContract = await page.evaluate(() => {
      const visible = selector => {
        const node = document.querySelector(selector);
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return {
        kind: document.querySelector("#textProviderKind")?.value || "",
        baseUrlVisible: visible("#textBaseUrlField"),
        apiKeyVisible: visible("#textApiKeyField"),
        modelVisible: visible("#textModelField"),
        maxTokensVisible: visible("#textMaxTokensField"),
        forbiddenControls: ["#generateTopics", "#generateScript", "#rewriteScript", "#topicList"].filter(selector => document.querySelector(selector))
      };
    });
    screenshots.push(await capture(page, path.join(runDir, "simple-settings-custom-provider-1440x900.png")));
    await openPanel(page, "assets");
    await page.waitForTimeout(150);
    const imageAudit = await page.evaluate(async () => {
      const images = [...document.images].filter(image => image.getClientRects().length > 0);
      await Promise.all(images.map(image => image.complete ? null : new Promise(resolve => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
        setTimeout(resolve, 2000);
      })));
      return images.map(image => ({ src: image.src, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }));
    });
    const stageContract = await page.evaluate(() => ({
      status: document.querySelector("#currentStatus")?.textContent || "",
      percent: document.querySelector("#progressPercent")?.textContent || "",
      completedSteps: document.querySelectorAll(".step-card.complete").length,
      assetLoadingRings: document.querySelectorAll(".asset-preview .loading-ring").length,
      h3Locked: document.querySelector(".locked-pill")?.textContent || "",
      simpleRoot: document.querySelector("#simpleRoot")?.textContent || "",
      sharedRoot: document.querySelector("#sharedRoot")?.textContent || ""
    }));
    const axe = {};
    for (const panel of ["overview", "script", "assets", "storyboard", "generate", "final", "tasks", "library", "settings"]) {
      axe[panel] = await runAxe(page, panel);
    }

    fs.writeFileSync(path.join(runDir, "simple-diagnostics.json"), JSON.stringify({
      runtime,
      layouts,
      imageAudit,
      stageContract,
      providerContract,
      axe,
      screenshots
    }, null, 2), "utf8");

    assert.equal(runtime.pageErrors.length, 0, `Simple renderer errors: ${runtime.pageErrors.join("\n")}`);
    assert.equal(runtime.consoleErrors.length, 0, `Simple console errors: ${runtime.consoleErrors.join("\n")}`);
    assert.ok(layouts.every(item => !item.horizontalOverflow), "Simple mode has page-level horizontal overflow");
    assert.ok(layouts.every(item => !item.workspaceHorizontalOverflow), "Simple workspace has horizontal overflow");
    assert.ok(layouts.every(item => item.topControlOverlaps.length === 0), "Simple top controls overlap");
    assert.ok(layouts.every(item => item.topControlMaxRight <= item.windowControlSafeLeft), "Simple top controls enter the Windows title-bar control area");
    assert.ok(layouts.every(item => item.topModeSwitchVisible), "Simple mode switch must stay visible at every audited zoom level");
    assert.ok(layouts.every(item => item.topModeSwitchRect?.width >= 80 && item.topModeSwitchRect.right <= item.windowControlSafeLeft), "Simple mode switch must remain fully visible and outside the Windows title-bar controls");
    assert.ok(layouts.every(item => item.visibleCoreNavCount === 6), "Simple mode must show exactly six core production steps");
    assert.ok(layouts.every(item => item.visibleSecondaryNavCount === 0 && item.moreOpen === false), "Secondary tools must stay collapsed on the main workflow");
    assert.ok(imageAudit.every(item => item.complete && item.naturalWidth > 0), "Visible Simple mode images must load");
    assert.equal(stageContract.completedSteps, 2, "Only script and AI analysis may be complete in the seeded asset-stage project");
    assert.ok(stageContract.assetLoadingRings >= 1, "Asset generation must expose a live loading indicator");
    assert.match(stageContract.h3Locked, /固定接入/);
    assert.match(stageContract.simpleRoot, /simple-mode/i);
    assert.doesNotMatch(stageContract.sharedRoot, /simple-mode/i);
    assert.equal(providerContract.kind, "openai-compatible");
    assert.equal(providerContract.baseUrlVisible, true);
    assert.equal(providerContract.apiKeyVisible, true);
    assert.equal(providerContract.modelVisible, true);
    assert.equal(providerContract.maxTokensVisible, true);
    assert.deepEqual(providerContract.forbiddenControls, []);
    assert.ok(Object.values(axe).every(items => items.length === 0), "Simple mode has critical or serious accessibility violations");
    return { runtime, layouts, imageAudit, stageContract, axe, screenshots };
  } finally {
    await electronApp.close();
  }
}

async function auditSelector(root, runDir, workbenchDir) {
  const userDataDir = path.join(runDir, "selector-user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  preparePackagedUserData(root, userDataDir);
  const env = { ...process.env, DRAMA_LICENSE_BYPASS: "1", DRAMA_SLOT_DATA_ROOT: workbenchDir, DRAMA_SLOT_WORKSPACE_MODE: "" };
  const electronApp = await electron.launch(electronLaunchOptions(root, userDataDir, env));
  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    const errors = [];
    page.on("pageerror", error => errors.push(String(error?.stack || error)));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.dataset.modeSelectorReady === "true", null, { timeout: 30_000 });
    await setWindowView(electronApp, page, { width: 1280, height: 800, zoom: 1 });
    const screenshot100 = await capture(page, path.join(runDir, "mode-selector-1280x800-zoom100.png"));
    await setWindowView(electronApp, page, { width: 1280, height: 800, zoom: 2 });
    const screenshot200 = await capture(page, path.join(runDir, "mode-selector-1280x800-zoom200.png"));
    const layout = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      cards: document.querySelectorAll("[data-mode]").length,
      visibleCards: [...document.querySelectorAll("[data-mode]")].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).length
    }));
    const axe = await runAxe(page, "");
    assert.equal(errors.length, 0, `Mode selector renderer errors: ${errors.join("\n")}`);
    assert.equal(layout.horizontalOverflow, false, "Mode selector overflows horizontally at 200% zoom");
    assert.equal(layout.cards, 2);
    assert.equal(layout.visibleCards, 2);
    assert.equal(axe.length, 0, "Mode selector has critical or serious accessibility violations");
    await setWindowView(electronApp, page, { width: 1280, height: 800, zoom: 1 });
    await page.locator('[data-mode="simple"]').click();
    await page.waitForFunction(() => document.body.dataset.simpleModeReady === "true", null, { timeout: 30_000 });
    const selectedSimple = await page.evaluate(() => window.dramaSlot.appMode.get());
    assert.equal(selectedSimple.ok, true);
    assert.equal(selectedSimple.mode, "simple");
    await page.evaluate(() => { void window.dramaSlot.appMode.select("agent"); });
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    const switchedAgent = await page.evaluate(() => window.dramaSlot.appMode.get());
    assert.equal(switchedAgent.ok, true);
    assert.equal(switchedAgent.mode, "agent");
    return { errors, layout, axe, selectedSimple, switchedAgent, screenshots: [screenshot100, screenshot200] };
  } finally {
    await electronApp.close();
  }
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const evidenceRoot = process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
    ? path.resolve(process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR)
    : path.join(root, ".codex_tests", process.env.DRAMA_SLOT_AUDIT_TASK_ID || "TASK-20260815-DRAMA-SHORTEST-MATRIX-004", "simple-ui");
  const runDir = path.join(evidenceRoot, timestamp());
  const workbenchDir = path.join(runDir, "workbench");
  fs.mkdirSync(runDir, { recursive: true });
  const fixture = seedSimpleWorkspace(root, workbenchDir);
  const simple = await auditSimple(root, runDir, workbenchDir);
  const selector = await auditSelector(root, runDir, path.join(runDir, "selector-workbench"));
  const report = {
    ok: true,
    createdAt: new Date().toISOString(),
    root,
    runDir,
    fixture,
    simple,
    selector
  };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, runDir, screenshots: [...simple.screenshots, ...selector.screenshots] }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
