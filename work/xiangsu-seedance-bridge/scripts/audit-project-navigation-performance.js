"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { WorkbenchStore } = require("../app/workbench-store");
const { FoundryRuntimeStore } = require("../app/foundry/runtime-store");
const { resolveUserDataDirectory } = require("../app/user-data-location");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function largeShots(prefix) {
  const filler = "Performance fixture sentence with stable dialogue, blocking, emotion and camera continuity. ".repeat(95);
  return Array.from({ length: 70 }, (_item, index) => ({
    id: `${prefix}-S${String(index + 1).padStart(2, "0")}`,
    number: index + 1,
    duration: 8,
    sceneId: "SC01",
    sceneName: "性能测试场景",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    speakerIds: [index % 2 ? "C01" : "C02"],
    dialogueTurns: [{
      id: `${prefix}-D${String(index + 1).padStart(3, "0")}`,
      speakerId: index % 2 ? "C01" : "C02",
      speakerName: index % 2 ? "甲" : "乙",
      text: `第${index + 1}镜性能测试对白。`
    }],
    systemVideoPrompt: {
      englishPrompt: filler,
      chinesePrompt: `第${index + 1}镜中文核对稿。`
    },
    promptReviewReferencePlan: { images: [] }
  }));
}

function seedWorkspace(rootDir, historyCount = 300) {
  const store = new WorkbenchStore(rootDir);
  const stable = [];
  for (let index = 0; index < historyCount; index += 1) {
    const project = store.createProject(`历史失败项目 ${String(index + 1).padStart(3, "0")}`);
    project.automation = {
      ...(project.automation || {}),
      status: "failed",
      operation: "assets",
      errorCode: "HISTORICAL_FIXTURE_FAILURE",
      message: "历史失败记录，仅用于项目列表性能审查"
    };
    store.saveProject(project);
    stable.push(project.id);
  }

  const createLarge = (title, prefix) => {
    const project = store.createProject(title, { inputMode: "manual" });
    project.status = "analyzed";
    project.currentStage = "videos";
    project.script = {
      ...(project.script || {}),
      raw: "性能测试完整剧本。".repeat(1_000),
      generatedAt: new Date().toISOString()
    };
    project.characters = [
      { id: "C01", name: "甲", description: "性能测试人物甲" },
      { id: "C02", name: "乙", description: "性能测试人物乙" }
    ];
    project.scenes = [{ id: "SC01", name: "性能测试场景", description: "固定室内空间" }];
    project.shots = largeShots(prefix);
    project.importedProductionPackage = { validation: "performance-fixture", referenceAudioMode: "image_only" };
    project.generation = { ...(project.generation || {}), mode: "production_package", modeConfirmed: true };
    project.automation = {
      ...(project.automation || {}),
      status: "paused_user",
      operation: "shot_videos",
      stage: "video_preflight",
      message: "性能测试项目已暂停，没有上游任务"
    };
    store.saveProject(project);
    return project.id;
  };

  const firstId = createLarge("大型项目 A", "A");
  const secondId = createLarge("大型项目 B", "B");
  const runtime = new FoundryRuntimeStore(rootDir);
  runtime.setMeta("legacy-migration", { completedAt: new Date().toISOString(), failures: [] });
  runtime.close();
  return { historyCount, firstId, secondId, stable };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const evidenceRoot = path.resolve(process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
    || path.join(root, ".codex_tests", "TASK-20260903-PROJECT-LIST-LATENCY-014", "project-navigation"));
  const runDir = path.join(evidenceRoot, stamp());
  const userDataDir = path.join(runDir, "user-data");
  const workbenchDir = path.join(runDir, "workbench");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "workspace-mode.json"), JSON.stringify({
    version: 1,
    mode: "agent",
    updatedAt: new Date().toISOString()
  }, null, 2));
  const fixture = seedWorkspace(workbenchDir, Number(process.env.DRAMA_SLOT_HISTORY_COUNT) || 300);

  const requestedExecutable = String(process.env.DRAMA_SLOT_AUDIT_EXE || "").trim();
  const sourceElectron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const executablePath = requestedExecutable || sourceElectron;
  assert.ok(fs.existsSync(executablePath), `Electron executable missing: ${executablePath}`);
  const sourceLaunch = path.resolve(executablePath) === path.resolve(sourceElectron);
  if (!sourceLaunch) {
    const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE
      || path.join(resolveUserDataDirectory({ appDataPath: process.env.APPDATA || "" }), "drama-license.json");
    const localStateSource = path.join(path.dirname(licenseSource), "Local State");
    assert.ok(fs.existsSync(licenseSource), `Packaged performance audit activation snapshot missing: ${licenseSource}`);
    assert.ok(fs.existsSync(localStateSource), `Packaged performance audit Local State missing: ${localStateSource}`);
    fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
    fs.copyFileSync(localStateSource, path.join(userDataDir, "Local State"));
  }
  const args = sourceLaunch
    ? [root, `--user-data-dir=${userDataDir}`]
    : [`--user-data-dir=${userDataDir}`];
  const startedAt = performance.now();
  const runtimeIssues = { consoleErrors: [], pageErrors: [], requestFailures: [] };
  const electronApp = await electron.launch({
    executablePath,
    args,
    env: {
      ...process.env,
      DRAMA_LICENSE_BYPASS: "1",
      DRAMA_SLOT_DATA_ROOT: workbenchDir,
      DRAMA_SLOT_WORKSPACE_MODE: "agent"
    }
  });
  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    page.on("console", message => {
      if (message.type() === "error") runtimeIssues.consoleErrors.push(message.text());
    });
    page.on("pageerror", error => runtimeIssues.pageErrors.push(String(error?.stack || error)));
    page.on("requestfailed", request => runtimeIssues.requestFailures.push({ url: request.url(), error: request.failure()?.errorText || "" }));
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    const readyMs = performance.now() - startedAt;
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));

    const options = await page.locator("#projectSelect option").count();
    assert.equal(options, fixture.historyCount + 2);
    const beforeScreenshot = path.join(runDir, "before-project-switch.png");
    await page.screenshot({ path: beforeScreenshot, animations: "disabled" });

    const switchStartedAt = performance.now();
    await page.selectOption("#projectSelect", fixture.firstId);
    await page.waitForFunction(id => (
      document.querySelector("#projectSelect")?.value === id
      && document.querySelector("#projectSelect")?.disabled === false
      && document.querySelector("#projectSelect")?.getAttribute("aria-busy") !== "true"
    ), fixture.firstId, { timeout: 10_000 });
    const switchMs = performance.now() - switchStartedAt;

    const memoryBeforeTimer = await electronApp.evaluate(() => process.memoryUsage());
    const cpuBeforeTimer = await electronApp.evaluate(() => process.cpuUsage());
    await page.waitForTimeout(17_000);
    const timerProbeStartedAt = performance.now();
    const responsiveTitle = await page.title();
    const timerProbeMs = performance.now() - timerProbeStartedAt;
    const memoryAfterTimer = await electronApp.evaluate(() => process.memoryUsage());
    const cpuAfterTimer = await electronApp.evaluate(() => process.cpuUsage());

    page.once("dialog", dialog => dialog.accept());
    const deleteStartedAt = performance.now();
    await page.click("#deleteProject");
    await page.waitForFunction(id => ![...document.querySelectorAll("#projectSelect option")].some(option => option.value === id), fixture.firstId, { timeout: 10_000 });
    const deleteMs = performance.now() - deleteStartedAt;
    const afterScreenshot = path.join(runDir, "after-project-delete.png");
    await page.screenshot({ path: afterScreenshot, animations: "disabled" });

    const result = {
      ok: true,
      executablePath,
      sourceLaunch,
      runDir,
      fixture: { historyCount: fixture.historyCount, firstId: fixture.firstId, secondId: fixture.secondId },
      timings: { readyMs, switchMs, deleteMs, timerProbeMs },
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
      projectOptionsBefore: options,
      projectOptionsAfter: await page.locator("#projectSelect option").count(),
      paidVideoJobs: 0,
      screenshots: [beforeScreenshot, afterScreenshot],
      runtimeIssues
    };
    assert.ok(switchMs < 5_000, `project switch took ${switchMs.toFixed(0)}ms`);
    assert.ok(deleteMs < 5_000, `project delete took ${deleteMs.toFixed(0)}ms`);
    assert.ok(timerProbeMs < 500, `renderer was blocked after recovery tick for ${timerProbeMs.toFixed(0)}ms`);
    assert.ok(result.memory.growthBytes < 256 * 1024 * 1024, `main-process RSS grew by ${result.memory.growthBytes} bytes`);
    assert.equal(result.projectOptionsAfter, fixture.historyCount + 1);
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
