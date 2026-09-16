"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const axeSource = require("axe-core").source;
const { defaultProject, defaultSettings } = require("../app/workbench-store");
const appVersion = require("../package.json").version;

const root = path.resolve(__dirname, "..");
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const evidenceDir = path.resolve(process.env.TOPIC_UI_EVIDENCE_DIR
  || path.join(root, ".codex_tests", "TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003", "topic-ui-headless"));

const views = [
  { name: "1024x720-100", width: 1024, height: 720, deviceScaleFactor: 1 },
  { name: "1280x800-100", width: 1280, height: 800, deviceScaleFactor: 1 },
  { name: "1440x900-100", width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: "1920x1080-100", width: 1920, height: 1080, deviceScaleFactor: 1 },
  // A 640x400 CSS viewport at DPR 2 is the usable layout and physical pixel
  // surface of a 1280x800 display at 200% scale.
  { name: "1280x800-200", width: 640, height: 400, deviceScaleFactor: 2 }
];

function topicFixture(index) {
  const number = index + 1;
  return {
    id: `TOPIC_${String(number).padStart(2, "0")}`,
    title: `候选选题 ${number}：雨夜归还旧账本`,
    genre: "家庭现实",
    relationship: "母子",
    logline: `第 ${number} 个完整故事方向：母亲用一张旧收据纠正儿子的多年误会。`,
    hook: "儿子把母亲的旧箱子推出门外，箱底却掉出一张替他还债的收据。",
    reversal: "被误解的人一直在暗中替全家承担债务。",
    emotionalPayoff: "儿子公开道歉并把家门钥匙交还母亲。",
    highlights: ["开场冲突一眼看懂", "反转有完整证据", "结尾以行动兑现"]
  };
}

function projectFixture(topicCount, options = {}) {
  const project = defaultProject("选题局部返回界面审计", {
    inputMode: "ai",
    executionMode: "step",
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    mode: "storyboard_sheet",
    modeConfirmed: true,
    engine: "hailuo-h3"
  });
  project.id = `topic_ui_${topicCount}`;
  project.product = { name: "", description: "", sellingPoints: "", imagePath: "", publicUrl: "" };
  project.ideation = topicCount === 0 ? {
    status: "waiting_topics",
    topics: [],
    selectedTopicId: "",
    targetTopicCount: 10,
    acceptedTopicCount: 0,
    partialResult: false,
    message: "上游本轮没有返回可显示的选题，本次请求已安全结束；系统不会自动重复提交，稍后可再次点击一键生成选题",
    errorCode: ""
  } : {
    status: "ready",
    topics: Array.from({ length: topicCount }, (_, index) => topicFixture(index)),
    selectedTopicId: "",
    targetTopicCount: 10,
    acceptedTopicCount: topicCount,
    partialResult: topicCount < 10,
    message: topicCount < 10
      ? `模型本轮返回 ${topicCount} 个有效选题，已全部保留并可直接选择；系统没有为凑满 10 个重复请求`
      : "已生成 10 个候选题材，请选择一个后绑定商品",
    errorCode: ""
  };
  const providerFailure = String(options.providerFailure || (options.networkFailure === true ? "network" : ""));
  if (["network", "quota"].includes(providerFailure)) {
    const rawFailureMessage = providerFailure === "quota"
      ? '{"error":{"code":429,"message":"Quota exceeded for model: gemini-3.7-flash; request id: req-secret; https://provider.invalid/private; api_key=AIzaHiddenCredential12345678901234567890","status":"RESOURCE_EXHAUSTED"}}'
      : "TypeError: fetch failed (UND_ERR_SOCKET) https://provider.invalid/private";
    project.status = "paused_remote";
    project.currentStage = "videos";
    project.automation = {
      ...(project.automation || {}),
      status: "paused_remote",
      stage: "videos",
      recoverableFailure: true,
      message: rawFailureMessage
    };
    project.jobs = [{
      id: providerFailure === "quota" ? "J-QUOTA-RAW" : "J-NETWORK-RAW",
      type: "shot_video",
      status: "paused_remote",
      message: rawFailureMessage,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }];
  }
  return project;
}

