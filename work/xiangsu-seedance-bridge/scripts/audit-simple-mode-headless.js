"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const axeSource = require("axe-core").source;
const appVersion = require("../package.json").version;

const root = path.resolve(__dirname, "..");
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const evidenceDir = path.resolve(process.env.SIMPLE_HEADLESS_EVIDENCE_DIR
  || path.join(root, ".codex_tests", "TASK-20260823-GEMINI-FULL-MATRIX-001", "simple-ui-headless-round2"));

function fixtureProject() {
  const now = new Date().toISOString();
  return {
    id: "simple_headless_project",
    title: "超长标题回归：雨夜书房里一盏暖心阅读灯与两个人物的完整资产制作项目",
    updatedAt: now,
    status: "draft",
    currentStage: "assets",
    productionRevision: "simple-headless-r2",
    productionPlan: { simpleAssetOnly: true, inputMode: "manual", executionMode: "step" },
    generation: { mode: "storyboard_sheet", aspectRatio: "9:16", engine: "hailuo-h3", modeConfirmed: true },
    automation: { status: "idle", message: "", concurrency: {} },
    runtime: {},
    characters: [
      { id: "C01", name: "林婉", description: "二十八岁女性，利落短发，米色针织衫，左手佩戴银色腕表，外观描述刻意很长用于检查窄窗口与百分之二百缩放时不会产生横向溢出。", identitySignature: "短发、银色腕表、清晰眉骨", promptOverrides: {} },
      { id: "C02", name: "周明", description: "四十岁男性，深色衬衫，细框眼镜，神情克制。", identitySignature: "细框眼镜、窄脸", promptOverrides: {} }
    ],
    scenes: [{ id: "SC01", name: "雨夜书房", description: "木桌、书架、暖色阅读区和固定空间轴线，窗外雨水形成冷暖对比。", atmosphere: "安静雨夜", promptOverrides: {} }],
    assetLibraries: {
      props: [{ id: "P01", name: "旧账本", description: "翻开后推动剧情的核心道具", storyFunction: "揭示真相", promptOverrides: {} }],
      wardrobes: []
    },
    product: { name: "暖心阅读灯", description: "磨砂白灯罩与暖色无频闪阅读光", sellingPoints: "柔和照明", imagePath: "" },
    shots: [],
    candidates: [],
    jobs: [{ id: "J01", type: "character_voice", status: "processing", message: "人物音色处理中", updatedAt: now, createdAt: now }],
    costLedger: { entries: [{ id: "E01", category: "image", operation: "storyboard_sheet", status: "settled", amountYuan: 0.01 }], summary: { totalKnownYuan: 0.01 } },
    promptReview: null
  };
}

function libraryFixtures() {
  return [
    { id: "A01", kind: "character", mediaType: "image", label: "林婉形象", description: "少年女性短发形象", gender: "female", ageBand: "youth", tags: ["短发", "暖色"], filePath: "", useCount: 2 },
    { id: "A02", kind: "character", mediaType: "image", label: "周明形象", description: "中年男性细框眼镜", gender: "male", ageBand: "middle", tags: ["眼镜", "沉稳"], filePath: "", useCount: 1 },
    { id: "V01", kind: "voice", mediaType: "audio", label: "林婉温柔音色", voiceDescription: "青年女性温柔清晰", gender: "female", ageBand: "youth", tags: ["温柔", "清晰"], filePath: "", useCount: 0 },
    { id: "P01", kind: "product", mediaType: "image", label: "暖心阅读灯", description: "磨砂白灯罩", tags: ["家居", "阅读"], filePath: "", useCount: 3 }
  ];
}

