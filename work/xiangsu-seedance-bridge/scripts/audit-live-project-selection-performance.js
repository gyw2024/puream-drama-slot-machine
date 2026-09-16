"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const executablePath = process.env.DRAMA_SLOT_INSTALLED_EXE
    || path.join(process.env.LOCALAPPDATA || "", "Programs", "xiangsu-seedance-bridge", "纯梦短剧老虎机.exe");
  const evidenceRoot = path.resolve(process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
    || path.join(root, ".codex_tests", "TASK-20260903-PROJECT-LIST-LATENCY-014", "live-user-navigation"));
  const runDir = path.join(evidenceRoot, stamp());
  const preferredProjectId = String(process.env.DRAMA_SLOT_AUDIT_PROJECT_ID || "").trim();
  fs.mkdirSync(runDir, { recursive: true });
  assert.ok(fs.existsSync(executablePath), `Installed executable missing: ${executablePath}`);

  const startedAt = performance.now();
  const runtimeIssues = { consoleErrors: [], pageErrors: [], requestFailures: [] };
  const electronApp = await electron.launch({ executablePath, args: [] });
  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    page.on("console", message => {
      if (message.type() !== "error") return;
      const value = message.text();
      if (!/net::ERR_(?:ABORTED|FAILED).*puream\.cn/i.test(value)) runtimeIssues.consoleErrors.push(value);
    });
    page.on("pageerror", error => runtimeIssues.pageErrors.push(String(error?.stack || error)));
    page.on("requestfailed", request => {
      if (!/puream\.cn/i.test(request.url())) runtimeIssues.requestFailures.push({ url: request.url(), error: request.failure()?.errorText || "" });
    });
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    const readyMs = performance.now() - startedAt;
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));

    const options = await page.locator("#projectSelect option").evaluateAll(nodes => nodes.map(node => ({
      value: node.value,
      label: node.textContent?.trim() || ""
    })));
    assert.ok(options.length > 0, "Live project list is empty");
    const target = options.find(option => option.value === preferredProjectId)
      || options.find(option => /九宝茶/.test(option.label))
      || options[0];
    const switchStartedAt = performance.now();
    await page.selectOption("#projectSelect", target.value);
    await page.waitForFunction(projectId => (
      document.querySelector("#projectSelect")?.value === projectId
      && document.querySelector("#projectSelect")?.disabled === false
      && document.querySelector("#projectSelect")?.getAttribute("aria-busy") !== "true"
    ), target.value, { timeout: 15_000 });
    const switchMs = performance.now() - switchStartedAt;

    const memoryBeforeTimer = await electronApp.evaluate(() => process.memoryUsage());
    const cpuBeforeTimer = await electronApp.evaluate(() => process.cpuUsage());
    await page.waitForTimeout(17_000);
    const probeStartedAt = performance.now();
    const responsiveTitle = await page.title();
    const timerProbeMs = performance.now() - probeStartedAt;
    const memoryAfterTimer = await electronApp.evaluate(() => process.memoryUsage());
    const cpuAfterTimer = await electronApp.evaluate(() => process.cpuUsage());
    const screenshotPath = path.join(runDir, "live-project-after-timer.png");
    await page.screenshot({ path: screenshotPath, animations: "disabled" });

    const result = {
      ok: true,
      executablePath,
      runDir,
      projectCount: options.length,
      selectedProject: target,
      timings: { readyMs, switchMs, timerProbeMs },
      memory: {
        beforeTimerRss: memoryBeforeTimer.rss,
        afterTimerRss: memoryAfterTimer.rss,
        growthBytes: memoryAfterTimer.rss - memoryBeforeTimer.rss
      },
      cpu: {
        userMicros: cpuAfterTimer.user - cpuBeforeTimer.user,
        systemMicros: cpuAfterTimer.system - cpuBeforeTimer.system
      },
      responsiveTitle,
      screenshotPath,
      paidVideoJobsSubmitted: 0,
      runtimeIssues
    };
    assert.ok(switchMs < 10_000, `Live project switch took ${switchMs.toFixed(0)}ms`);
    assert.ok(timerProbeMs < 500, `Live renderer was blocked after recovery tick for ${timerProbeMs.toFixed(0)}ms`);
    assert.ok(result.memory.growthBytes < 256 * 1024 * 1024, `Live main-process RSS grew by ${result.memory.growthBytes} bytes`);
    assert.equal(runtimeIssues.pageErrors.length, 0, runtimeIssues.pageErrors.join("\n"));
    fs.writeFileSync(path.join(runDir, "audit.json"), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