async function installBridge(page, topicCount, options = {}) {
  await page.addInitScript(({ fixture, settings, version }) => {
    let project = structuredClone(fixture);
    const clone = value => structuredClone(value);
    const ok = value => ({ ok: true, ...value });
    window.dramaSlot = {
      defaults: async () => ({ appVersion: version, captureMode: true, isPackaged: true }),
      checkUpdate: async () => ({ status: "latest", currentVersion: version }),
      installUpdate: async () => ({ ok: true }),
      onUpdateStatus: () => () => {},
      health: async () => ({ ok: true, ready: true, sessionReady: true, remote: true, message: "审计夹具" }),
      startBridge: async () => ({ ok: true }),
      hideXiangsu: async () => ({ ok: true }),
      appMode: { select: async () => ({ ok: true, mode: "agent" }) },
      workbench: {
        getSettings: async () => ok({ settings: clone(settings) }),
        authStatus: async () => ok({ configured: true, masked: "audit" }),
        listProjects: async () => ok({ projects: [{ id: project.id, title: project.title, status: project.status, updatedAt: project.updatedAt }] }),
        getProject: async () => ok({ project: clone(project) }),
        patchProject: async (_projectId, patch) => {
          project = { ...project, ...clone(patch || {}), updatedAt: new Date().toISOString() };
          return ok({ project: clone(project) });
        },
        getStorageLocation: async () => ok({ rootDir: "D:/audit/topic-ui" }),
        listVoiceLibrary: async () => ok({ voices: [] }),
        listReusableAssets: async () => ok({ assets: [] }),
        accountSwitchStatus: async () => ok({ state: { status: "idle", pendingJobs: [], message: "审计夹具" } }),
        listProjectsOverview: async () => ok({ projects: [] }),
        walletStatus: async () => ok({ wallet: { availableCents: 10000, frozenCents: 0 } }),
        syncVideoJobs: async () => ok({ jobs: [] })
      }
    };
  }, { fixture: projectFixture(topicCount, options), settings: defaultSettings(), version: appVersion });
}

