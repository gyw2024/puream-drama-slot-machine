"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, safeStorage } = require("electron");
const { BridgeClient } = require("../app/bridge-client");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { DramaLicenseClient } = require("../app/license-gate");
const { hydratePureamDefaults } = require("../app/puream-auth-config");

const USER_DATA = path.join(process.env.APPDATA, "xiangsu-seedance-bridge");
const WORKBENCH = path.join(USER_DATA, "workbench");
const PRODUCT_SRC = path.join(WORKBENCH, "reusable-asset-library", "files", "asset_mst6531s_533f15b4.png");
const OUTPUT = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-3MIN-E2E");
const STATE_PATH = path.join(OUTPUT, "live-state.json");
const REPORT_PATH = path.join(OUTPUT, "live-report.json");
const FFMPEG = path.resolve(__dirname, "../media-tools/ffmpeg.exe");

const PRODUCT = {
  name: "硅胶护膝",
  description: "医疗级硅胶护膝，贴合膝盖与半月板，日常走路、上下楼时减震护膝，柔软可水洗。",
  sellingPoints: "保护膝盖半月板损伤,贴合不滑落,走路上下楼减震"
};

function now() {
  return new Date().toISOString();
}

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
    stage: project?.currentStage || "",
    status: project?.status || "",
    automation: project?.automation?.status || "",
    message: String(project?.automation?.message || "").slice(0, 240),
    seconds: (project?.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    shots: (project?.shots || []).length,
    characters: (project?.characters || []).map(item => item.name),
    scenes: (project?.scenes || []).map(item => item.name),
    props: (project?.assetLibraries?.props || []).map(item => item.name),
    wardrobes: (project?.assetLibraries?.wardrobes || []).map(item => item.label || item.name),
    product: project?.product?.name || "",
    productImage: Boolean(project?.product?.imagePath && fs.existsSync(project.product.imagePath)),
    topics: (project?.ideation?.topics || []).length,
    selectedTopic: project?.ideation?.selectedTopicId || "",
    scriptChars: String(project?.script?.raw || "").length,
    analysisMethod: project?.script?.analysisMethod || "",
    storyboards: (project?.candidates || []).filter(item => String(item.stage || "").startsWith("storyboard") && item.filePath).length,
    videos: (project?.candidates || []).filter(item => item.stage === "shot_video" && item.filePath).length,
    finalVideoPath: project?.finalVideoPath || "",
    finalExists: Boolean(project?.finalVideoPath && fs.existsSync(project.finalVideoPath))
  };
}

async function runStage(label, fn) {
  const started = Date.now();
  log(`${label}-start`);
  try {
    const result = await fn();
    log(`${label}-ok`, { ms: Date.now() - started, ...(result && typeof result === "object" && result.id ? snapshot(result) : result || {}) });
    return result;
  } catch (error) {
    log(`${label}-fail`, { ms: Date.now() - started, code: error.code || "", message: error.message });
    throw error;
  }
}

app.commandLine.appendSwitch("disable-gpu");
app.setName("xiangsu-seedance-bridge");
app.setPath("userData", USER_DATA);
app.on("window-all-closed", event => event.preventDefault());
app.on("before-quit", () => log("before-quit", {}));
process.on("uncaughtException", error => {
  log("uncaught", { code: error.code || "", message: error.message, stack: String(error.stack || "").slice(0, 800) });
});
process.on("unhandledRejection", error => {
  log("unhandled", { code: error?.code || "", message: error?.message || String(error), stack: String(error?.stack || "").slice(0, 800) });
});