async function installBridge(page, options = {}) {
  const projectFixture = fixtureProject();
  const providerFailure = String(options.providerFailure || (options.networkFailure === true ? "network" : ""));
  if (["network", "quota"].includes(providerFailure)) {
    const rawFailureMessage = providerFailure === "quota"
      ? '{"error":{"code":429,"message":"Quota exceeded for model: gemini-3.7-flash; request id: req-secret; https://provider.invalid/private; api_key=AIzaHiddenCredential12345678901234567890","status":"RESOURCE_EXHAUSTED"}}'
      : "TypeError: fetch failed (ECONNRESET) https://provider.invalid/private";
    projectFixture.status = "paused_remote";
    projectFixture.currentStage = "generate";
    projectFixture.automation = {
      status: "paused_remote",
      stage: "videos",
      recoverableFailure: true,
      message: rawFailureMessage
    };
    projectFixture.jobs = [{
      id: providerFailure === "quota" ? "J-QUOTA-RAW" : "J-NETWORK-RAW",
      type: "shot_video",
      status: "paused_remote",
      message: rawFailureMessage,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }];
  }
  await page.addInitScript(({ projectFixture, assets, failStorage, failLicense, currentAppVersion }) => {
    let project = structuredClone(projectFixture);
    const clone = value => structuredClone(value);
    const simpleCall = async (method, ...args) => {
      if (method === "getSettings") return { ok: true, settings: { generation: { aspectRatio: "9:16" } } };
      if (method === "storageLocation") {
        if (failStorage) throw new Error("模拟存储位置读取失败");
        return { ok: true, projectRoot: "D:/audit/simple-mode", sharedLibraryRoot: "D:/audit/shared-library" };
      }
      if (method === "listProjects") return { ok: true, projects: [{ id: project.id, title: project.title }] };
      if (method === "getProject") return { ok: true, project: clone(project) };
      if (method === "patchProject") {
        project = { ...project, ...clone(args[1] || {}), updatedAt: new Date().toISOString() };
        return { ok: true, project: clone(project) };
      }
      if (method === "listReusableAssets") {
        const kind = String(args[0] || "");
        return { ok: true, assets: clone(assets.filter(item => !kind || item.kind === kind || (kind === "video" && item.mediaType === "video"))) };
      }
      if (method === "licenseStatus") {
        if (failLicense) throw new Error("模拟授权读取失败");
        return { ok: true, snapshot: { activated: true, imageConcurrency: 7, videoConcurrency: 3 } };
      }
      if (method === "walletStatus") return { ok: true, wallet: { availableCents: 1234 } };
      if (method === "previewShotVideoDependencies") return { ok: true, preview: { paidImageCount: 1, paidCharacterVideoCount: 0, localVoiceExtractionCount: 1, assets: [{ label: "林婉音色" }], storyboards: [{ label: "镜头 1 分镜图" }], shotIds: ["S01"] } };
      if (["saveSettings", "resetSettings"].includes(method)) return { ok: true, settings: { generation: { aspectRatio: "9:16" } } };
      if (method === "preparePromptReview") return { ok: true, project: clone(project) };
      if (method === "testProvider") return { ok: true };
      if (["importReusableAsset", "importCandidate", "chooseProduct"].includes(method)) return { ok: true, canceled: true };
      if (method === "bindLibraryAsset") return { ok: true, project: clone(project) };
      throw new Error(`未模拟简易接口：${method}`);
    };
    window.__simpleAudit = {
      project: () => clone(project),
      assets: () => clone(assets)
    };
    window.dramaSlot = {
      simple: {
        call: simpleCall,
        updateProduct: async (_projectId, patch) => {
          project.product = { ...(project.product || {}), ...clone(patch), imagePath: "D:/audit/new-product.png" };
          return { ok: true, project: clone(project) };
        }
      },
      defaults: async () => ({ appVersion: currentAppVersion }),
      checkUpdate: async () => ({ status: "current", message: "已是最新版" }),
      installUpdate: async () => ({ ok: true }),
      onUpdateStatus: () => {},
      appMode: { select: async () => ({ ok: true, mode: "agent" }) }
    };
    try { localStorage.setItem("puream.simple-mode.guide.v1", "seen"); } catch {}
  }, {
    projectFixture,
    assets: libraryFixtures(),
    failStorage: options.failStorage === true,
    failLicense: options.failLicense === true,
    currentAppVersion: appVersion
  });
}

