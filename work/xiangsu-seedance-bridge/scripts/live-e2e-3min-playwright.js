"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-3MIN-E2E");
const LIVE_USER_DATA = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
const PRODUCT_SRC = path.join(LIVE_USER_DATA, "workbench", "reusable-asset-library", "files", "asset_mst6531s_533f15b4.png");
const STATE_PATH = path.join(OUTPUT, "live-state.json");
const REPORT_PATH = path.join(OUTPUT, "live-report.json");
const RESUME_ID = String(process.env.E2E_PROJECT_ID || "project_msy2x4jz_ae9427db").trim();

const PRODUCT = {
  name: "硅胶护膝",
  description: "医疗级硅胶护膝，贴合膝盖与半月板，日常走路、上下楼时减震护膝，柔软可水洗。",
  sellingPoints: "保护膝盖半月板损伤,贴合不滑落,走路上下楼减震"
};

function now() { return new Date().toISOString(); }
function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function log(stage, detail = {}) {
  const { stage: _ignored, ...rest } = detail && typeof detail === "object" ? detail : {};
  const record = { at: now(), stage, ...rest };
  const state = readJson(STATE_PATH, {});
  state.last = record;
  state.history = [...(state.history || []), record].slice(-200);
  writeJson(STATE_PATH, state);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function snapshot(project) {
  return {
    id: project?.id || "",
    title: project?.title || "",
    currentStage: project?.currentStage || "",
    status: project?.status || "",
    automation: project?.automation?.status || "",
    message: String(project?.automation?.message || "").slice(0, 240),
    seconds: (project?.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    shots: (project?.shots || []).length,
    characters: (project?.characters || []).map(item => item.name),
    scenes: (project?.scenes || []).map(item => item.name),
    props: (project?.assetLibraries?.props || []).map(item => item.name),
    product: project?.product?.name || "",
    productImage: Boolean(project?.product?.imagePath),
    topics: (project?.ideation?.topics || []).length,
    selectedTopic: project?.ideation?.selectedTopicId || "",
    scriptChars: String(project?.script?.raw || "").length,
    storyboards: (project?.candidates || []).filter(item => String(item.stage || "").startsWith("storyboard") && item.filePath).length,
    videos: (project?.candidates || []).filter(item => item.stage === "shot_video" && item.filePath).length,
    finalVideoPath: project?.finalVideoPath || "",
    finalExists: Boolean(project?.finalVideoPath && fs.existsSync(project.finalVideoPath))
  };
}

const LONG_METHODS = new Set([
  "generateTopics",
  "generateCompleteScript",
  "analyzeScript",
  "refreshCreatorPrompts",
  "generateAllAssets",
  "generateAllStoryboards",
  "generateAllShotVideos",
  "stitch",
  "runFullPipeline"
]);

async function invoke(page, method, ...args) {
  const result = await page.evaluate(async ({ methodName, values }) => {
    return window.dramaSlot.workbench[methodName](...values);
  }, { methodName: method, values: args });
  if (!result?.ok) {
    const error = new Error(result?.message || `workbench.${method} failed`);
    error.code = result?.code || "E2E_FAILED";
    throw error;
  }
  return result;
}

async function startLong(page, method, projectId, extraArgs = []) {
  await page.evaluate(async ({ methodName, id, values }) => {
    const key = `${methodName}:${id}`;
    window.__e2eRuns = window.__e2eRuns || {};
    window.__e2eRuns[key] = { status: "running", startedAt: Date.now() };
    Promise.resolve()
      .then(() => window.dramaSlot.workbench[methodName](id, ...values))
      .then(result => { window.__e2eRuns[key] = { status: "done", ok: result?.ok !== false, result }; })
      .catch(error => { window.__e2eRuns[key] = { status: "error", message: error?.message || String(error), code: error?.code || "" }; });
    return { started: true };
  }, { methodName: method, id: projectId, values: extraArgs });
}

function automationBusy(project) {
  const auto = String(project?.automation?.status || "");
  return project?.runtime?.activeOperation === true
    || Number(project?.runtime?.activeVideoJobCount) > 0
    || ["running", "pausing", "stopping"].includes(auto);
}

async function waitForAutomationIdle(page, projectId, label) {
  const started = Date.now();
  while (Date.now() - started < 6 * 60 * 60 * 1000) {
    let project = null;
    try {
      project = (await invoke(page, "getProject", projectId)).project;
    } catch (error) {
      log(`${label}-poll-error`, { message: error.message });
      await new Promise(resolve => setTimeout(resolve, 4000));
      continue;
    }
    if (!automationBusy(project)) return project;
    log(`${label}-poll`, snapshot(project));
    await new Promise(resolve => setTimeout(resolve, 8000));
  }
  throw Object.assign(new Error(`${label} 等待超时`), { code: "E2E_STAGE_TIMEOUT" });
}

async function runStage(page, projectId, method, label, extraArgs = []) {
  log(`${label}-start`, { projectId, method });
  const started = Date.now();
  try {
    if (LONG_METHODS.has(method)) {
      await startLong(page, method, projectId, extraArgs);
      const project = await waitForAutomationIdle(page, projectId, label);
      log(`${label}-ok`, { ms: Date.now() - started, ...snapshot(project) });
      return project;
    }
    await invoke(page, method, projectId, ...extraArgs);
    const project = (await invoke(page, "getProject", projectId)).project;
    log(`${label}-ok`, { ms: Date.now() - started, ...snapshot(project) });
    return project;
  } catch (error) {
    log(`${label}-fail`, { ms: Date.now() - started, code: error.code, message: error.message });
    throw error;
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  if (!fs.existsSync(PRODUCT_SRC)) throw new Error(`缺少历史商品图：${PRODUCT_SRC}`);
  log("launch", { userData: LIVE_USER_DATA, resumeId: RESUME_ID });
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${LIVE_USER_DATA}`],
    env: {
      ...process.env,
      DRAMA_SLOT_WORKSPACE_MODE: "agent"
    }
  });
  const page = await app.firstWindow({ timeout: 90_000 });
  page.setDefaultTimeout(0);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 120_000 });
  const preflight = await page.evaluate(async () => {
    const license = await window.dramaSlot.workbench.licenseStatus();
    const wallet = await window.dramaSlot.workbench.walletStatus();
    const walletData = wallet.wallet || {};
    return {
      licenseOk: license.ok === true && license.activated === true,
      walletOk: wallet.ok === true,
      availableCents: Number(walletData.availableCents ?? walletData.balanceCents)
    };
  });
  log("preflight", preflight);
  if (!preflight.licenseOk) throw new Error("授权无效，不能做付费实跑");
  if (!preflight.walletOk || !(preflight.availableCents > 0)) throw new Error("余额不可用，不能做付费实跑");

  const bugs = [];
  let projectId = RESUME_ID;
  let project = null;
  try {
    try { project = (await invoke(page, "getProject", projectId)).project; }
    catch { project = null; }
    if (!project) {
      const created = await invoke(page, "createProject", "E2E三分钟超短剧｜180秒｜硅胶护膝", {
        engine: "hailuo-h3",
        videoProviderKind: "puream-hailuo-h3",
        mode: "storyboard_sheet",
        modeConfirmed: true,
        executionMode: "full",
        inputMode: "ai",
        scriptFormat: "production",
        scriptFormatConfirmed: true,
        commerceMode: "natural",
        targetDurationSeconds: 180,
        shotDuration: 10
      });
      project = created.project;
      projectId = project.id;
    }
    if (["running", "pausing", "stopping"].includes(String(project.automation?.status || ""))) {
      try { await invoke(page, "pausePipeline", projectId, "stop"); }
      catch (error) { bugs.push({ stage: "stop-ghost", message: error.message }); }
    }
    await invoke(page, "patchProject", projectId, {
      product: {
        ...(project.product || {}),
        name: PRODUCT.name,
        description: PRODUCT.description,
        sellingPoints: PRODUCT.sellingPoints
      },
      generation: {
        ...(project.generation || {}),
        engine: "hailuo-h3",
        videoProviderKind: "puream-hailuo-h3",
        mode: "storyboard_sheet",
        modeConfirmed: true,
        targetDurationSeconds: 180,
        shotDuration: 10,
        aspectRatio: "9:16"
      },
      productionPlan: {
        ...(project.productionPlan || {}),
        inputMode: "ai",
        executionMode: "full",
        scriptFormat: "production",
        scriptFormatConfirmed: true,
        commerceMode: "natural",
        scriptHandling: "optimize"
      }
    });
    if (!project.product?.imagePath) {
      const imported = await app.evaluate(async ({}, payload) => {
        const { dialog } = require("electron");
        return { skipped: true, note: "renderer import uses file dialog", payload };
      }, { projectId, PRODUCT_SRC });
      log("product-import-note", imported);
    }
    // Copy product file into the live project if missing, via Node in this process.
    const destDir = path.join(LIVE_USER_DATA, "workbench", "projects", projectId, "assets", "product");
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, "product-knee-brace.png");
    if (!fs.existsSync(dest)) fs.copyFileSync(PRODUCT_SRC, dest);
    await invoke(page, "patchProject", projectId, {
      product: { name: PRODUCT.name, description: PRODUCT.description, sellingPoints: PRODUCT.sellingPoints, imagePath: dest, source: "e2e-historical-upload" }
    });
    project = (await invoke(page, "getProject", projectId)).project;
    log("product-ready", snapshot(project));

    if (!(project.ideation?.topics || []).length) {
      project = await runStage(page, projectId, "generateTopics", "topics");
    }
    const topic = (project.ideation?.topics || []).find(item => item.id === project.ideation?.selectedTopicId)
      || (project.ideation?.topics || [])[0];
    if (!topic?.id) throw Object.assign(new Error("选题未返回可用题材"), { code: "TOPIC_EMPTY" });
    if (project.ideation?.selectedTopicId !== topic.id) {
      await invoke(page, "patchProject", projectId, {
        ideation: { ...(project.ideation || {}), selectedTopicId: topic.id, selectedTopic: topic }
      });
    }
    log("topic-selected", { title: topic.title || "", hook: String(topic.hook || topic.premise || "").slice(0, 160) });

    project = (await invoke(page, "getProject", projectId)).project;
    if (!String(project.script?.raw || "").trim()) {
      project = await runStage(page, projectId, "generateCompleteScript", "script");
    }
    if (!(project.shots || []).length) {
      project = await runStage(page, projectId, "analyzeScript", "analyze");
    }
    project = await runStage(page, projectId, "generateAllAssets", "assets");
    try { project = await runStage(page, projectId, "refreshCreatorPrompts", "prompts", [{ forceCompiled: true }]); }
    catch (error) { bugs.push({ stage: "prompts", code: error.code || "", message: error.message }); }
    project = await runStage(page, projectId, "generateAllStoryboards", "storyboards");
    project = await runStage(page, projectId, "generateAllShotVideos", "videos");
    project = await runStage(page, projectId, "stitch", "stitch");

    const report = { at: now(), ok: snapshot(project).finalExists, projectId, snapshot: snapshot(project), bugs, preflight };
    writeJson(REPORT_PATH, report);
    log("done", report.snapshot);
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    const report = { at: now(), ok: false, projectId, code: error.code || "", message: error.message, bugs };
    writeJson(REPORT_PATH, report);
    log("fatal", { code: error.code || "", message: error.message, projectId });
    process.exitCode = 1;
  } finally {
    try { await app.close(); } catch {}
  }
}

process.on("uncaughtException", error => {
  log("uncaught", { code: error.code || "", message: error.message, stack: String(error.stack || "").slice(0, 800) });
});
process.on("unhandledRejection", error => {
  log("unhandled", { code: error?.code || "", message: error?.message || String(error) });
});
process.on("exit", code => {
  try { log("node-exit", { code }); } catch {}
});

main().catch(error => {
  log("fatal", { code: error.code || "", message: error.message });
  process.exit(1);
});