app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const keepAlive = new BrowserWindow({
    show: false,
    width: 100,
    height: 100,
    webPreferences: { sandbox: true, contextIsolation: true }
  });
  const heartbeat = setInterval(() => {
    log("heartbeat", { projectId: String(process.env.E2E_PROJECT_ID || ""), pid: process.pid });
  }, 15000);
  const bugs = [];
  let projectId = "";
  try {
    if (!fs.existsSync(PRODUCT_SRC)) throw new Error(`缺少历史商品图：${PRODUCT_SRC}`);
    const decode = value => {
      if (!String(value || "").startsWith("enc:")) return value || "";
      if (!safeStorage.isEncryptionAvailable()) return "";
      try { return safeStorage.decryptString(Buffer.from(String(value).slice(4), "base64")); }
      catch { return ""; }
    };
    const license = new DramaLicenseClient();
    const store = new WorkbenchStore(WORKBENCH, {
      encode: value => value ? `enc:${safeStorage.encryptString(value).toString("base64")}` : "",
      decode
    });
    hydratePureamDefaults(store, license.storedActivationCode());
    const settings = store.getSettings();
    const bridge = new BridgeClient();
    bridge.configure(settings.videoProvider);
    const workflow = new WorkbenchWorkflow({
      store,
      bridge,
      locateFfmpeg: () => (fs.existsSync(FFMPEG) ? FFMPEG : ""),
      stagingRoot: path.join(process.env.LOCALAPPDATA || os.tmpdir(), "PureamDramaSlot", "e2e-3min-staging"),
      licenseClient: license
    });
    try { await license.ensureSession(); } catch (error) {
      log("license-warn", { message: error.message });
    }

    const resumeId = String(process.env.E2E_PROJECT_ID || "").trim();
    let created = null;
    if (resumeId) {
      try { created = store.getProject(resumeId); } catch { created = null; }
    }
    if (!created) {
      created = store.createProject("E2E三分钟超短剧｜180秒｜硅胶护膝", {
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
    }
    projectId = created.id;
    if (["running", "pausing", "stopping"].includes(String(created.automation?.status || ""))) {
      workflow.abandonPhantomVideoJobs(projectId);
      const latest = store.getProject(projectId);
      latest.automation = {
        ...(latest.automation || {}),
        status: "interrupted",
        message: "E2E 进程中断后恢复，继续未完成阶段",
        updatedAt: now()
      };
      store.saveProject(latest);
    }
    store.patchProject(projectId, {
      generation: {
        ...(created.generation || {}),
        engine: "hailuo-h3",
        videoProviderKind: "puream-hailuo-h3",
        mode: "storyboard_sheet",
        modeConfirmed: true,
        targetDurationSeconds: 180,
        shotDuration: 10,
        aspectRatio: "9:16"
      },
      productionPlan: {
        ...(created.productionPlan || {}),
        inputMode: "ai",
        executionMode: "full",
        scriptFormat: "production",
        scriptFormatConfirmed: true,
        commerceMode: "natural",
        scriptHandling: "optimize"
      }
    });
    const current = store.getProject(projectId);
    if (!current.product?.imagePath || !fs.existsSync(current.product.imagePath)) {
      const imported = workflow.importAsset(projectId, "product", PRODUCT_SRC, "product-knee-brace");
      store.replaceProductAsset(projectId, {
        imagePath: imported.path,
        publicUrl: "",
        source: "e2e-historical-upload",
        name: PRODUCT.name,
        description: PRODUCT.description,
        sellingPoints: PRODUCT.sellingPoints
      });
    } else {
      store.replaceProductAsset(projectId, {
        imagePath: current.product.imagePath,
        publicUrl: current.product.publicUrl || "",
        source: current.product.source || "e2e-historical-upload",
        name: PRODUCT.name,
        description: PRODUCT.description,
        sellingPoints: PRODUCT.sellingPoints
      });
    }
    log("product-ready", snapshot(store.getProject(projectId)));

    let live = store.getProject(projectId);
    if (!(live.ideation?.topics || []).length) {
      await runStage("topics", async () => workflow.generateTopicOptions(projectId, { track: false }));
      live = store.getProject(projectId);
    }
    const topic = (live.ideation?.topics || []).find(item => item.id === live.ideation?.selectedTopicId) || (live.ideation?.topics || [])[0];
    if (!topic?.id) throw Object.assign(new Error("选题未返回可用题材"), { code: "TOPIC_EMPTY" });
    if (live.ideation?.selectedTopicId !== topic.id) {
      store.patchProject(projectId, {
        ideation: {
          ...(live.ideation || {}),
          selectedTopicId: topic.id,
          selectedTopic: topic
        }
      });
    }
    log("topic-selected", { title: topic.title || "", hook: String(topic.hook || topic.premise || "").slice(0, 160) });

    live = store.getProject(projectId);
    if (!String(live.script?.raw || "").trim()) {
      await runStage("script", async () => workflow.generateCompleteScript(projectId, { track: false }));
    }
    live = store.getProject(projectId);
    if (!(live.shots || []).length) {
      await runStage("analyze", async () => workflow.analyzeScript(projectId, { track: false }));
    }
    try { await runStage("prompts", async () => workflow.refreshCreatorPrompts(projectId, { forceCompiled: true })); }
    catch (error) { bugs.push({ stage: "prompts", code: error.code || "", message: error.message }); }
    await runStage("assets", async () => workflow.generateAllAssets(projectId, { track: false }));
    await runStage("storyboards", async () => workflow.generateAllStoryboards(projectId, { track: false }));
    await runStage("videos", async () => workflow.generateAllShotVideos(projectId, { track: false }));
    await runStage("stitch", async () => workflow.stitchProject(projectId));

    const final = store.getProject(projectId);
    const report = {
      at: now(),
      ok: Boolean(final.finalVideoPath && fs.existsSync(final.finalVideoPath)),
      projectId,
      snapshot: snapshot(final),
      bugs,
      history: readJson(STATE_PATH).history || []
    };
    writeJson(REPORT_PATH, report);
    log("done", report.snapshot);
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    const report = {
      at: now(),
      ok: false,
      projectId,
      code: error.code || "",
      message: error.message,
      bugs,
      history: readJson(STATE_PATH).history || []
    };
    writeJson(REPORT_PATH, report);
    log("fatal", { code: error.code || "", message: error.message, projectId });
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    try { if (!keepAlive.isDestroyed()) keepAlive.destroy(); } catch {}
    app.quit();
  }
});