async function runProviderFailure(browser, providerFailure) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
  await installBridge(page, { providerFailure });
  await page.goto(pathToFileURL(path.join(root, "app", "renderer", "simple-mode.html")).href);
  await page.waitForFunction(() => document.body.dataset.simpleModeReady === "true", null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.locator('[data-panel="generate"]').click();
  const state = await page.evaluate(() => ({
    text: document.body.innerText,
    leakNodes: [...document.querySelectorAll("body *")]
      .filter(node => /fetch failed|TypeError|UND_ERR|ECONNRESET|provider\.invalid|quota exceeded|resource_exhausted|gemini-3\.7-flash|req-secret|AIzaHidden/i.test(node.innerText || ""))
      .filter(node => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .slice(-12)
      .map(node => ({ tag: node.tagName, id: node.id, className: node.className, text: (node.innerText || "").slice(0, 500) })),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }));
  const name = `${providerFailure}-recovery-1024x720`;
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), animations: "disabled" });
  assert.deepEqual(pageErrors, [], `${name} renderer errors`);
  assert.doesNotMatch(state.text, /fetch failed|TypeError|UND_ERR|ECONNRESET|provider\.invalid|quota exceeded|resource_exhausted|gemini-3\.7-flash|req-secret|AIzaHidden/i, `${name} leaked raw provider diagnostics: ${JSON.stringify(state.leakNodes)}`);
  if (providerFailure === "quota") {
    assert.match(state.text, /模型项目配额当前不可用|配额恢复/, `${name} lacks the quota checkpoint message`);
  } else {
    assert.match(state.text, /网络短暂中断|原任务断点自动恢复/, `${name} lacks the recovery message`);
  }
  assert.equal(state.horizontalOverflow, false, `${name} horizontal overflow`);
  await context.close();
  return { providerFailure, state: { ...state, text: undefined }, pageErrors };
}

async function seriousAxeViolations(page) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
  }));
  return result.violations.filter(item => ["critical", "serious"].includes(item.impact)).map(item => ({
    id: item.id,
    impact: item.impact,
    help: item.help,
    targets: item.nodes.map(node => node.target)
  }));
}

async function visibleLayout(page) {
  return page.evaluate(() => {
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const targets = [...document.querySelectorAll("button, select, input:not([type=checkbox]):not([type=radio])")].filter(visible);
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      documentHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      workspaceHorizontalOverflow: document.querySelector(".workspace").scrollWidth > document.querySelector(".workspace").clientWidth + 1,
      smallTargets: targets.map(node => {
        const rect = node.getBoundingClientRect();
        return { label: node.id || node.textContent.trim() || node.getAttribute("aria-label"), width: Math.round(rect.width), height: Math.round(rect.height) };
      }).filter(item => item.width < 44 || item.height < 44),
      coreStages: [...document.querySelectorAll(".sidebar > nav > [data-panel]")].map(node => node.dataset.panel),
      guideEntryVisible: visible(document.querySelector("#simpleGuideButton")),
      ready: document.body.dataset.simpleModeReady || ""
    };
  });
}

