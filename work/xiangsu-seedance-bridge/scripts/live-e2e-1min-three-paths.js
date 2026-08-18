"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-DRAMA-E2E-FIX");
const TASK_ID = "TASK-20260818-DRAMA-E2E-FIX";
const RUNTIME_ROOT = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "PureamDramaSlot", "audits", TASK_ID);
const USER_DATA_ROOT = path.join(RUNTIME_ROOT, "electron-user-data");
const WORKBENCH_ROOT = path.join(RUNTIME_ROOT, "workbench");
const STATE_PATH = path.join(OUTPUT, "live-state.json");

const SIMPLE_SCRIPT = fs.readFileSync(path.join(OUTPUT, "01-简易一分钟-缴费单.txt"), "utf8");
const AGENT_SCRIPT = fs.readFileSync(path.join(OUTPUT, "02-Agent手传-一分钟录音笔.txt"), "utf8");

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
  const record = { at: now(), stage, ...detail };
  const state = readJson(STATE_PATH, {});
  state.last = record;
  state.history = [...(state.history || []), record].slice(-80);
  writeJson(STATE_PATH, state);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function prepareRuntime() {
  fs.mkdirSync(USER_DATA_ROOT, { recursive: true });
  fs.mkdirSync(WORKBENCH_ROOT, { recursive: true });
  const sourceUserData = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
  const sourceWorkbench = path.join(sourceUserData, "workbench");
  for (const [source, target] of [
    [path.join(sourceUserData, "Local State"), path.join(USER_DATA_ROOT, "Local State")],
    [path.join(sourceUserData, "drama-license.json"), path.join(USER_DATA_ROOT, "drama-license.json")],
    [path.join(sourceWorkbench, "settings.json"), path.join(WORKBENCH_ROOT, "settings.json")]
  ]) {
    if (!fs.existsSync(source)) throw new Error(`缺少运行文件：${source}`);
    fs.copyFileSync(source, target);
  }
}

async function invoke(page, scope, method, ...args) {
  const result = await page.evaluate(async ({ scopeName, methodName, values }) => {
    if (scopeName === "simple") return window.dramaSlot.simple.call(methodName, ...values);
    return window.dramaSlot.workbench[methodName](...values);
  }, { scopeName: scope, methodName: method, values: args });
  if (!result?.ok) {
    const error = new Error(result?.message || `${scope}.${method} failed`);
    error.code = result?.code || "E2E_FAILED";
    throw error;
  }
  return result;
}

function snapshot(project) {
  return {
    id: project.id,
    title: project.title,
    stage: project.currentStage,
    status: project.status,
    seconds: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    shots: (project.shots || []).length,
    characters: (project.characters || []).map(item => item.name),
    scenes: (project.scenes || []).map(item => item.name),
    props: (project.assetLibraries?.props || []).map(item => item.name),
    wardrobes: (project.assetLibraries?.wardrobes || []).map(item => item.label || item.name),
    productShots: (project.shots || []).filter(item => item.productMention).map(item => item.id),
    storyboards: (project.candidates || []).filter(item => String(item.stage || "").startsWith("storyboard") && item.filePath).length,
    videos: (project.candidates || []).filter(item => item.stage === "shot_video" && item.filePath).length,
    finalVideoPath: project.finalVideoPath || "",
    analysisMethod: project.script?.analysisMethod || ""
  };
}

async function runPaidStage(page, scope, projectId, method, label) {
  log(`${label}-start`, { projectId, method });
  const started = Date.now();
  try {
    await invoke(page, scope, method, projectId);
    const project = (await invoke(page, scope, "getProject", projectId)).project;
    log(`${label}-ok`, { ms: Date.now() - started, ...snapshot(project) });
    return project;
  } catch (error) {
    log(`${label}-fail`, { ms: Date.now() - started, code: error.code, message: error.message });
    throw error;
  }
}

async function uploadAndProduce(page, spec) {
  const created = await invoke(page, spec.scope, "createProject", spec.title, {
    inputMode: "manual",
    executionMode: spec.execution || "full",
    scriptHandling: "respect",
    commerceMode: spec.product ? "natural" : "none",
    targetDurationSeconds: 60,
    shotDuration: 10,
    mode: "storyboard_sheet",
    modeConfirmed: true,
    videoProviderKind: "puream-hailuo-h3"
  });
  const projectId = created.project.id;
  await invoke(page, spec.scope, "patchProject", projectId, {
    script: { raw: spec.script },
    product: spec.product || { name: "", description: "", sellingPoints: "" },
    generation: {
      ...(created.project.generation || {}),
      targetDurationSeconds: 60,
      mode: "storyboard_sheet",
      modeConfirmed: true,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      aspectRatio: "9:16"
    },
    productionPlan: {
      inputMode: "manual",
      executionMode: spec.execution || "full",
      scriptHandling: "respect",
      commerceMode: spec.product ? "natural" : "none"
    }
  });
  let project = await runPaidStage(page, spec.scope, projectId, "analyzeScript", `${spec.key}-analyze`);
  const analysis = snapshot(project);
  try { project = await runPaidStage(page, spec.scope, projectId, "generateAllAssets", `${spec.key}-assets`); } catch {}
  try { project = await runPaidStage(page, spec.scope, projectId, "generateAllStoryboards", `${spec.key}-storyboards`); } catch {}
  try { project = await runPaidStage(page, spec.scope, projectId, "generateAllShotVideos", `${spec.key}-videos`); } catch {}
  try { project = await runPaidStage(page, spec.scope, projectId, spec.scope === "simple" ? "stitch" : "stitchProject", `${spec.key}-stitch`); } catch {}
  project = (await invoke(page, spec.scope, "getProject", projectId)).project;
  return { key: spec.key, analysis, final: snapshot(project) };
}