async function runProviderFailureCase(browser, view, providerFailure) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.deviceScaleFactor
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
  await installBridge(page, 3, { providerFailure });
  await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=script`);
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 15_000 });
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => ({
    text: document.body.innerText,
    leakNodes: [...document.querySelectorAll("body *")]
      .filter(node => /fetch failed|TypeError|UND_ERR|provider\.invalid|quota exceeded|resource_exhausted|gemini-3\.7-flash|req-secret|AIzaHidden/i.test(node.innerText || ""))
      .filter(node => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .slice(-12)
      .map(node => ({ tag: node.tagName, id: node.id, className: node.className, text: (node.innerText || "").slice(0, 500) })),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }));
  const name = `${providerFailure}-recovery-${view.name}`;
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), animations: "disabled" });
  assert.deepEqual(pageErrors, [], `${name} renderer errors`);
  assert.doesNotMatch(state.text, /fetch failed|TypeError|UND_ERR|provider\.invalid|quota exceeded|resource_exhausted|gemini-3\.7-flash|req-secret|AIzaHidden/i, `${name} leaked raw provider diagnostics: ${JSON.stringify(state.leakNodes)}`);
  if (providerFailure === "quota") {
    assert.match(state.text, /模型项目配额当前不可用|配额恢复/, `${name} lacks the quota checkpoint message`);
  } else {
    assert.match(state.text, /网络短暂中断|原任务断点自动恢复/, `${name} lacks the recovery message`);
  }
  assert.equal(state.horizontalOverflow, false, `${name} horizontal overflow`);
  await context.close();
  return { providerFailure, view, state: { ...state, text: undefined }, pageErrors };
}

async function runCase(browser, topicCount, view) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.deviceScaleFactor
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
  await installBridge(page, topicCount);
  await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=script`);
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 15_000 });
  await page.waitForTimeout(150);

  const machine = page.locator(".idea-machine");
  await machine.scrollIntoViewIfNeeded();
  const snapshot = await page.evaluate(expectedCount => {
    const overflow = selector => {
      const node = document.querySelector(selector);
      return Boolean(node && node.scrollWidth > node.clientWidth + 1);
    };
    const cards = [...document.querySelectorAll("#topicGrid .topic-card")];
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < cards.length; leftIndex += 1) {
      const left = cards[leftIndex].getBoundingClientRect();
      for (let rightIndex = leftIndex + 1; rightIndex < cards.length; rightIndex += 1) {
        const right = cards[rightIndex].getBoundingClientRect();
        const intersectionWidth = Math.min(left.right, right.right) - Math.max(left.left, right.left);
        const intersectionHeight = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
        if (intersectionWidth > 1 && intersectionHeight > 1) overlaps.push([leftIndex, rightIndex]);
      }
    }
    const status = document.querySelector("#ideationStatus");
    const toast = document.querySelector("#toast");
    return {
      expectedCount,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      cardCount: cards.length,
      emptyCount: document.querySelectorAll("#topicGrid .topic-empty").length,
      statusText: status?.textContent || "",
      statusRole: status?.getAttribute("role") || "",
      statusLive: status?.getAttribute("aria-live") || "",
      cardsAreButtons: cards.every(card => card.tagName === "BUTTON" && card.hasAttribute("aria-pressed")),
      horizontalOverflow: {
        document: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        mainStage: overflow(".main-stage"),
        machine: overflow(".idea-machine"),
        grid: overflow("#topicGrid")
      },
      overlaps,
      errorToastVisible: Boolean(toast?.classList.contains("show") && toast?.classList.contains("error"))
    };
  }, topicCount);

  const name = `topics-${topicCount}-${view.name}`;
  await page.screenshot({ path: path.join(evidenceDir, `${name}-top.png`), animations: "disabled" });
  let lastCardReachable = true;
  if (topicCount > 0) {
    const lastCard = page.locator("#topicGrid .topic-card").last();
    await lastCard.scrollIntoViewIfNeeded();
    lastCardReachable = await lastCard.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
    });
    if (topicCount >= 9) await page.screenshot({ path: path.join(evidenceDir, `${name}-last.png`), animations: "disabled" });
  }

  await page.evaluate(axeSource);
  const axe = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector(".idea-machine"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
    });
    return result.violations
      .filter(item => ["critical", "serious"].includes(item.impact))
      .map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) }));
  });

  assert.deepEqual(pageErrors, [], `${name} renderer errors`);
  assert.equal(snapshot.cardCount, topicCount, `${name} card count`);
  assert.equal(snapshot.emptyCount, topicCount === 0 ? 1 : 0, `${name} empty state`);
  assert.equal(snapshot.statusRole, "status", `${name} status role`);
  assert.equal(snapshot.statusLive, "polite", `${name} status live region`);
  assert.equal(snapshot.cardsAreButtons, true, `${name} cards must be selectable buttons`);
  assert.deepEqual(Object.values(snapshot.horizontalOverflow), [false, false, false, false], `${name} horizontal overflow`);
  assert.deepEqual(snapshot.overlaps, [], `${name} overlapping topic cards`);
  assert.equal(snapshot.errorToastVisible, false, `${name} must not show a red error toast`);
  assert.equal(lastCardReachable, true, `${name} last card must be reachable`);
  assert.deepEqual(axe, [], `${name} serious accessibility violations`);
  if (topicCount === 0) assert.match(snapshot.statusText, /不会自动重复提交/);
  else if (topicCount < 10) {
    assert.match(snapshot.statusText, new RegExp(`返回 ${topicCount} 个有效选题`));
    assert.match(snapshot.statusText, /没有为凑满 10 个重复请求/);
  } else assert.match(snapshot.statusText, /已生成 10 个候选题材/);

  const result = { topicCount, view, snapshot, lastCardReachable, axe, pageErrors };
  await context.close();
  return result;
}

async function main() {
  assert.ok(fs.existsSync(edgePath), `Microsoft Edge not found: ${edgePath}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: edgePath, headless: true, args: ["--disable-gpu"] });
  try {
    const cases = [];
    for (const topicCount of [0, 1, 3, 9, 10]) {
      for (const view of views) cases.push(await runCase(browser, topicCount, view));
    }
    const networkRecovery = [];
    const quotaRecovery = [];
    for (const view of views) {
      networkRecovery.push(await runProviderFailureCase(browser, view, "network"));
      quotaRecovery.push(await runProviderFailureCase(browser, view, "quota"));
    }
    const report = { ok: true, createdAt: new Date().toISOString(), evidenceDir, cases, networkRecovery, quotaRecovery };
    fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, evidenceDir, cases: cases.map(item => ({ topicCount: item.topicCount, view: item.view.name, cards: item.snapshot.cardCount, axe: item.axe.length })), networkRecovery: networkRecovery.map(item => item.view.name), quotaRecovery: quotaRecovery.map(item => item.view.name) }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
