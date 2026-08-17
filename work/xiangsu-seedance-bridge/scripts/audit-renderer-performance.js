"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

async function main() {
  const executablePath = path.resolve(String(process.env.DRAMA_SLOT_PERF_EXE || ""));
  const dataRoot = path.resolve(String(process.env.DRAMA_SLOT_PERF_DATA_ROOT || ""));
  const outputDir = path.resolve(String(process.env.DRAMA_SLOT_PERF_OUTPUT || ""));
  const licenseSource = path.resolve(String(process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE || ""));
  assert.ok(fs.existsSync(executablePath), "DRAMA_SLOT_PERF_EXE is required");
  assert.ok(fs.existsSync(dataRoot), "DRAMA_SLOT_PERF_DATA_ROOT is required");
  assert.ok(fs.existsSync(licenseSource), "DRAMA_SLOT_AUDIT_LICENSE_SOURCE is required");
  fs.mkdirSync(outputDir, { recursive: true });
  const userDataDir = path.join(outputDir, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
  fs.copyFileSync(path.join(path.dirname(licenseSource), "Local State"), path.join(userDataDir, "Local State"));
  fs.writeFileSync(path.join(userDataDir, "workspace-mode.json"), JSON.stringify({ version: 1, mode: "agent", updatedAt: new Date().toISOString() }, null, 2), "utf8");

  const startedAt = Date.now();
  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: dataRoot, DRAMA_SLOT_WORKSPACE_MODE: "agent" }
  });
  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    const readyMs = Date.now() - startedAt;
    const gpu = await electronApp.evaluate(async ({ app }) => ({
      features: app.getGPUFeatureStatus(),
      info: await app.getGPUInfo("basic")
    }));
    const defaults = await page.evaluate(() => window.dramaSlot.defaults());
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    const first = await session.send("Performance.getMetrics");
    const firstMap = Object.fromEntries(first.metrics.map(item => [item.name, item.value]));
    await page.waitForTimeout(10_000);
    const second = await session.send("Performance.getMetrics");
    const secondMap = Object.fromEntries(second.metrics.map(item => [item.name, item.value]));
    const stageSwitches = [];
    for (const stage of ["script", "assets", "shots", "videos", "final", "settings"]) {
      const elapsed = await page.evaluate(async currentStage => {
        const start = performance.now();
        document.querySelector(`.stage-button[data-stage="${currentStage}"]`)?.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return performance.now() - start;
      }, stage);
      stageSwitches.push({ stage, elapsedMs: Number(elapsed.toFixed(2)) });
    }
    const dom = await page.evaluate(() => ({
      nodes: document.getElementsByTagName("*").length,
      images: [...document.images].filter(image => image.getClientRects().length > 0).length,
      runningAnimations: document.getAnimations().filter(animation => animation.playState === "running").map(animation => ({
        name: animation.animationName || "",
        className: String(animation.effect?.target?.className || "")
      })),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    }));
    await page.screenshot({ path: path.join(outputDir, "runtime-performance.png"), animations: "disabled" });
    const result = {
      ok: true,
      executablePath,
      dataRoot,
      readyMs,
      renderingMode: defaults.renderingMode,
      renderingReason: defaults.renderingReason,
      gpu,
      rendererTenSecondDelta: {
        taskDurationMs: Number(((secondMap.TaskDuration - firstMap.TaskDuration) * 1000).toFixed(2)),
        scriptDurationMs: Number(((secondMap.ScriptDuration - firstMap.ScriptDuration) * 1000).toFixed(2)),
        layoutDurationMs: Number(((secondMap.LayoutDuration - firstMap.LayoutDuration) * 1000).toFixed(2)),
        recalcStyleDurationMs: Number(((secondMap.RecalcStyleDuration - firstMap.RecalcStyleDuration) * 1000).toFixed(2))
      },
      stageSwitches,
      dom
    };
    fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(result, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