async function oneClickProduce(page) {
  const created = await invoke(page, "agent", "createProject", "E2E一键一分钟", {
    inputMode: "ai",
    executionMode: "full",
    commerceMode: "natural",
    targetDurationSeconds: 60,
    shotDuration: 10,
    mode: "storyboard_sheet",
    modeConfirmed: true,
    videoProviderKind: "puream-hailuo-h3"
  });
  const projectId = created.project.id;
  await invoke(page, "agent", "patchProject", projectId, {
    product: {
      name: "无品牌折叠暖手宝",
      description: "浅灰可折叠暖手宝",
      sellingPoints: "捂手、便携"
    },
    generation: {
      ...(created.project.generation || {}),
      targetDurationSeconds: 60,
      mode: "storyboard_sheet",
      modeConfirmed: true,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3"
    }
  });
  log("oneclick-topics-start", { projectId });
  await invoke(page, "agent", "generateTopics", projectId);
  const afterTopics = (await invoke(page, "agent", "getProject", projectId)).project;
  const topic = (afterTopics.ideation?.topics || afterTopics.topicOptions || [])[0];
  if (topic?.id || topic?.title) {
    await invoke(page, "agent", "patchProject", projectId, {
      ideation: { ...(afterTopics.ideation || {}), selectedTopicId: topic.id || topic.title, selectedTopic: topic }
    });
  }
  log("oneclick-script-start", { topic: topic?.title || topic?.id || "" });
  await invoke(page, "agent", "generateCompleteScript", projectId);
  const scripted = snapshot((await invoke(page, "agent", "getProject", projectId)).project);
  try { await runPaidStage(page, "agent", projectId, "analyzeScript", "oneclick-analyze"); } catch {}
  try { await runPaidStage(page, "agent", projectId, "runFullPipeline", "oneclick-pipeline"); } catch {
    try { await runPaidStage(page, "agent", projectId, "generateAllAssets", "oneclick-assets"); } catch {}
    try { await runPaidStage(page, "agent", projectId, "generateAllStoryboards", "oneclick-storyboards"); } catch {}
    try { await runPaidStage(page, "agent", projectId, "generateAllShotVideos", "oneclick-videos"); } catch {}
    try { await runPaidStage(page, "agent", projectId, "stitchProject", "oneclick-stitch"); } catch {}
  }
  const final = snapshot((await invoke(page, "agent", "getProject", projectId)).project);
  return { key: "agent-oneclick", analysis: scripted, final };
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  prepareRuntime();
  log("launch", { workbench: WORKBENCH_ROOT });
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${USER_DATA_ROOT}`],
    env: {
      ...process.env,
      DRAMA_SLOT_WORKSPACE_MODE: "agent",
      DRAMA_SLOT_DATA_ROOT: WORKBENCH_ROOT
    }
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true" || document.body.dataset.simpleModeReady === "true", null, { timeout: 90_000 });
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

  const results = [];
  try {
    results.push(await uploadAndProduce(page, {
      key: "simple-upload",
      scope: "simple",
      title: "E2E简易缴费单",
      script: SIMPLE_SCRIPT,
      execution: "full",
      product: { name: "无品牌折叠暖手宝", description: "浅灰可折叠暖手宝", sellingPoints: "捂手、便携" }
    }));
  } catch (error) {
    log("simple-upload-fail", { code: error.code, message: error.message });
    results.push({ key: "simple-upload", error: error.message });
  }
  try {
    results.push(await uploadAndProduce(page, {
      key: "agent-upload",
      scope: "agent",
      title: "E2E手传录音笔",
      script: AGENT_SCRIPT,
      execution: "full"
    }));
  } catch (error) {
    log("agent-upload-fail", { code: error.code, message: error.message });
    results.push({ key: "agent-upload", error: error.message });
  }
  try {
    results.push(await oneClickProduce(page));
  } catch (error) {
    log("oneclick-fail", { code: error.code, message: error.message });
    results.push({ key: "agent-oneclick", error: error.message });
  }

  writeJson(path.join(OUTPUT, "live-report.json"), { at: now(), preflight, results });
  log("done", { cases: results.map(item => item.key) });
  await app.close();
}

main().catch(error => {
  log("fatal", { code: error.code, message: error.message });
  process.exitCode = 1;
});