async function runView(browser, view, name) {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: view.deviceScaleFactor });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
  await installBridge(page);
  await page.goto(pathToFileURL(path.join(root, "app", "renderer", "simple-mode.html")).href);
  await page.waitForFunction(() => document.body.dataset.simpleModeReady === "true", null, { timeout: 15_000 });
  await page.waitForTimeout(300);

  const initialLayout = await visibleLayout(page);
  await page.screenshot({ path: path.join(evidenceDir, `${name}-assets.png`), fullPage: false, animations: "disabled" });

  await page.locator("#simpleMore > summary").click();
  await page.locator('[data-panel="library"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#libraryGrid .library-card").length === 4);
  await page.locator("#libraryGender").selectOption("female");
  await page.locator("#libraryAge").selectOption("youth");
  await page.locator("#libraryTag").fill("短发");
  const filteredLabels = await page.locator("#libraryGrid .library-card h3").allTextContents();
  await page.locator("#libraryGender").selectOption("");
  await page.locator("#libraryAge").selectOption("");
  await page.locator("#libraryTag").fill("");
  await page.locator("#libraryKind").selectOption("");
  await page.locator("#importLibrary").click();
  const importDialog = await page.evaluate(() => ({
    open: document.querySelector("#libraryImportDialog").open,
    selected: document.querySelector("#libraryImportKind").value
  }));
  await page.locator('[data-close-dialog="libraryImportDialog"]').first().click();
  await page.screenshot({ path: path.join(evidenceDir, `${name}-library.png`), fullPage: false, animations: "disabled" });

  await page.locator('.sidebar > nav > [data-panel="storyboard"]').click();
  await page.locator("#newShot").click();
  await page.locator('input[name="shotCharacter"][value="C01"]').check();
  await page.locator('input[name="shotProp"][value="P01"]').check();
  await page.locator("#shotUsesProduct").check();
  await page.locator("#shotTitle").fill("灯光照亮账本");
  await page.locator("#shotDuration").fill("12");
  await page.locator("#shotAction").fill("林婉按下阅读灯开关。暖光缓慢铺满桌面并照亮很长的一段旧账本内容。她翻开账本停在关键页。镜头切到她确认真相后的表情。");
  await page.locator("#shotDialogue").fill("林婉（惊讶后压低声音）：原来这些年我一直误会他了。\n周明（愧疚、缓慢）：现在知道真相还不算晚。");
  const footerAudit = await page.evaluate(() => {
    const dialog = document.querySelector("#shotDialog");
    const footer = dialog.querySelector("footer");
    dialog.scrollTop = dialog.scrollHeight;
    const rect = footer.getBoundingClientRect();
    return { position: getComputedStyle(footer).position, top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
  });
  await page.screenshot({ path: path.join(evidenceDir, `${name}-shot-dialog.png`), fullPage: false, animations: "disabled" });
  await page.locator('#shotDialog button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("#shotDialog").open && window.__simpleAudit.project().shots.length === 1);
  const createdShot = await page.evaluate(() => window.__simpleAudit.project().shots[0]);

  await page.locator('#simpleMore > summary').click();
  await page.locator("#simpleGuideButton").click();
  const guideAudit = await page.evaluate(() => {
    const dialog = document.querySelector("#simpleGuideDialog");
    const footer = dialog.querySelector("footer");
    dialog.scrollTop = dialog.scrollHeight;
    const rect = footer.getBoundingClientRect();
    return {
      open: dialog.open,
      position: getComputedStyle(footer).position,
      footerVisible: rect.top < innerHeight && rect.bottom > 0,
      text: dialog.innerText
    };
  });
  await page.screenshot({ path: path.join(evidenceDir, `${name}-guide.png`), fullPage: false, animations: "disabled" });
  const axe = await seriousAxeViolations(page);

  assert.deepEqual(pageErrors, [], `${name} renderer errors`);
  assert.deepEqual(initialLayout.coreStages, ["assets", "storyboard", "generate"]);
  assert.equal(initialLayout.documentHorizontalOverflow, false, `${name} document overflow`);
  assert.equal(initialLayout.workspaceHorizontalOverflow, false, `${name} workspace overflow`);
  assert.deepEqual(initialLayout.smallTargets, [], `${name} controls below 44px: ${JSON.stringify(initialLayout.smallTargets)}`);
  assert.deepEqual(filteredLabels, ["林婉形象"]);
  assert.deepEqual(importDialog, { open: true, selected: "" });
  assert.deepEqual(createdShot.visibleCharacterIds.sort(), ["C01", "C02"], "dialogue speakers must be auto-added, but unrelated people must not be bound");
  assert.deepEqual(createdShot.propNames, ["旧账本"]);
  assert.equal(createdShot.productMention, true);
  assert.equal(createdShot.subshots.length, 2, "two speaker runs should produce two adaptive camera/mouth ownership blocks");
  assert.deepEqual(createdShot.subshots.map(item => item.cameraOwnerId), ["C01", "C02"]);
  assert.deepEqual(createdShot.subshots.map(item => item.mouthOwnerId), ["C01", "C02"]);
  const durations = createdShot.subshots.map(item => Number((item.end - item.start).toFixed(2)));
  assert.ok(new Set(durations).size > 1, `adaptive durations unexpectedly equal: ${durations.join(",")}`);
  assert.equal(footerAudit.position, "sticky");
  assert.ok(footerAudit.bottom <= footerAudit.viewportHeight + 1 && footerAudit.top >= -1, `${name} shot footer is not reachable`);
  assert.equal(guideAudit.open, true);
  assert.equal(guideAudit.position, "sticky");
  assert.equal(guideAudit.footerVisible, true);
  assert.match(guideAudit.text, /不选题、不写剧本/);
  assert.deepEqual(axe, [], `${name} serious accessibility violations: ${JSON.stringify(axe)}`);

  const result = { name, initialLayout, filteredLabels, importDialog, createdShot, footerAudit, guideAudit: { ...guideAudit, text: undefined }, axe, pageErrors };
  await context.close();
  return result;
}

async function runPartialFailure(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await installBridge(page, { failStorage: true, failLicense: true });
  await page.goto(pathToFileURL(path.join(root, "app", "renderer", "simple-mode.html")).href);
  await page.waitForFunction(() => document.body.dataset.simpleModeReady === "partial", null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    ready: document.body.dataset.simpleModeReady,
    noticeVisible: !document.querySelector("#simpleStartupNotice").hidden,
    noticeText: document.querySelector("#simpleStartupNotice").innerText,
    projectTitle: document.querySelector("#projectSelect").selectedOptions[0]?.textContent || "",
    imageConcurrency: document.querySelector("#imageConcurrency").value,
    videoConcurrency: document.querySelector("#videoConcurrency").value,
    newAssetEnabled: !document.querySelector("#newAsset").disabled,
    retryEnabled: !document.querySelector('[data-action="retry-initialize"]').disabled
  }));
  await page.screenshot({ path: path.join(evidenceDir, "partial-startup-failure.png"), animations: "disabled" });
  assert.equal(state.ready, "partial");
  assert.equal(state.noticeVisible, true);
  assert.match(state.noticeText, /存储位置/);
  assert.match(state.projectTitle, /超长标题回归/);
  assert.equal(state.imageConcurrency, "未知");
  assert.equal(state.videoConcurrency, "未知");
  assert.equal(state.newAssetEnabled, true);
  assert.equal(state.retryEnabled, true);
  await context.close();
  return state;
}

async function main() {
  assert.ok(fs.existsSync(edgePath), `Microsoft Edge not found: ${edgePath}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: edgePath, headless: true, args: ["--disable-gpu"] });
  try {
    const views = [];
    views.push(await runView(browser, { width: 1440, height: 900, deviceScaleFactor: 1 }, "edge-1440x900-100"));
    views.push(await runView(browser, { width: 590, height: 380, deviceScaleFactor: 2 }, "edge-1180x760-200"));
    const partialFailure = await runPartialFailure(browser);
    const networkFailure = await runProviderFailure(browser, "network");
    const quotaFailure = await runProviderFailure(browser, "quota");
    const report = { ok: true, createdAt: new Date().toISOString(), edgePath, evidenceDir, views, partialFailure, networkFailure, quotaFailure };
    fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, evidenceDir, views: views.map(item => ({ name: item.name, viewport: item.initialLayout.viewport, axeViolations: item.axe.length })), partialFailure }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
