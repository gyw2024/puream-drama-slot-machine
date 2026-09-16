"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const axeSource = require("axe-core").source;
const { publicError } = require("../app/public-error");

const root = path.resolve(__dirname, "..");
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const evidenceDir = path.resolve(process.env.LICENSE_ERROR_UI_EVIDENCE_DIR
  || path.join(root, ".codex_tests", "TASK-20260825-DRAMA-ADMIN-AUTH-RECOVERY-004", "license-error-ui"));
const errorResult = publicError(Object.assign(
  new Error("纯梦官网授权服务暂时不可达"),
  { code: "LICENSE_OFFLINE", status: 503, kind: "authorization", retryable: true }
));
const views = [
  { name: "1024x720-100", width: 1024, height: 720, dpr: 1 },
  { name: "1280x800-100", width: 1280, height: 800, dpr: 1 },
  { name: "1440x900-100", width: 1440, height: 900, dpr: 1 },
  { name: "1920x1080-100", width: 1920, height: 1080, dpr: 1 },
  { name: "1280x800-200", width: 640, height: 400, dpr: 2 }
];

async function installBridge(page) {
  await page.addInitScript(({ result, version }) => {
    const clone = value => structuredClone(value);
    window.dramaSlot = {
      defaults: async () => ({ appVersion: version, captureMode: false, isPackaged: true }),
      checkUpdate: async () => ({ status: "latest" }),
      installUpdate: async () => ({ ok: true }),
      onUpdateStatus: () => () => {},
      appMode: { select: async () => ({ ok: true }) },
      workbench: {
        licenseStatus: async () => ({ ok: false, activated: false, snapshot: { machineId: "99e29ae534e19da6ab17712caf36a386" } }),
        licenseActivate: async () => clone(result)
      }
    };
  }, { result: errorResult, version: require("../package.json").version });
}

async function seriousAxeViolations(page) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
  }));
  return result.violations
    .filter(item => ["critical", "serious"].includes(item.impact))
    .map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) }));
}

async function runCase(browser, view) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await installBridge(page);
  await page.goto(pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href);
  await page.locator("#licenseGate").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => document.activeElement?.id === "licenseCode", null, { timeout: 3_000 });
  await page.locator("#licenseCode").fill("AB12CD34EF56AB78");
  await page.locator("#licenseSubmit").click();
  await page.waitForFunction(expected => document.querySelector("#licenseError")?.textContent === expected, errorResult.message);
  const inspection = await page.evaluate(expected => {
    const gate = document.querySelector("#licenseGate");
    const card = document.querySelector("#licenseForm");
    const input = document.querySelector("#licenseCode");
    const error = document.querySelector("#licenseError");
    const submit = document.querySelector("#licenseSubmit");
    const gateRect = gate.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const submitRect = submit.getBoundingClientRect();
    return {
      exactMessage: error.textContent === expected,
      containsWrongModelMessage: /模型授权无效/.test(error.textContent),
      errorVisible: !error.hidden && getComputedStyle(error).visibility !== "hidden",
      errorRole: error.getAttribute("role"),
      describedBy: input.getAttribute("aria-describedby"),
      ariaInvalid: input.getAttribute("aria-invalid"),
      submitEnabled: !submit.disabled,
      submitText: submit.textContent.trim(),
      documentHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      gateHorizontalOverflow: gate.scrollWidth > gate.clientWidth + 1,
      cardHorizontalOverflow: card.scrollWidth > card.clientWidth + 1,
      cardInsideHorizontalViewport: cardRect.left >= -1 && cardRect.right <= innerWidth + 1,
      cardReachableVertically: cardRect.bottom <= Math.max(innerHeight, gateRect.bottom) + 1 || gate.scrollHeight > gate.clientHeight,
      inputHeight: inputRect.height,
      submitHeight: submitRect.height,
      fullErrorTextReachable: error.scrollHeight <= error.clientHeight + 2
    };
  }, errorResult.message);
  const runtimeConsoleErrors = [...consoleErrors];
  const axe = await seriousAxeViolations(page);
  const auditConsoleNoise = consoleErrors.slice(runtimeConsoleErrors.length);
  const screenshot = path.join(evidenceDir, `license-error-${view.name}.png`);
  await page.screenshot({ path: screenshot, animations: "disabled" });

  assert.equal(inspection.exactMessage, true);
  assert.equal(inspection.containsWrongModelMessage, false);
  assert.equal(inspection.errorVisible, true);
  assert.equal(inspection.errorRole, "alert");
  assert.match(inspection.describedBy || "", /licenseError/);
  assert.equal(inspection.ariaInvalid, "true");
  assert.equal(inspection.submitEnabled, true);
  assert.equal(inspection.submitText, "在线激活");
  assert.equal(inspection.documentHorizontalOverflow, false);
  assert.equal(inspection.gateHorizontalOverflow, false);
  assert.equal(inspection.cardHorizontalOverflow, false);
  assert.equal(inspection.cardInsideHorizontalViewport, true);
  assert.equal(inspection.cardReachableVertically, true);
  assert.equal(inspection.fullErrorTextReachable, true);
  assert.ok(inspection.inputHeight >= 44);
  assert.ok(inspection.submitHeight >= 44);
  assert.deepEqual(axe, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(runtimeConsoleErrors, []);
  assert.ok(auditConsoleNoise.every(message => /workbench\.css.*connect-src 'none'/i.test(message)), JSON.stringify(auditConsoleNoise));
  await context.close();
  return { view, inspection, axe, pageErrors, runtimeConsoleErrors, auditConsoleNoise, screenshot };
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  try {
    const cases = [];
    for (const view of views) cases.push(await runCase(browser, view));
    const report = {
      generatedAt: new Date().toISOString(),
      version: require("../package.json").version,
      errorCode: errorResult.code,
      expectedMessage: errorResult.message,
      cases
    };
    const reportPath = path.join(evidenceDir, "license-error-ui-audit.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, reportPath, cases: cases.length, seriousAxeViolations: 0 }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
