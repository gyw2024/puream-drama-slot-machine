"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } = require("electron");
const { BridgeClient } = require("./bridge-client");
const { contractFor, providerDisplayName } = require("./puream-video-adapters");
const { testProvider } = require("./ai-provider");
const { stageSubmissionMedia } = require("./media-staging");
const { WorkbenchStore, defaultPromptTemplates } = require("./workbench-store");
const { WorkbenchWorkflow, projectRequiresFaceMesh, hasOssCredentials } = require("./workbench-workflow");
const {
  PROMPT_SCOPE_STAGES,
  normalizePromptStage,
  normalizePromptEntry,
  mergePromptIntake,
  applyPromptIntakeToMaterializedEntities
} = require("./prompt-intake");
const { DramaLicenseClient, licenseBypassAllowed, DEFAULT_LICENSE_BASE_URL } = require("./license-gate");
const { createIntegrityGuard } = require("./integrity-guard");
const { isActiveVideoJob } = require("./workbench-status");
const {
  hydratePureamDefaults: applyPureamAuthorization,
  findStoredPureamAuthorization,
  ensurePureamLicenseSession
} = require("./puream-auth-config");

const APP_USER_MODEL_ID = "cn.puream.drama.slotmachine";
const APP_ICON_PATH = path.join(__dirname, "assets", "app.ico");

// Keep the Windows taskbar identity aligned with the packaged app and desktop shortcut.
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

// Windows GPU process crashes (exit_code=34) leave only the title-bar overlay on a black client area.
// Disable hardware acceleration before ready so the workbench stays software-composited.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

const bridge = new BridgeClient();
let dramaLicense;
const integrityGuard = createIntegrityGuard({ app });
let mainWindow;
let workbenchStore;
let workbenchWorkflow;
let accountSwitchRequest = null;
let videoJobSyncRequest = null;
let rendererCrashReloads = 0;

function hydratePureamDefaults(store, activationCode = "") {
  return applyPureamAuthorization(store, activationCode, { bridge });
}

function storedWorkbenchAuthorizationCode() {
  try { return findStoredPureamAuthorization(requireWorkbench().store.getSettings()); }
  catch { return ""; }
}

function redactSettingsForRenderer(settings = {}) {
  const defaults = defaultPromptTemplates();
  const storedPrompts = settings.prompts || {};
  const promptKeys = [...new Set([...Object.keys(defaults), ...Object.keys(storedPrompts)])];
  const promptModes = { ...(settings.promptModes || {}) };
  const prompts = {};
  for (const key of promptKeys) {
    const current = String(storedPrompts[key] ?? defaults[key] ?? "");
    const custom = promptModes[key] === "custom";
    promptModes[key] = custom ? "custom" : "system";
    prompts[key] = custom ? current : "";
  }
  return { ...settings, prompts, promptModes };
}

function restoreHiddenPromptDefaults(input = {}, current = {}) {
  if (!input.promptModes || typeof input.promptModes !== "object") return input;
  const defaults = defaultPromptTemplates();
  const currentPrompts = current.prompts || {};
  const keys = [...new Set([...Object.keys(defaults), ...Object.keys(currentPrompts), ...Object.keys(input.promptModes)])];
  const prompts = {};
  for (const key of keys) {
    prompts[key] = input.promptModes[key] === "custom"
      ? String(input.prompts?.[key] ?? "")
      : String(defaults[key] ?? currentPrompts[key] ?? "");
  }
  return { ...input, prompts, promptModes: { ...input.promptModes } };
}

function redactPromptPreview(preview = {}) {
  // Settings-page global prompt templates stay hidden via redactSettingsForRenderer.
  // Project-level compiled image/video prompts must remain visible so creators can
  // review and override them. Never blank full/system/compiled/active here.
  return {
    ...preview,
    systemHidden: false
  };
}

const MEDIA_RULES = {
  image: {
    maxCount: 9,
    maxBytes: 30 * 1024 * 1024,
    extensions: ["png", "jpg", "jpeg", "webp"],
    filters: [{ name: "参考图片", extensions: ["png", "jpg", "jpeg", "webp"] }]
  },
  video: {
    maxCount: 3,
    maxBytes: 500 * 1024 * 1024,
    extensions: ["mp4", "mov"],
    filters: [{ name: "参考视频", extensions: ["mp4", "mov"] }]
  },
  audio: {
    maxCount: 3,
    maxBytes: 100 * 1024 * 1024,
    extensions: ["mp3", "wav", "aac", "flac"],
    filters: [{ name: "参考音频", extensions: ["mp3", "wav", "aac", "flac"] }]
  }
};

const TEXT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const SCRIPT_IMPORT_MAX_CHARS = 500_000;
const PROMPT_IMPORT_MAX_CHARS = 60_000;
const AV_PROBE_TIMEOUT_MS = 20_000;

function sanitizePublicMessage(value) {
  return String(value || "发生未知错误")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/g, "本地文件")
    .replace(/puream[-_]?hailuo[-_]?h3/gi, "纯梦云端算力")
    .replace(/minimax[\s_-]*h3/gi, "纯梦云端算力")
    .replace(/hailuo[\s_-]*h3|海螺\s*h3|\bh3\b/gi, "纯梦云端算力")
    .replace(/\bhailuo\b|海螺/gi, "纯梦云端算力");
}

function publicError(error) {
  return {
    ok: false,
    code: error?.code || "UNEXPECTED_ERROR",
    message: sanitizePublicMessage(error?.message)
  };
}

function createWindow() {
  const capturePath = (!app.isPackaged && process.env.DRAMA_SLOT_CAPTURE_PATH) || "";
  const captureResultPath = process.env.DRAMA_SLOT_CAPTURE_RESULT_PATH;
  const captureScenario = capturePath
    ? String(process.env.DRAMA_SLOT_CAPTURE_SCENARIO || "").replace(/[^a-z]/g, "")
    : "";
  const captureWidth = Math.max(800, Math.min(2560, Number(process.env.DRAMA_SLOT_CAPTURE_WIDTH) || 1720));
  const captureHeight = Math.max(600, Math.min(1600, Number(process.env.DRAMA_SLOT_CAPTURE_HEIGHT) || 1000));
  const captureZoom = Math.max(0.5, Math.min(2, Number(process.env.DRAMA_SLOT_CAPTURE_ZOOM) || 1));
  mainWindow = new BrowserWindow({
    width: capturePath ? captureWidth : 1720,
    height: capturePath ? captureHeight : 1000,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#080807",
    title: "纯梦短剧老虎机",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#070706",
      symbolColor: "#f3eadc",
      height: 36
    },
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged || Boolean(capturePath),
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", event => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", event => event.preventDefault());
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[workbench] render-process-gone", details);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const reason = String(details?.reason || "");
    if (reason === "clean-exit") return;
    const detailText = `渲染进程异常退出（${reason || "unknown"}）。可尝试重新加载工作台；若反复出现请重启应用。`;
    if (rendererCrashReloads >= 2) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "工作台已停止响应",
        message: "渲染进程多次崩溃，已停止自动重载。",
        detail: detailText,
        buttons: ["重新加载", "关闭窗口"],
        defaultId: 0,
        cancelId: 1
      }).then((result) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (result.response === 0) {
          rendererCrashReloads = 0;
          mainWindow.webContents.reload();
        } else {
          mainWindow.close();
        }
      }).catch(() => {});
      return;
    }
    rendererCrashReloads += 1;
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "工作台异常",
      message: "界面进程崩溃，即将自动重新加载。",
      detail: detailText,
      buttons: ["知道了"]
    }).catch(() => {});
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.reload();
    }, 400);
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.error("[workbench] renderer became unresponsive");
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "工作台无响应",
      message: "界面暂时卡住。可等待恢复，或强制重新加载。",
      buttons: ["等待", "重新加载"],
      defaultId: 0,
      cancelId: 0
    }).then((result) => {
      if (result.response === 1 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }).catch(() => {});
  });
  if (fs.existsSync(APP_ICON_PATH)) {
    try { mainWindow.setIcon(nativeImage.createFromPath(APP_ICON_PATH)); } catch {}
  }
  if (app.isPackaged) {
    mainWindow.webContents.on("devtools-opened", () => {
      // Packaged builds already disable DevTools in webPreferences. Treat an
      // unexpected one-frame open event as something to close and log, not as
      // permanent proof that every later paid request is unsafe. The guard
      // still blocks verified debug flags and changed/missing core files.
      console.warn("[integrity] packaged renderer DevTools event closed");
      mainWindow.webContents.closeDevTools();
    });
    mainWindow.webContents.on("before-input-event", (event, input) => {
      const key = String(input.key || "").toLowerCase();
      if (key === "f12" || ((input.control || input.meta) && input.shift && ["i", "j", "c"].includes(key))) event.preventDefault();
    });
    mainWindow.webContents.on("context-menu", event => event.preventDefault());
  }
  const captureStageQuery = String(process.env.DRAMA_SLOT_CAPTURE_STAGE || "").replace(/[^a-z]/g, "");
  const captureQuery = {
    ...(captureStageQuery ? { captureStage: captureStageQuery } : {}),
    ...(captureScenario ? { captureScenario } : {})
  };
  const captureFragment = new URLSearchParams(captureQuery).toString();
  if (captureScenario === "hailuoquick") {
    const settings = workbenchStore.getSettings();
    settings.videoProvider = {
      ...settings.videoProvider,
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      apiKey: settings.videoProvider?.apiKey || "capture-only",
      hailuoApiMode: "multimodal_to_video"
    };
    const saved = workbenchStore.saveSettings(settings);
    bridge.configure(saved.videoProvider);
  }
  const startPage = captureScenario === "hailuoquick" ? "index.html" : "workbench.html";
  mainWindow.loadFile(path.join(__dirname, "renderer", startPage), captureFragment ? { hash: captureFragment } : undefined);
  if (capturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        mainWindow.setPosition(-32000, -32000);
        mainWindow.showInactive();
        mainWindow.webContents.setZoomFactor(captureZoom);
        let captureResult = null;
        const captureStage = String(process.env.DRAMA_SLOT_CAPTURE_STAGE || "").replace(/[^a-z]/g, "");
        if (captureStage) {
          await mainWindow.webContents.executeJavaScript(`(() => {
            document.querySelectorAll('.stage-button').forEach(node => node.classList.toggle('active', node.dataset.stage === '${captureStage}'));
            document.querySelectorAll('.stage-panel').forEach(node => node.classList.toggle('active', node.dataset.panel === '${captureStage}'));
          })()`);
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        if (captureScenario === "newproject") {
          const projectTitle = String(process.env.DRAMA_SLOT_CAPTURE_PROJECT_TITLE || "新建项目按钮验收").slice(0, 60);
          await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            document.querySelector('#newProject').click();
            await wait(80);
            const dialog = document.querySelector('#newProjectDialog');
            const input = document.querySelector('#newProjectName');
            input.value = ${JSON.stringify(projectTitle)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('input[name="newVideoEngine"][value="seedance"]').checked = true;
            document.querySelector('input[name="newVideoMode"][value="continuation"]').checked = true;
            document.querySelector('#newProjectForm').requestSubmit();
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const selected = document.querySelector('#projectSelect option:checked')?.textContent || '';
              if (!dialog.open && selected === ${JSON.stringify(projectTitle)}) return { created: true, selected };
              await wait(50);
            }
            throw new Error('新建项目交互验收超时');
          })()`);
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (captureScenario === "newprojectdialog") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option')) break;
              await wait(50);
            }
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            const dialog = document.querySelector('#newProjectDialog');
            const input = document.querySelector('#newProjectName');
            input.value = '新的带货漫剧';
            document.querySelectorAll('input[name="newVideoEngine"], input[name="newVideoMode"]').forEach(node => { node.checked = false; });
            dialog.showModal();
            input.focus();
            input.select();
            await wait(180);
            return { opened: dialog.open === true, activeElement: document.activeElement?.id || '' };
          })()`);
        }
        if (captureScenario === "strategy") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option')) break;
              await wait(50);
            }
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            document.querySelector('#editProjectStrategy').click();
            await wait(180);
            return { opened: document.querySelector('#projectStrategyDialog')?.open === true };
          })()`);
        }
        if (captureScenario === "providerinvalid") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const badge = document.querySelector('#bridgeBadge b')?.textContent || '';
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option') && badge && !badge.includes('检测中')) break;
              await wait(50);
            }
            document.querySelectorAll('.stage-button').forEach(node => node.classList.toggle('active', node.dataset.stage === 'settings'));
            document.querySelectorAll('.stage-panel').forEach(node => node.classList.toggle('active', node.dataset.panel === 'settings'));
            await wait(180);
            const kind = document.querySelector('#videoProviderKind');
            const base = document.querySelector('#videoBaseUrl');
            kind.value = 'puream-seedance';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            base.value = 'https://puream.cn.attacker.example/v1';
            base.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(80);
            const node = document.querySelector('#videoProviderPolicy');
            node?.scrollIntoView({ block: 'center' });
            await wait(120);
            return { policy: node?.textContent || '', top: node?.getBoundingClientRect().top || 0, scrollTop: document.querySelector('.main-stage')?.scrollTop || 0 };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (captureScenario === "hailuosettings") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option')) break;
              await wait(50);
            }
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            const projectId = document.querySelector('#projectSelect').value;
            await window.dramaSlot.workbench.patchProject(projectId, {
              generation: { engine: 'hailuo-h3', mode: 'keyframe', modeConfirmed: true, shotDuration: 10, aspectRatio: '9:16' }
            });
            document.querySelector('#projectSelect').dispatchEvent(new Event('change', { bubbles: true }));
            await wait(1500);
            document.querySelector('.stage-button[data-stage="settings"]').click();
            await wait(700);
            document.querySelectorAll('.stage-button').forEach(node => node.classList.toggle('active', node.dataset.stage === 'settings'));
            document.querySelectorAll('.stage-panel').forEach(node => node.classList.toggle('active', node.dataset.panel === 'settings'));
            const kind = document.querySelector('#videoProviderKind');
            kind.value = 'puream-hailuo-h3';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            const assign = (selector, value, notify = false) => {
              const node = document.querySelector(selector);
              if (!node) return null;
              node.value = value;
              if (notify) node.dispatchEvent(new Event('change', { bubbles: true }));
              return node;
            };
            assign('#videoBaseUrl', 'https://puream.cn');
            assign('#videoApiKey', '');
            assign('#videoOssAccessKeyId', '');
            assign('#videoOssAccessKeySecret', '');
            assign('#videoOssBucket', '');
            assign('#videoOssEndpoint', '');
            assign('#hailuoApiMode', 'multimodal_to_video', true);
            assign('#hailuoRefImageSize', 'max');
            assign('#hailuoSeed', '20260804');
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            const card = document.querySelector('.video-provider-card');
            const providerField = document.querySelector('#videoProviderKind');
            providerField.scrollIntoView({ block: 'center' });
            await wait(280);
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            document.querySelectorAll('.stage-button').forEach(node => node.classList.toggle('active', node.dataset.stage === 'settings'));
            document.querySelectorAll('.stage-panel').forEach(node => node.classList.toggle('active', node.dataset.panel === 'settings'));
            providerField.scrollIntoView({ block: 'center' });
            await wait(120);
            return {
              project: document.querySelector('#projectSelect option:checked')?.textContent || '',
              engine: document.querySelector('#projectVideoMode')?.textContent || '',
              provider: kind.value,
              policy: document.querySelector('#videoProviderPolicy')?.textContent || '',
              hailuoApiMode: document.querySelector('#hailuoApiMode')?.value || '',
              hailuoApiModeOptionCount: document.querySelectorAll('#hailuoApiMode option').length,
              hailuoVisible: !document.querySelector('#hailuoFields')?.classList.contains('hidden'),
              faceGridButtonCount: document.querySelectorAll('[data-action="apply-grid"]').length,
              providerFieldTop: providerField.getBoundingClientRect().top,
              scrollTop: document.querySelector('.main-stage')?.scrollTop || 0
            };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (captureScenario === "hailuoquick") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.querySelector('#hailuoApiMode')?.value === 'multimodal_to_video' && document.querySelectorAll('.video-slot').length === 3) break;
              await wait(50);
            }
            return {
              provider: document.querySelector('#submitProviderName')?.textContent || '',
              mode: document.querySelector('#hailuoApiMode')?.value || '',
              modeOptionCount: document.querySelectorAll('#hailuoApiMode option').length,
              videoSlotCount: document.querySelectorAll('.video-slot').length,
              modeVisible: !document.querySelector('#hailuoModeField')?.classList.contains('hidden'),
              rule: document.querySelector('#rulePopover')?.textContent || ''
            };
          })()`);
        }
        if (captureScenario === "seedancemesh") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option:checked')?.value) break;
              await wait(50);
            }
            const projectId = document.querySelector('#projectSelect').value;
            await window.dramaSlot.workbench.patchProject(projectId, {
              generation: { engine: 'seedance', mode: 'continuation', modeConfirmed: true, shotDuration: 5, aspectRatio: '9:16' },
              characters: [{ id: 'C01', name: '林桂芬', description: '62岁退休护士，短卷灰发，左眉尾浅疤，深青针织衫', identitySignature: '左眉尾浅疤、短卷灰发、轻微驼背', voiceDescription: '低沉女中音' }]
            });
            document.querySelector('#projectSelect').dispatchEvent(new Event('change', { bubbles: true }));
            await wait(450);
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            document.querySelectorAll('.stage-button').forEach(node => node.classList.toggle('active', node.dataset.stage === 'assets'));
            document.querySelectorAll('.stage-panel').forEach(node => node.classList.toggle('active', node.dataset.panel === 'assets'));
            await wait(250);
            const button = document.querySelector('[data-action="remesh-character"]');
            const gridButton = document.querySelector('[data-action="apply-grid"]');
            return {
              engine: document.querySelector('#projectVideoMode')?.textContent || '',
              meshTag: document.querySelector('.mesh-required-tag')?.textContent || '',
              meshDrawLabel: button?.textContent?.trim() || '',
              meshDrawDisabled: button?.disabled ?? true,
              faceGridButtonCount: document.querySelectorAll('[data-action="apply-grid"]').length,
              faceGridLabel: gridButton?.textContent?.trim() || '',
              faceGridDisabled: gridButton?.disabled ?? true
            };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (captureScenario === "facegrid") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            try {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option:checked')?.value) break;
              await wait(50);
            }
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            document.querySelector('.stage-button[data-stage="assets"]').click();
            await wait(250);
            const projectId = document.querySelector('#projectSelect').value;
            const before = await window.dramaSlot.workbench.getProject(projectId);
            const existingGridIds = new Set((before.project?.candidates || []).filter(item => item.source === 'local-face-grid').map(item => item.id));
            const button = document.querySelector('[data-action="apply-grid"]:not([disabled])');
            if (!button) throw new Error('Seedance 一键检测网格按钮不可用');
            button.click();
            let completed = null;
            for (let attempt = 0; attempt < 300; attempt += 1) {
              const latest = await window.dramaSlot.workbench.getProject(projectId);
              completed = latest.project?.candidates?.find(item => item.source === 'local-face-grid' && !existingGridIds.has(item.id)) || null;
              if (completed) break;
              await wait(100);
            }
            if (!completed) throw new Error(document.querySelector('#toast')?.textContent || '本地网格处理超时');
            await wait(350);
            return {
              projectId,
              beforeGridCount: before.project?.candidates?.filter(item => item.source === 'local-face-grid').length || 0,
              afterGridCount: (await window.dramaSlot.workbench.getProject(projectId)).project?.candidates?.filter(item => item.source === 'local-face-grid').length || 0,
              method: completed.faceMesh?.method || '',
              faceCount: completed.faceMesh?.faceCount || 0,
              sourceCandidateId: completed.faceMesh?.sourceCandidateId || '',
              outputPath: completed.filePath || '',
              sourceActionStillAvailable: Boolean(document.querySelector('[data-action="apply-grid"]:not([disabled])'))
            };
            } catch (error) {
              return { error: error?.stack || error?.message || String(error) };
            }
          })()`);
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (captureScenario === "accessibilitynewproject") {
          await mainWindow.webContents.executeJavaScript(`(async () => {
            document.querySelector('#newProject').click();
            await new Promise(resolve => setTimeout(resolve, 180));
          })()`);
        }
        if (["accessibility", "accessibilitynewproject"].includes(captureScenario)) {
          const axePath = path.resolve(__dirname, "..", "node_modules", "axe-core", "axe.min.js");
          await mainWindow.webContents.executeJavaScript(fs.readFileSync(axePath, "utf8"));
          captureResult = await mainWindow.webContents.executeJavaScript(`axe.run(document, {
            resultTypes: ['violations']
          }).then(result => ({
            url: location.href,
            violations: result.violations.map(item => ({
              id: item.id,
              impact: item.impact,
              description: item.description,
              help: item.help,
              nodes: item.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary }))
            }))
          }))`);
        }
        if (captureScenario === "performance") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(() => {
            const navigation = performance.getEntriesByType('navigation')[0];
            return {
              domContentLoadedMs: Math.round(navigation?.domContentLoadedEventEnd || 0),
              loadEventMs: Math.round(navigation?.loadEventEnd || 0),
              durationMs: Math.round(navigation?.duration || 0),
              resourceCount: performance.getEntriesByType('resource').length,
              domNodeCount: document.querySelectorAll('*').length,
              visibleButtonCount: [...document.querySelectorAll('button')].filter(node => {
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              }).length,
              workbenchReady: document.body.dataset.workbenchReady === 'true'
            };
          })()`);
        }
        if (captureScenario === "keyboard") {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const ready = await mainWindow.webContents.executeJavaScript(`document.body.dataset.workbenchReady === 'true' && Boolean(document.querySelector('#projectSelect option'))`);
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (!mainWindow.webContents.debugger.isAttached()) mainWindow.webContents.debugger.attach("1.3");
          const keyMap = {
            Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
            Return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
            Space: { key: " ", code: "Space", vk: 32, text: " " },
            Escape: { key: "Escape", code: "Escape", vk: 27 },
            Tab: { key: "Tab", code: "Tab", vk: 9 }
          };
          const press = async keyName => {
            const key = keyMap[keyName];
            await mainWindow.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: key.key, code: key.code, text: key.text || "", unmodifiedText: key.text || "", windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk });
            await mainWindow.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk });
            await new Promise(resolve => setTimeout(resolve, 180));
          };
          await mainWindow.webContents.executeJavaScript(`document.querySelector('#newProject').focus()`);
          for (const key of ["Enter", "Return", "Space"]) {
            await press(key);
            if (await mainWindow.webContents.executeJavaScript(`document.querySelector('#newProjectDialog')?.open === true`)) break;
          }
          const projectDialogState = await mainWindow.webContents.executeJavaScript(`({ opened: document.querySelector('#newProjectDialog')?.open === true, activeElement: document.activeElement?.id || document.activeElement?.getAttribute?.('name') || '' })`);
          await press("Escape");
          await mainWindow.webContents.executeJavaScript(`document.querySelector('#editProjectStrategy').focus()`);
          for (const key of ["Enter", "Return", "Space"]) {
            await press(key);
            if (await mainWindow.webContents.executeJavaScript(`document.querySelector('#projectStrategyDialog')?.open === true`)) break;
          }
          const strategyDialogState = await mainWindow.webContents.executeJavaScript(`({ opened: document.querySelector('#projectStrategyDialog')?.open === true, activeElement: document.activeElement?.id || document.activeElement?.getAttribute?.('name') || '' })`);
          await press("Escape");
          await mainWindow.webContents.executeJavaScript(`document.body.focus()`);
          const tabStops = [];
          for (let index = 0; index < 24; index += 1) {
            await press("Tab");
            tabStops.push(await mainWindow.webContents.executeJavaScript(`(() => {
              const node = document.activeElement;
              const rect = node?.getBoundingClientRect?.();
              return {
                tag: node?.tagName || '', id: node?.id || '', text: String(node?.textContent || node?.getAttribute?.('aria-label') || '').trim().slice(0, 40),
                visible: Boolean(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight)
              };
            })()`));
          }
          captureResult = { projectDialogOpened: projectDialogState.opened, projectDialogFocus: projectDialogState.activeElement, strategyDialogOpened: strategyDialogState.opened, strategyDialogFocus: strategyDialogState.activeElement, tabStops };
        }
        if (captureScenario === "buttonaudit") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option')) break;
              await wait(50);
            }
            await wait(500);
            const stageResults = [];
            for (const button of document.querySelectorAll('.stage-button')) {
              button.click();
              await wait(40);
              stageResults.push({
                stage: button.dataset.stage,
                activeButton: button.classList.contains('active'),
                activePanel: Boolean(document.querySelector('.stage-panel.active')?.dataset.panel === button.dataset.stage)
              });
            }
            const libraryResults = [];
            for (const button of document.querySelectorAll('.library-nav-button')) {
              button.click();
              await wait(30);
              libraryResults.push({
                library: button.dataset.library,
                active: button.classList.contains('active'),
                panelVisible: !document.querySelector('#sidebarLibraryPanel')?.classList.contains('hidden'),
                title: document.querySelector('#sidebarLibraryTitle')?.textContent || ''
              });
            }
            document.querySelector('#closeSidebarLibrary')?.click();
            document.querySelector('#newProject')?.click();
            await wait(50);
            const newProjectOpened = document.querySelector('#newProjectDialog')?.open === true;
            document.querySelector('#cancelNewProject')?.click();
            document.querySelector('#editProjectStrategy')?.click();
            await wait(50);
            const strategyOpened = document.querySelector('#projectStrategyDialog')?.open === true;
            document.querySelector('#projectStrategyDialog')?.close();
            document.querySelector('#qualityBlueprintToggle')?.click();
            await wait(30);
            const blueprintOpened = !document.querySelector('#qualityBlueprintMenu')?.classList.contains('hidden');
            document.querySelector('#qualityBlueprintToggle')?.click();
            const firstHelp = document.querySelector('button .info-dot');
            firstHelp?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            await wait(30);
            const tooltipVisible = document.querySelector('#infoTooltipLayer')?.classList.contains('is-visible') === true
              && Boolean(document.querySelector('#infoTooltipLayer')?.textContent?.trim());
            firstHelp?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
            const buttons = [...document.querySelectorAll('button')].map((button, index) => ({
              index,
              id: button.id || '',
              action: button.dataset.action || '',
              label: String(button.innerText || button.textContent || button.getAttribute('aria-label') || '').replace(/!/g, '').replace(/\\s+/g, ' ').trim(),
              disabled: Boolean(button.disabled),
              hasHelp: Boolean(button.querySelector(':scope > .info-dot')),
              tooltip: String(button.dataset.tooltip || button.querySelector(':scope > .info-dot')?.dataset.tooltip || '').trim()
            }));
            return {
              buttonCount: buttons.length,
              buttons,
              missingLabels: buttons.filter(item => !item.label),
              missingHelp: buttons.filter(item => !item.hasHelp || !item.tooltip),
              stageResults,
              libraryResults,
              dialogs: { newProjectOpened, strategyOpened, blueprintOpened },
              tooltipVisible,
              horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
              viewport: { width: innerWidth, height: innerHeight, zoom: ${captureZoom} },
              localComponents: {
                xiangsuPath: ${JSON.stringify(bridge.locateXiangsu() || "")},
                ffmpegPath: ${JSON.stringify(locateFfmpeg() || "")}
              }
            };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        if (captureScenario === "manualentries") {
          const requestedStage = ["script", "assets", "shots", "videos", "final"].includes(String(process.env.DRAMA_SLOT_CAPTURE_STAGE || ""))
            ? String(process.env.DRAMA_SLOT_CAPTURE_STAGE)
            : "assets";
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option')) break;
              await wait(50);
            }
            const expected = {
              script: ['importScriptFile', 'import-prompt-batch', 'download-prompt-suggestions'],
              assets: ['import-prompt-batch', 'download-prompt-suggestions', 'open-independent-library'],
              shots: ['import-prompt-batch', 'download-prompt-suggestions', 'importStoryboardBatch'],
              videos: ['importShotPromptsBatch', 'download-prompt-suggestions', 'importShotVideosBatch'],
              final: ['importFinalVideo']
            };
            const stages = {};
            for (const stage of Object.keys(expected)) {
              document.querySelector('.stage-button[data-stage="' + stage + '"]')?.click();
              await wait(80);
              const panel = document.querySelector('.stage-panel[data-panel="' + stage + '"]');
              const bar = panel?.querySelector('.manual-entry-bar');
              const buttons = [...(bar?.querySelectorAll('button') || [])];
              stages[stage] = {
                visible: Boolean(bar && bar.getBoundingClientRect().width > 0 && bar.getBoundingClientRect().height > 0),
                label: String(bar?.textContent || '').replace(/\\s+/g, ' ').trim(),
                buttons: buttons.map(button => ({ id: button.id || '', action: button.dataset.action || '', label: String(button.textContent || '').replace(/!/g, '').replace(/\\s+/g, ' ').trim(), disabled: Boolean(button.disabled) })),
                expectedPresent: expected[stage].every(token => buttons.some(button => button.id === token || button.dataset.action === token))
              };
            }
            const target = ${JSON.stringify(requestedStage)};
            document.querySelector('.stage-button[data-stage="' + target + '"]')?.click();
            await wait(180);
            const active = document.querySelector('.stage-panel.active');
            const bar = active?.querySelector('.manual-entry-bar');
            const scroller = document.querySelector('.main-stage');
            if (bar && scroller) {
              const offset = bar.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
              scroller.scrollTop = Math.max(0, offset - 16);
            } else {
              bar?.scrollIntoView({ block: 'start' });
            }
            await wait(120);
            return {
              requestedStage: target,
              activeStage: active?.dataset.panel || '',
              stages,
              manualBarTop: bar?.getBoundingClientRect().top || null,
              horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
              viewport: { width: innerWidth, height: innerHeight, zoom: ${captureZoom} }
            };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        if (captureScenario === "manuallibrary") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option')) break;
              await wait(50);
            }
            document.querySelector('.stage-button[data-stage="assets"]')?.click();
            await wait(120);
            document.querySelector('[data-action="open-independent-library"]')?.click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
              if (document.querySelector('#reusableAssetDialog')?.open) break;
              await wait(50);
            }
            const dialog = document.querySelector('#reusableAssetDialog');
            const uploadButtons = [...document.querySelectorAll('[data-action="import-reusable-library"]')];
            return {
              opened: dialog?.open === true,
              title: document.querySelector('#reusableAssetDialogTitle')?.textContent || '',
              uploadKinds: uploadButtons.map(button => button.dataset.kind),
              uploadLabels: uploadButtons.map(button => String(button.textContent || '').replace(/!/g, '').trim()),
              cardCount: document.querySelectorAll('#reusableAssetGrid .reusable-asset-card').length,
              horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1
            };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (captureScenario === "resumestate") {
          const targetProjectId = String(process.env.DRAMA_SLOT_CAPTURE_PROJECT_ID || "").trim();
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (document.body.dataset.workbenchReady === 'true' && document.querySelector('#projectSelect option')) break;
              await wait(50);
            }
            const select = document.querySelector('#projectSelect');
            const targetProjectId = ${JSON.stringify(targetProjectId)};
            if (targetProjectId && select?.querySelector('option[value="' + CSS.escape(targetProjectId) + '"]')) {
              select.value = targetProjectId;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              await wait(350);
            }
            document.querySelector('.stage-button[data-stage="script"]')?.click();
            await wait(250);
            const resume = document.querySelector('#resumeScriptGeneration');
            const pipeline = document.querySelector('#continueFromScript');
            return {
              projectId: select?.value || '',
              activeStage: document.querySelector('.stage-panel.active')?.dataset.panel || '',
              taskState: document.querySelector('#scriptTaskState')?.textContent?.trim() || '',
              taskMessage: document.querySelector('#scriptTaskMessage')?.textContent?.trim() || '',
              resume: {
                visible: Boolean(resume && !resume.classList.contains('hidden')),
                label: resume?.textContent?.trim() || '',
                disabled: Boolean(resume?.disabled)
              },
              continuePipeline: {
                visible: Boolean(pipeline && !pipeline.classList.contains('hidden')),
                label: pipeline?.textContent?.replace(/!/g, '')?.replace(/\\s+/g, ' ')?.trim() || '',
                disabled: Boolean(pipeline?.disabled),
                tooltip: pipeline?.dataset.tooltip || ''
              },
              scriptReadOnly: Boolean(document.querySelector('#scriptText')?.readOnly),
              scriptLength: String(document.querySelector('#scriptText')?.value || '').length,
              horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1
            };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        if (captureScenario === "localcomponents") {
          const xiangsuPath = bridge.locateXiangsu();
          const ffmpegPath = locateFfmpeg();
          captureResult = {
            xiangsuPath,
            xiangsuExists: Boolean(xiangsuPath && fs.existsSync(xiangsuPath)),
            ffmpegPath,
            ffmpegExists: Boolean(ffmpegPath && fs.existsSync(ffmpegPath))
          };
        }
        if (captureScenario === "scriptwriting") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const badge = document.querySelector('#bridgeBadge b')?.textContent || '';
              if (document.querySelector('#projectSelect option') && badge && !badge.includes('检测中')) break;
              await wait(50);
            }
            await wait(1200);
            const panel = document.querySelector('#scriptTaskPanel');
            panel.className = 'script-task-panel running';
            document.querySelector('#scriptTaskState').textContent = '正在写作';
            document.querySelector('#scriptTaskMessage').textContent = '正在写第 2/3 批生成单元';
            document.querySelector('#scriptTaskMeta').textContent = '已同步 6842 字 · 最近自动保存 20:58:36 · 暂停或停止都不会清空当前文字';
            document.querySelector('#pauseScriptGeneration').classList.remove('hidden');
            document.querySelector('#resumeScriptGeneration').classList.add('hidden');
            document.querySelector('#stopScriptGeneration').classList.remove('hidden');
            const editor = document.querySelector('#scriptText');
            editor.readOnly = true;
            editor.value = '# 纯梦短剧老虎机实时写作草稿\\n\\n## 1. 项目参数\\n- 当前正在生成：第二批正式生成单元\\n\\n## 6. 完整生成单元剧本\\n\\n### S11｜01:40–01:50｜10秒\\n- 本单元叙事任务：母亲拿出被藏起来的旧单据，儿子第一次意识到自己错怪了她。\\n- 对白：母亲：你说我贪你的钱，那这张替你还债的收据，为什么一直压在抽屉最底下？\\n儿子：这不可能……那天明明是她告诉我的。';
            document.querySelector('#scriptCount').textContent = editor.value.length + ' 字';
            return { panelClass: panel.className, readOnly: editor.readOnly, pauseVisible: !document.querySelector('#pauseScriptGeneration').classList.contains('hidden'), stopVisible: !document.querySelector('#stopScriptGeneration').classList.contains('hidden') };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (captureScenario === "assetviewer") {
          await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const button = document.querySelector('.stage-panel.active .asset-open-button:not([disabled]), .stage-panel.active [data-action="open-asset"]:not([disabled])');
            if (!button) throw new Error('当前阶段没有可打开的资产');
            button.click();
            await wait(120);
            const dialog = document.querySelector('#assetViewerDialog');
            if (!dialog?.open) throw new Error('资产预览窗口未打开');
            return { opened: true, title: document.querySelector('#assetViewerTitle')?.textContent || '' };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (captureScenario === "assetlibrary") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            await wait(1400);
            let button = null;
            for (let attempt = 0; attempt < 80; attempt += 1) {
              button = document.querySelector('.stage-panel.active [data-action="focus-candidates"]');
              if (button) break;
              await wait(50);
            }
            if (!button) throw new Error('当前阶段未找到独立资产库入口');
            const entityType = button.dataset.entityType || '';
            const entityId = button.dataset.id || '';
            button.click();
            await wait(650);
            const cards = [...document.querySelectorAll('#candidateHistory .candidate-card')];
            const scopeTitle = document.querySelector('#candidateLibraryScope b')?.textContent || '';
            return {
              entityType,
              entityId,
              scopeTitle,
              candidateCount: cards.length,
              allCardsMatchScope: cards.every(card => card.dataset.entityType === entityType && card.dataset.entityId === entityId),
              ownerLabels: [...new Set(cards.map(card => card.querySelector('.candidate-owner b')?.textContent || '').filter(Boolean))]
            };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (captureScenario === "videoplayback") {
          captureResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            let video = null;
            for (let attempt = 0; attempt < 80; attempt += 1) {
              video = document.querySelector('#videoGrid .video-card video.video-preview');
              if (video) break;
              await wait(50);
            }
            if (!video) throw new Error('分镜视频播放验收未找到可播放视频');
            const card = video.closest('[data-shot-id]');
            const shotId = card?.dataset.shotId || '';
            video.muted = true;
            video.loop = true;
            await video.play();
            const startedAt = video.currentTime;
            let mutationCount = 0;
            const observer = new MutationObserver(records => { mutationCount += records.length; });
            observer.observe(document.querySelector('.app'), { childList: true, subtree: true, attributes: true, characterData: true });
            await wait(9200);
            observer.disconnect();
            const current = [...document.querySelectorAll('#videoGrid .video-card[data-shot-id]')]
              .find(node => node.dataset.shotId === shotId)?.querySelector('video.video-preview') || null;
            return {
              shotId,
              sameNode: current === video,
              startedAt,
              currentTime: current?.currentTime || 0,
              paused: current?.paused ?? true,
              ended: current?.ended ?? true,
              readyState: current?.readyState || 0,
              mutationCount
            };
          })()`);
        }
        if (captureScenario === "hailuosettings") {
          await mainWindow.webContents.executeJavaScript(`(() => {
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            document.querySelectorAll('.stage-button').forEach(node => node.classList.toggle('active', node.dataset.stage === 'settings'));
            document.querySelectorAll('.stage-panel').forEach(node => {
              const active = node.dataset.panel === 'settings';
              node.classList.toggle('active', active);
              node.style.setProperty('display', active ? 'block' : 'none', 'important');
            });
            const kind = document.querySelector('#videoProviderKind');
            if (kind) {
              kind.value = 'puream-hailuo-h3';
              kind.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const card = document.querySelector('.video-provider-card');
            document.querySelectorAll('.settings-grid > .settings-card').forEach(node => {
              node.style.setProperty('display', node === card ? 'block' : 'none', 'important');
            });
            document.querySelector('.settings-grid')?.prepend(card);
            const stage = document.querySelector('.main-stage');
            if (stage && card) stage.scrollTop = Math.max(0, card.offsetTop - 96);
          })()`);
          await new Promise(resolve => setTimeout(resolve, 240));
          await mainWindow.webContents.executeJavaScript(`(() => {
            document.querySelectorAll('.stage-panel').forEach(node => {
              const active = node.dataset.panel === 'settings';
              node.classList.toggle('active', active);
              node.style.setProperty('display', active ? 'block' : 'none', 'important');
            });
            const card = document.querySelector('.video-provider-card');
            document.querySelectorAll('.settings-grid > .settings-card').forEach(node => {
              node.style.setProperty('display', node === card ? 'block' : 'none', 'important');
            });
            const stage = document.querySelector('.main-stage');
            if (stage && card) stage.scrollTop = Math.max(0, card.offsetTop - 96);
          })()`);
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        if (captureResultPath && captureResult) {
          fs.mkdirSync(path.dirname(captureResultPath), { recursive: true });
          fs.writeFileSync(captureResultPath, JSON.stringify(captureResult, null, 2));
        }
        const image = await mainWindow.webContents.capturePage();
        fs.mkdirSync(path.dirname(capturePath), { recursive: true });
        fs.writeFileSync(capturePath, image.toPNG());
        app.quit();
      }, 1200);
    });
  } else {
    mainWindow.once("ready-to-show", () => mainWindow.show());
  }
}

const { locateFfmpeg: locateBundledFfmpeg } = require("./locate-ffmpeg");

function locateFfmpeg() {
  // Prefer the ffmpeg shipped with this product. Sibling apps are last-resort only.
  let xiangsuPath = "";
  try { xiangsuPath = bridge.locateXiangsu() || ""; } catch {}
  return locateBundledFfmpeg({ xiangsuPath });
}

function readAvMetadata(filePath) {
  const ffmpeg = locateFfmpeg();
  if (!ffmpeg) {
    return Promise.reject(Object.assign(new Error("媒体检测组件不可用，无法确认文件是否可播放"), { code: "MEDIA_PROBE_UNAVAILABLE" }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(ffmpeg, ["-hide_banner", "-i", filePath], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let output = "";
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = finish(reject);
    const succeed = finish(resolve);
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      fail(Object.assign(new Error("媒体检测超时，请检查文件是否损坏"), { code: "MEDIA_PROBE_TIMEOUT" }));
    }, AV_PROBE_TIMEOUT_MS);
    child.stderr.on("data", chunk => {
      if (output.length < 256_000) output += chunk.toString("utf8");
    });
    child.on("error", error => fail(Object.assign(error, { code: error?.code || "MEDIA_PROBE_FAILED" })));
    child.on("close", () => {
      const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      const videoMatch = output.match(/Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
      const duration = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : null;
      succeed({
        duration: Number.isFinite(duration) ? duration : null,
        width: videoMatch ? Number(videoMatch[1]) : null,
        height: videoMatch ? Number(videoMatch[2]) : null
      });
    });
  });
}

async function describeMedia(filePath, type) {
  const rule = MEDIA_RULES[type];
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!rule || !rule.extensions.includes(extension)) {
    const error = new Error(`${type === "image" ? "图片" : type === "video" ? "视频" : "音频"}格式不受支持`);
    error.code = "UNSUPPORTED_MEDIA_FORMAT";
    throw error;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw Object.assign(new Error("所选媒体为空或不是普通文件"), { code: "MEDIA_FILE_INVALID" });
  }
  if (stat.size > rule.maxBytes) {
    throw Object.assign(new Error(`${type === "image" ? "图片" : type === "video" ? "视频" : "音频"}超过允许大小`), { code: "MEDIA_FILE_TOO_LARGE" });
  }
  const metadata = type === "image"
    ? (() => {
        const image = nativeImage.createFromPath(filePath);
        if (image.isEmpty()) throw Object.assign(new Error("图片无法解码，请重新导出后上传"), { code: "IMAGE_DECODE_FAILED" });
        const size = image.getSize();
        if (!size.width || !size.height) throw Object.assign(new Error("图片尺寸无效"), { code: "IMAGE_DIMENSIONS_INVALID" });
        return { duration: null, width: size.width, height: size.height };
      })()
    : await readAvMetadata(filePath);
  if (type === "video" && (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || !metadata.width || !metadata.height)) {
    throw Object.assign(new Error("视频无法完整解码或缺少有效画面"), { code: "VIDEO_DECODE_FAILED" });
  }
  if (type === "audio" && (!Number.isFinite(metadata.duration) || metadata.duration <= 0)) {
    throw Object.assign(new Error("音频无法完整解码或没有有效时长"), { code: "AUDIO_DECODE_FAILED" });
  }
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    path: filePath,
    fileUrl: pathToFileURL(filePath).href,
    name: path.basename(filePath),
    extension,
    size: stat.size,
    ...metadata
  };
}

const MANUAL_IMAGE_STAGES = new Set(["character_sheet", "character_three_view", "character_intro", "scene_asset", "storyboard_start", "storyboard_end", "storyboard_sheet", "wardrobe_asset", "prop_asset"]);
const MANUAL_VIDEO_STAGES = new Set(["character_video", "shot_video"]);
const MANUAL_AUDIO_STAGES = new Set(["character_voice"]);

function manualStageMediaType(stage) {
  if (MANUAL_IMAGE_STAGES.has(stage)) return "image";
  if (MANUAL_VIDEO_STAGES.has(stage)) return "video";
  if (MANUAL_AUDIO_STAGES.has(stage)) return "audio";
  return "";
}

function manualAssetCategory(entityType, mediaType) {
  if (mediaType === "image") {
    if (entityType === "character" || entityType === "library") return "characters";
    if (entityType === "scene") return "scenes";
    return "storyboards";
  }
  return mediaType === "video" ? "videos" : "audio";
}

async function importCandidateFromPath(projectId, entityType, entityId, stage, sourcePath, source = "manual-upload", reusableAssetId = "") {
  const mediaType = manualStageMediaType(stage);
  if (!mediaType || !["character", "scene", "shot", "library"].includes(entityType)) {
    throw Object.assign(new Error("手动资产类型无效"), { code: "IMPORT_STAGE_INVALID" });
  }
  const { store, workflow } = requireWorkbench();
  const described = await describeMedia(sourcePath, mediaType);
  if (stage === "shot_video" && Number(described.duration) > 15.05) {
    throw Object.assign(new Error("分镜视频时长不能超过 15 秒"), { code: "VIDEO_DURATION_INVALID" });
  }
  if (stage === "character_voice" && Number(described.duration) > 15.05) {
    throw Object.assign(new Error("单个音色参考不能超过 15 秒"), { code: "AUDIO_DURATION_INVALID" });
  }
  const imported = workflow.importAsset(projectId, manualAssetCategory(entityType, mediaType), sourcePath, `${stage}-manual`);
  let candidate = store.addCandidate(projectId, {
    entityType,
    entityId,
    stage,
    prompt: source === "reusable-asset-library" ? "从独立资产库绑定" : "手动上传资产",
    filePath: imported.path,
    fileUrl: imported.fileUrl,
    duration: described.duration,
    width: described.width,
    height: described.height,
    source,
    reusableAssetId: reusableAssetId || undefined,
    mediaProbeVerified: true,
    qualityAudit: MANUAL_VIDEO_STAGES.has(stage)
      ? { ok: true, mode: "manual", skipped: true, checkedAt: new Date().toISOString() }
      : undefined,
    faceMesh: entityType === "character" && ["character_sheet", "character_three_view", "character_intro"].includes(stage)
      ? { required: projectRequiresFaceMesh(store.getProject(projectId), store.getSettings()), applied: false, method: "manual-awaiting-local-grid" }
      : undefined
  });
  // 手动导入绝不偷偷触发付费生图；需要全脸网格时由用户在候选库点“本地添加全脸网格”。
  if (["storyboard_start", "storyboard_end", "storyboard_sheet"].includes(stage)) {
    await workflow.auditStoryboardCandidate(projectId, entityId, candidate.id);
    candidate = store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
  }
  if (candidate.qualityAudit?.ok !== false) {
    candidate = store.confirmCandidate(projectId, candidate.id, false);
  }
  let libraryWarning = "";
  if (entityType === "character" && stage === "character_voice") {
    try {
      workflow.depositCharacterVoiceToLibrary(projectId, entityId, candidate);
      candidate = store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    } catch (error) {
      libraryWarning = sanitizePublicMessage(error?.message || "音色已保存到项目，但自动加入独立音色库失败");
      store.addActivity(projectId, "asset_library_warning", `音色已保存到项目；独立音色库入库失败：${libraryWarning}`);
    }
  }
  return { candidate, described, warning: libraryWarning };
}

async function importProductFromPath(projectId, sourcePath, source = "manual-upload", reusableAssetId = "") {
  const { store, workflow } = requireWorkbench();
  await describeMedia(sourcePath, "image");
  const imported = workflow.importAsset(projectId, "product", sourcePath, "product-manual");
  const project = store.replaceProductAsset(projectId, {
    imagePath: imported.path,
    publicUrl: "",
    source,
    reusableAssetId: reusableAssetId || ""
  });
  return { asset: imported, project: store.getProject(projectId) };
}

async function importFinalVideoFromPath(projectId, sourcePath, source = "manual-upload", reusableAssetId = "") {
  const { store, workflow } = requireWorkbench();
  const described = await describeMedia(sourcePath, "video");
  const imported = workflow.importAsset(projectId, "final", sourcePath, "final-manual");
  const project = store.getProject(projectId);
  project.finalVideoHistory = Array.isArray(project.finalVideoHistory) ? project.finalVideoHistory : [];
  if (project.finalVideoPath && project.finalVideoPath !== imported.path) {
    project.finalVideoHistory.unshift({
      id: `final-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      filePath: project.finalVideoPath,
      source: project.finalVideoSource || "previous",
      replacedAt: new Date().toISOString(),
      stale: project.finalVideoStale === true,
      staleReason: project.finalVideoStaleReason || ""
    });
    project.finalVideoHistory = project.finalVideoHistory.slice(0, 50);
  }
  project.finalVideoPath = imported.path;
  project.finalVideoStale = false;
  project.finalVideoSelected = true;
  project.finalVideoSource = source;
  project.finalVideoReusableAssetId = reusableAssetId || "";
  project.finalVideoStaleReason = "";
  project.mediaQualityAudit = null;
  project.finalQualityAudit = {
    ok: null,
    mode: "manual",
    skipped: true,
    checkedAt: new Date().toISOString(),
    message: "用户手动上传完整成片；尚未运行自动媒体终审"
  };
  store.saveProject(project);
  return { asset: imported, described, project: store.getProject(projectId) };
}

function shotNumberFromFile(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  const explicit = name.match(/(?:^|[^a-z0-9])(?:shot|s|镜头)[-_ ]*0*(\d{1,4})(?:[^0-9]|$)/i);
  if (explicit) return Number(explicit[1]);
  const leading = name.match(/^0*(\d{1,4})(?:[^0-9]|$)/);
  return leading ? Number(leading[1]) : null;
}

function storyboardStageFromFile(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  if (/(?:^|[-_ .])(sheet|board|contact|合图|分镜板)(?:[-_ .]|$)/i.test(name)) return "storyboard_sheet";
  if (/(?:^|[-_ .])(start|first|首帧|起始)(?:[-_ .]|$)/i.test(name)) return "storyboard_start";
  if (/(?:^|[-_ .])(end|last|尾帧|结束)(?:[-_ .]|$)/i.test(name)) return "storyboard_end";
  return "";
}

function storyboardSlots(project) {
  const shots = (project.shots || []).slice().sort((left, right) => Number(left.number) - Number(right.number));
  const mode = project.generation?.mode || "continuation";
  if (mode === "storyboard_sheet") return shots.map(shot => ({ shot, stage: "storyboard_sheet" }));
  if (mode === "continuation") return shots.flatMap((shot, index) => index === 0
    ? [{ shot, stage: "storyboard_start" }, { shot, stage: "storyboard_end" }]
    : [{ shot, stage: "storyboard_end" }]);
  return shots.flatMap(shot => [{ shot, stage: "storyboard_start" }, { shot, stage: "storyboard_end" }]);
}

function planBatchMedia(project, filePaths, kind) {
  const shots = (project.shots || []).slice().sort((left, right) => Number(left.number) - Number(right.number));
  const shotByNumber = new Map(shots.map(shot => [Number(shot.number), shot]));
  const sortedPaths = filePaths.slice().sort((left, right) => path.basename(left).localeCompare(path.basename(right), "zh-CN", { numeric: true }));
  if (kind === "video") {
    const explicit = sortedPaths.map(filePath => ({ filePath, shot: shotByNumber.get(shotNumberFromFile(filePath)) })).filter(item => item.shot);
    if (explicit.length === sortedPaths.length) return explicit.map(item => ({ ...item, stage: "shot_video" }));
    if (sortedPaths.length === shots.length) return sortedPaths.map((filePath, index) => ({ filePath, shot: shots[index], stage: "shot_video" }));
    return [];
  }
  const explicit = sortedPaths.map(filePath => {
    const shot = shotByNumber.get(shotNumberFromFile(filePath));
    let stage = storyboardStageFromFile(filePath);
    if (!stage && project.generation?.mode === "storyboard_sheet") stage = "storyboard_sheet";
    return { filePath, shot, stage };
  }).filter(item => item.shot && item.stage);
  if (explicit.length === sortedPaths.length) return explicit;
  const slots = storyboardSlots(project);
  if (sortedPaths.length === slots.length) return sortedPaths.map((filePath, index) => ({ filePath, ...slots[index] }));
  return [];
}

function promptRowsFromJson(value) {
  if (Array.isArray(value)) return value.map(item => ({ number: Number(item?.number || item?.shotNumber || String(item?.id || "").replace(/\D/g, "")), prompt: String(item?.prompt || item?.videoPrompt || item?.text || "").trim() }));
  if (value && typeof value === "object") {
    const nested = Array.isArray(value.shots) ? promptRowsFromJson(value.shots) : [];
    const keyed = Object.entries(value).map(([key, prompt]) => ({ number: Number(String(key).replace(/\D/g, "")), prompt: typeof prompt === "string" ? prompt.trim() : String(prompt?.prompt || prompt?.videoPrompt || "").trim() }));
    return [...nested, ...keyed];
  }
  return [];
}

function planBatchPrompts(project, filePaths) {
  const shots = (project.shots || []).slice().sort((left, right) => Number(left.number) - Number(right.number));
  const shotByNumber = new Map(shots.map(shot => [Number(shot.number), shot]));
  const rows = [];
  for (const filePath of filePaths) {
    const text = readBoundedTextFile(filePath, PROMPT_IMPORT_MAX_CHARS).trim();
    if (!text) continue;
    if (path.extname(filePath).toLowerCase() === ".json") {
      try {
        for (const row of promptRowsFromJson(JSON.parse(text))) {
          const shot = shotByNumber.get(row.number);
          if (shot && row.prompt) rows.push({ shot, prompt: row.prompt, filePath });
        }
        continue;
      } catch {}
    }
    const shot = shotByNumber.get(shotNumberFromFile(filePath));
    if (shot) rows.push({ shot, prompt: text, filePath });
  }
  if (rows.length) return rows;
  const sortedPaths = filePaths.slice().sort((left, right) => path.basename(left).localeCompare(path.basename(right), "zh-CN", { numeric: true }));
  if (sortedPaths.length === shots.length) return sortedPaths.map((filePath, index) => ({ shot: shots[index], prompt: readBoundedTextFile(filePath, PROMPT_IMPORT_MAX_CHARS).trim(), filePath })).filter(item => item.prompt);
  return [];
}

function promptStageFromFile(filePath, scope, project = {}) {
  const name = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const rules = [
    [/character[_\- ]?(?:sheet|board)|人物(?:合板|设定)/i, "character_sheet"],
    [/character[_\- ]?(?:three[_\- ]?view|threeview)|人物三视图/i, "character_three_view"],
    [/character[_\- ]?(?:intro|portrait)|人物(?:介绍|肖像)/i, "character_intro"],
    [/character[_\- ]?video|人物视频/i, "character_video"],
    [/wardrobe|服装/i, "wardrobe_asset"],
    [/prop|道具/i, "prop_asset"],
    [/scene|场景/i, "scene_asset"],
    [/storyboard[_\- ]?(?:start|first)|首帧|起始帧/i, "storyboard_start"],
    [/storyboard[_\- ]?(?:end|last)|尾帧|结束帧/i, "storyboard_end"],
    [/storyboard[_\- ]?(?:sheet|board)|分镜合图|逐秒合图/i, "storyboard_sheet"],
    [/shot[_\- ]?video|video[_\- ]?prompt|视频提示词/i, "shot_video"],
    [/topic|选题/i, "topic_ideation"],
    [/story[_\- ]?bible|故事圣经/i, "story_bible"],
    [/shot[_\- ]?plan|拆镜计划/i, "shot_plan"],
    [/(?:^|[_\- ])units?(?:$|[_\- ])|生成单元/i, "units"],
    [/script[_\- ]?analysis|剧本拆解/i, "script_analysis"],
    [/semantic[_\- ]?review|语义终审/i, "semantic_review"],
    [/script|剧本提示词/i, "script"]
  ];
  for (const [pattern, stage] of rules) if (pattern.test(name)) return stage;
  if (scope === "script") return "script";
  if (scope === "videos") return "shot_video";
  if (scope === "storyboards") return project.generation?.mode === "storyboard_sheet" ? "storyboard_sheet" : "storyboard_start";
  return "";
}

function promptTargetFromFile(filePath, stage = "") {
  const name = path.basename(filePath, path.extname(filePath));
  const scene = name.match(/(?:^|[^a-z0-9])SC[-_ ]*0*(\d{1,4})(?:[^0-9]|$)/i);
  if (scene) return `SC${String(Number(scene[1])).padStart(2, "0")}`;
  const character = name.match(/(?:^|[^a-z0-9])C[-_ ]*0*(\d{1,4})(?:[^0-9]|$)/i);
  if (character) return `C${String(Number(character[1])).padStart(2, "0")}`;
  const shot = name.match(/(?:^|[^a-z0-9])(?:SHOT|S|镜头)[-_ ]*0*(\d{1,4})(?:[^0-9]|$)/i);
  if (shot) return `S${String(Number(shot[1])).padStart(2, "0")}`;
  if (["script", "topic_ideation", "story_bible", "shot_plan", "units", "script_analysis", "semantic_review"].includes(stage)) return "project";
  return "project";
}

function defaultPromptStageForScope(scope, project = {}) {
  if (scope === "script") return "script";
  if (scope === "videos") return "shot_video";
  if (scope === "storyboards") return project.generation?.mode === "storyboard_sheet" ? "storyboard_sheet" : "storyboard_start";
  return "";
}

function promptEntriesFromJson(value, options = {}) {
  const sourceFile = String(options.sourceFile || "");
  const scope = String(options.scope || "all");
  const defaultStage = normalizePromptStage(options.defaultStage || defaultPromptStageForScope(scope, options.project));
  const result = [];
  const add = (item, fallback = {}) => {
    const normalized = normalizePromptEntry({
      ...(typeof item === "string" ? { prompt: item } : item || {}),
      stage: item?.stage || fallback.stage || defaultStage,
      target: item?.target || item?.targetId || item?.entityId || fallback.target || "project",
      sourceFile,
      importedAt: new Date().toISOString()
    }, result.length);
    if (normalized) result.push(normalized);
  };
  const walk = (node, fallback = {}) => {
    if (typeof node === "string") return add(node, fallback);
    if (Array.isArray(node)) return node.forEach(item => walk(item, fallback));
    if (!node || typeof node !== "object") return;
    if (node.prompt || node.text || node.content || node.instruction) return add(node, fallback);
    if (Array.isArray(node.prompts)) node.prompts.forEach(item => walk(item, fallback));
    for (const scopeName of ["script", "assets", "storyboards", "videos"]) {
      if (node[scopeName] !== undefined) walk(node[scopeName], { ...fallback, stage: defaultPromptStageForScope(scopeName, options.project) });
    }
    for (const [key, child] of Object.entries(node)) {
      if (["version", "scope", "instructions", "prompts", "script", "assets", "storyboards", "videos"].includes(key)) continue;
      const stage = normalizePromptStage(key);
      if (stage) {
        if (typeof child === "string") add(child, { stage, target: "project" });
        else if (Array.isArray(child)) child.forEach(item => walk(item, { stage }));
        else if (child && typeof child === "object") {
          for (const [target, prompt] of Object.entries(child)) walk(prompt, { stage, target });
        }
        continue;
      }
      if (typeof child === "string" || (child && typeof child === "object" && (child.prompt || child.text))) {
        walk(child, { ...fallback, target: key, stage: fallback.stage || defaultStage });
      }
    }
  };
  walk(value);
  return result;
}

function parsePromptIntakeFiles(project, filePaths, scope = "all") {
  const normalizedScope = PROMPT_SCOPE_STAGES[scope] ? scope : "all";
  const entries = [];
  for (const filePath of filePaths || []) {
    const text = readBoundedTextFile(filePath, PROMPT_IMPORT_MAX_CHARS).trim();
    if (!text) continue;
    if (path.extname(filePath).toLowerCase() === ".json") {
      try {
        entries.push(...promptEntriesFromJson(JSON.parse(text), { sourceFile: path.basename(filePath), scope: normalizedScope, project }));
        continue;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw Object.assign(new Error(`${path.basename(filePath)} 不是有效 JSON；可改用 TXT，或下载系统建议模板后填写`), { code: "PROMPT_BATCH_JSON_INVALID" });
        }
        throw error;
      }
    }
    const stage = promptStageFromFile(filePath, normalizedScope, project);
    if (!stage) {
      throw Object.assign(new Error(`${path.basename(filePath)} 无法判断提示词阶段；资产提示词请在文件名写 character_sheet、scene、wardrobe 或 prop，或使用系统建议 JSON 模板`), { code: "PROMPT_BATCH_STAGE_REQUIRED" });
    }
    const entry = normalizePromptEntry({
      stage,
      target: promptTargetFromFile(filePath, stage),
      prompt: text,
      sourceFile: path.basename(filePath),
      importedAt: new Date().toISOString()
    }, entries.length);
    if (entry) entries.push(entry);
  }
  const allowed = new Set(PROMPT_SCOPE_STAGES[normalizedScope]);
  return entries.filter(entry => allowed.has(entry.stage));
}

async function importPromptBatch(projectId, scope = "all") {
  const normalizedScope = PROMPT_SCOPE_STAGES[scope] ? scope : "all";
  const titles = { script: "批量上传剧本流程提示词", assets: "批量上传资产提示词", storyboards: "批量上传分镜图提示词", videos: "批量上传视频提示词", all: "批量上传全流程提示词" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: titles[normalizedScope],
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "提示词文件", extensions: ["txt", "md", "markdown", "json"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  if (result.canceled) return { ok: true, canceled: true };
  const { store } = requireWorkbench();
  const project = store.getProject(projectId);
  const entries = parsePromptIntakeFiles(project, result.filePaths, normalizedScope);
  if (!entries.length) {
    throw Object.assign(new Error("没有识别到可用提示词；请下载本阶段系统建议模板，保留 stage、target、prompt 三个字段后再上传"), { code: "PROMPT_BATCH_EMPTY" });
  }
  project.promptIntake = mergePromptIntake(project.promptIntake, entries);
  applyPromptIntakeToMaterializedEntities(project, { overwrite: true, entries });
  project.activity = Array.isArray(project.activity) ? project.activity : [];
  project.activity.unshift({ id: crypto.randomUUID(), type: "prompt_batch_imported", summary: `从零批量上传 ${entries.length} 条${titles[normalizedScope].replace("批量上传", "")}`, createdAt: new Date().toISOString() });
  const updated = store.saveProject(project);
  return { ok: true, imported: entries.length, stages: [...new Set(entries.map(entry => entry.stage))], project: updated };
}

function readBoundedTextFile(filePath, maxChars) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw Object.assign(new Error("文本文件为空或无效"), { code: "TEXT_FILE_INVALID" });
  if (stat.size > TEXT_IMPORT_MAX_BYTES) throw Object.assign(new Error("文本文件超过 2MB，请拆分后上传"), { code: "TEXT_FILE_TOO_LARGE" });
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (text.length > maxChars) throw Object.assign(new Error(`文本内容超过 ${maxChars.toLocaleString("zh-CN")} 字符`), { code: "TEXT_CONTENT_TOO_LONG" });
  return text;
}

ipcMain.handle("bridge:health", () => bridge.health());
ipcMain.handle("bridge:diagnostics", async () => {
  try {
    return await bridge.diagnostics();
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("bridge:start", async () => {
  try {
    const launch = bridge.launchXiangsuBridge();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const health = await bridge.health();
      if (health.ok) return { ...health, launched: true };
    }
    return {
      ok: false,
      code: "BRIDGE_START_TIMEOUT",
      message: "像塑后台已启动，但登录态桥尚未就绪，请确认像塑仍处于登录状态。",
      executable: launch.executable
    };
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("bridge:hide", async () => {
  try {
    const switchState = workbenchStore?.getAccountSwitchState?.();
    if (switchState?.status === "awaiting_login") {
      throw Object.assign(new Error("像塑官方登录窗口正在用于切换账号，完成验证前不会重新隐藏"), { code: "ACCOUNT_LOGIN_WINDOW_ACTIVE" });
    }
    return bridge.hideRunningXiangsuWindows();
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("media:choose", async (_event, request) => {
  try {
    const type = typeof request === "string" ? request : request?.type;
    const single = Boolean(request?.single);
    const rule = MEDIA_RULES[type];
    if (!rule) throw Object.assign(new Error("素材类型无效"), { code: "INVALID_MEDIA_TYPE" });
    const result = await dialog.showOpenDialog(mainWindow, {
      title: type === "image" ? "选择参考图片（最多 9 张）" : type === "video" ? "选择参考视频（最多 3 个）" : single ? "选择视频配套音轨" : "选择独立参考音频（最多 3 段）",
      properties: ["openFile", ...(single ? [] : ["multiSelections"])],
      filters: rule.filters
    });
    if (result.canceled) return { ok: true, items: [] };
    const selected = result.filePaths.slice(0, rule.maxCount);
    return { ok: true, items: await Promise.all(selected.map(filePath => describeMedia(filePath, type))) };
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("file:choose-output", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择视频保存目录",
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("app:defaults", () => {
  const settings = workbenchStore?.getSettings?.() || {};
  const providerKind = settings.videoProvider?.kind || "puream-hailuo-h3";
  const contract = contractFor(providerKind);
  const defaultDuration = Math.max(contract.durationMin, Math.min(contract.durationMax, Number(settings.generation?.shotDuration) || 10));
  return {
    appVersion: app.getVersion(),
    captureMode: Boolean(!app.isPackaged && process.env.DRAMA_SLOT_CAPTURE_PATH),
    isPackaged: Boolean(app.isPackaged),
    outputDir: path.join(app.getPath("videos"), "纯梦短剧老虎机"),
    providerKind,
    providerName: providerDisplayName(providerKind),
    hailuoApiMode: settings.videoProvider?.hailuoApiMode || "auto",
    durationMin: contract.durationMin,
    durationMax: contract.durationMax,
    rules: {
      image: { min: 0, max: contract.imageMax },
      video: { min: 0, max: contract.videoMax, maxDuration: providerKind === "local-xiangsu" ? 10 : null, recommendedMinDuration: providerKind === "puream-hailuo-h3" ? 2 : null, recommendedMaxDuration: providerKind === "puream-hailuo-h3" ? 15 : null },
      audio: { min: 0, max: contract.audioMax, maxDuration: providerKind === "local-xiangsu" ? 15 : null },
      pairedAudio: { max: contract.pairedAudioMax || 0 },
      duration: { min: contract.durationMin, max: contract.durationMax, default: defaultDuration },
      ratios: ["9:16", "16:9", "4:3", "1:1", "3:4", "21:9"]
    }
  };
});
ipcMain.handle("video:submit", async (_event, payload) => {
  let staged;
  let lease;
  let leaseTaskId = "";
  try {
    workbenchStore?.assertVideoSubmissionsAllowed?.();
    staged = stageSubmissionMedia({
      ...payload,
      providerKind: bridge.config.kind,
      hailuoApiMode: bridge.config.kind === "puream-hailuo-h3" ? (payload?.hailuoApiMode || bridge.config.hailuoApiMode || "auto") : "",
      outputDir: payload?.outputDir || path.join(app.getPath("videos"), "纯梦短剧老虎机")
    }, path.join(process.env.LOCALAPPDATA || app.getPath("temp"), "PureamDramaSlot", "staging"));
    leaseTaskId = `video:legacy:${String(staged.payload?.clientRequestId || crypto.createHash("sha256")
      .update(JSON.stringify({ prompt: staged.payload?.prompt || "", duration: staged.payload?.duration || 0 }))
      .digest("hex").slice(0, 32))}`;
    if (!licenseBypassAllowed()) {
      lease = await dramaLicense.acquireLease("video", leaseTaskId, {
        entry: "legacy-video-submit",
        providerKind: bridge.config.kind || ""
      });
    }
    return await bridge.submit(staged.payload);
  } catch (error) {
    return publicError(error);
  } finally {
    if (lease && !licenseBypassAllowed()) {
      await dramaLicense.releaseLease(lease.leaseId, leaseTaskId);
    }
    if (staged?.requestDir) fs.rmSync(staged.requestDir, { recursive: true, force: true });
  }
});
ipcMain.handle("video:query", async (_event, taskId) => {
  try {
    const result = await bridge.query(taskId);
    if (result.localPath) result.fileUrl = pathToFileURL(result.localPath).href;
    return result;
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("file:reveal", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || !targetPath || !path.isAbsolute(targetPath)) return false;
  shell.showItemInFolder(targetPath);
  return true;
});

function requireWorkbench() {
  if (!workbenchStore || !workbenchWorkflow) throw Object.assign(new Error("漫剧工作台尚未初始化"), { code: "WORKBENCH_NOT_READY" });
  return { store: workbenchStore, workflow: workbenchWorkflow };
}

function publicPendingJobs(records) {
  return (records || []).map(item => ({
    projectId: item.projectId,
    projectTitle: item.projectTitle,
    jobId: item.jobId,
    taskId: item.taskId,
    type: item.type,
    entityType: item.entityType,
    entityId: item.entityId,
    status: item.status,
    message: sanitizePublicMessage(item.message),
    progress: item.progress,
    progressSource: item.progressSource,
    progressDeterminate: item.progressDeterminate,
    upstreamStatusCode: item.upstreamStatusCode,
    updatedAt: item.updatedAt
  }));
}

async function advanceAccountSwitch(projectId) {
  const { store, workflow } = requireWorkbench();
  const settings = store.getSettings();
  if (settings.videoProvider?.kind !== "local-xiangsu") {
    throw Object.assign(new Error("当前使用正式远程 Seedance API，不需要切换本机像塑账号"), { code: "XIANGSU_ACCOUNT_SWITCH_NOT_APPLICABLE" });
  }
  let state = store.getAccountSwitchState();
  if (state.status === "awaiting_login") {
    const probe = bridge.probeOfficialLoginWindow();
    const lastShownAt = Date.parse(state.loginShownAt || "");
    const recentlyRequested = Number.isFinite(lastShownAt) && Date.now() - lastShownAt < 10_000;
    let recreated = false;
    if (probe.supported && !probe.exists && !recentlyRequested) {
      await bridge.requestOfficialLogin();
      await new Promise(resolve => setTimeout(resolve, 500));
      recreated = true;
    }
    bridge.showXiangsuForOfficialLogin();
    state = store.saveAccountSwitchState({
      status: "awaiting_login",
      videoSubmissionsPaused: true,
      loginShownAt: new Date().toISOString(),
      message: recreated
        ? "原登录窗口已关闭，现已重新创建唯一的像塑官方登录页；扫码或完成手机号验证后会自动检测并续做"
        : "已恢复现有的像塑官方登录页；不会重复创建登录窗口，扫码或完成手机号验证后会自动检测并续做",
      errorCode: ""
    });
    return { ...state, pendingJobs: [] };
  }
  state = store.saveAccountSwitchState({
    status: "draining",
    videoSubmissionsPaused: true,
    requestedByProjectId: projectId || state.requestedByProjectId || "",
    requestedAt: state.requestedAt || new Date().toISOString(),
    message: "正在收拢旧账号已提交任务；暂不接受新视频提交",
    errorCode: ""
  });
  if (!state.previousAccountFingerprint) {
    let previousAccountFingerprint = state.currentAccountFingerprint || "";
    try {
      const session = await bridge.sessionCheck();
      if (session.ok && session.authenticated && session.accountFingerprint) previousAccountFingerprint = session.accountFingerprint;
    } catch (error) {
      store.addActivity(projectId, "product_upload_warning", `商品图已保存到项目；公网素材暂存失败：${sanitizePublicMessage(error?.message || "上传失败")}`);
    }
    if (previousAccountFingerprint) state = store.saveAccountSwitchState({ previousAccountFingerprint });
  }
  workflow.prepareOperationsForAccountSwitch();
  await workflow.reconcileOrphanedVideoJobs();
  const pending = store.listActiveVideoJobs();
  if (pending.length) {
    return store.saveAccountSwitchState({
      status: "draining",
      videoSubmissionsPaused: true,
      pendingJobs: publicPendingJobs(pending),
      message: `还有 ${pending.length} 个旧账号任务正在生成或下载，完成后自动进入官方登录`,
      errorCode: ""
    });
  }
  await bridge.beginOfficialAccountSwitch();
  await new Promise(resolve => setTimeout(resolve, 500));
  bridge.showXiangsuForOfficialLogin();
  return store.saveAccountSwitchState({
    status: "awaiting_login",
    videoSubmissionsPaused: true,
    pendingJobs: [],
    loginShownAt: new Date().toISOString(),
    logoutCompletedAt: new Date().toISOString(),
    message: "原像塑账号已自动退出；当前只需在官方登录页扫码或完成手机号验证，登录成功后会自动检测并续做",
    errorCode: ""
  });
}

ipcMain.handle("workbench:account-switch-status", () => {
  try {
    const { store } = requireWorkbench();
    const state = store.getAccountSwitchState();
    if (state.status === "idle") return { ok: true, state: { ...state, pendingJobs: [] } };
    return { ok: true, state: { ...state, pendingJobs: publicPendingJobs(store.listActiveVideoJobs()) } };
  } catch (error) { return publicError(error); }
});

ipcMain.handle("workbench:sync-video-jobs", async () => {
  if (videoJobSyncRequest) return videoJobSyncRequest;
  videoJobSyncRequest = (async () => {
    try {
      const { store, workflow } = requireWorkbench();
      const active = store.listActiveVideoJobs();
      if (!active.length) return { ok: true, jobs: [] };
      const jobs = await workflow.reconcileOrphanedVideoJobs();
      for (const projectId of new Set(active.map(item => item.projectId))) workflow.reconcileDetachedAutomations(projectId);
      return { ok: true, jobs: publicPendingJobs(jobs) };
    } catch (error) { return publicError(error); }
    finally { videoJobSyncRequest = null; }
  })();
  return videoJobSyncRequest;
});

ipcMain.handle("workbench:begin-account-switch", async (_event, projectId) => {
  if (accountSwitchRequest) return accountSwitchRequest;
  accountSwitchRequest = (async () => {
    try { return { ok: true, state: await advanceAccountSwitch(projectId) }; }
    catch (error) { return publicError(error); }
    finally { accountSwitchRequest = null; }
  })();
  return accountSwitchRequest;
});

ipcMain.handle("workbench:verify-account-switch", async () => {
  try {
    const { store, workflow } = requireWorkbench();
    const state = store.getAccountSwitchState();
    if (state.status !== "awaiting_login") {
      throw Object.assign(new Error("当前没有等待验证的像塑账号切换"), { code: "ACCOUNT_SWITCH_NOT_WAITING" });
    }
    const health = await bridge.health();
    if (!(health.ok && health.ready && health.sessionReady)) {
      const waiting = store.saveAccountSwitchState({
        status: "awaiting_login",
        videoSubmissionsPaused: true,
        message: health.message || "尚未检测到可用的像塑登录态，请在官方窗口完成登录后重试",
        errorCode: health.code || "XIANGSU_SESSION_NOT_READY"
      });
      return { ok: false, code: waiting.errorCode, message: waiting.message, state: waiting };
    }
    const session = await bridge.sessionCheck();
    if (!(session.ok && session.authenticated)) {
      const waiting = store.saveAccountSwitchState({
        status: "awaiting_login",
        videoSubmissionsPaused: true,
        message: session.message || "尚未检测到已登录的像塑官方账号",
        errorCode: session.code || "XIANGSU_LOGIN_REQUIRED"
      });
      return { ok: false, code: waiting.errorCode, message: waiting.message, state: waiting };
    }
    if (state.previousAccountFingerprint && session.accountFingerprint && state.previousAccountFingerprint === session.accountFingerprint) {
      const waiting = store.saveAccountSwitchState({
        status: "awaiting_login",
        videoSubmissionsPaused: true,
        message: "检测到仍是切换前的像塑账号，请在官方窗口退出后登录另一个账号",
        errorCode: "XIANGSU_ACCOUNT_UNCHANGED"
      });
      return { ok: false, code: waiting.errorCode, message: waiting.message, state: waiting };
    }
    bridge.hideRunningXiangsuWindows();
    store.saveAccountSwitchState({
      status: "resuming",
      videoSubmissionsPaused: false,
      verifiedAt: new Date().toISOString(),
      currentAccountFingerprint: session.accountFingerprint || "",
      pendingJobs: [],
      message: "新像塑登录态已通过检测，正在从本地断点恢复生产",
      errorCode: ""
    });
    const resumed = workflow.resumePausedOperations();
    const completed = store.saveAccountSwitchState({
      status: "idle",
      videoSubmissionsPaused: false,
      resumedAt: new Date().toISOString(),
      pendingJobs: [],
      message: resumed.length ? `账号已切换，已恢复 ${resumed.length} 个生产流程` : "账号已切换；本地项目、资产和任务记录保持不变",
      previousAccountFingerprint: "",
      errorCode: ""
    });
    return { ok: true, state: completed, resumed };
  } catch (error) { return publicError(error); }
});

ipcMain.handle("workbench:cancel-account-switch", async () => {
  try {
    const { store } = requireWorkbench();
    bridge.hideRunningXiangsuWindows();
    const state = store.saveAccountSwitchState({
      status: "idle",
      videoSubmissionsPaused: false,
      pendingJobs: [],
      previousAccountFingerprint: "",
      message: "已取消切号并重新隐藏像塑；所有本地项目和历史任务均已保留",
      errorCode: ""
    });
    return { ok: true, state };
  } catch (error) { return publicError(error); }
});

ipcMain.handle("workbench:list-projects", () => {
  try { return { ok: true, projects: requireWorkbench().store.listProjects() }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:create-project", (_event, title, options) => {
  try {
    const { store } = requireWorkbench();
    const project = store.createProject(title, options || {});
    const settings = store.getSettings();
    bridge.configure(settings.videoProvider);
    return { ok: true, project, settings: redactSettingsForRenderer(settings) };
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:delete-project", (_event, projectId) => {
  try {
    const { store, workflow } = requireWorkbench();
    if (workflow.hasActiveOperation(projectId) || store.listActiveVideoJobs(projectId).length > 0) {
      throw Object.assign(new Error("该项目仍有任务运行，结束或等待任务完成后才能删除"), { code: "PROJECT_DELETE_ACTIVE" });
    }
    return { ok: true, result: store.deleteProject(projectId) };
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:list-deleted-projects", () => {
  try { return { ok: true, projects: requireWorkbench().store.listDeletedProjects() }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:restore-project", (_event, archiveId) => {
  try { return { ok: true, project: requireWorkbench().store.restoreProject(archiveId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:get-project", (_event, projectId) => {
  try {
    // Project selection is read-only. A switch must never arbitrate whether a
    // background/recovered task is alive; explicit task sync/resume owns that
    // state transition and has the upstream evidence needed to decide safely.
    return { ok: true, project: requireWorkbench().store.getProject(projectId) };
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:patch-project", (_event, projectId, patch) => {
  try { return { ok: true, project: requireWorkbench().store.patchProject(projectId, patch || {}) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:get-settings", () => {
  try { return { ok: true, settings: redactSettingsForRenderer(requireWorkbench().store.getSettings()) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:save-settings", (_event, settings) => {
  try {
    const store = requireWorkbench().store;
    const saved = store.saveSettings(restoreHiddenPromptDefaults(settings || {}, store.getSettings()));
    bridge.configure(saved.videoProvider);
    return { ok: true, settings: redactSettingsForRenderer(saved) };
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:reset-settings", () => {
  try {
    const { store } = requireWorkbench();
    const settings = store.resetSettings({ preserveSecrets: false });
    bridge.configure(settings.videoProvider);
    return { ok: true, settings: redactSettingsForRenderer(settings) };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:auth-status", () => {
  try {
    const settings = requireWorkbench().store.getSettings();
    const credential = settings.imageProvider?.apiKey
      || settings.digitalHumanProvider?.apiKey
      || settings.textProviderProfiles?.["puream-relay"]?.apiKey
      || (settings.textProvider?.kind === "puream-relay" ? settings.textProvider.apiKey : "")
      || "";
    return {
      ok: true,
      configured: Boolean(credential),
      source: settings.textProvider?.authSource || (credential ? "license-activation" : "missing"),
      masked: credential ? `${credential.slice(0, 2)}••••${credential.slice(-2)}` : ""
    };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("license:status", async () => {
  try {
    if (licenseBypassAllowed()) {
      return { ok: true, activated: true, bypass: true, snapshot: { activated: true, bypass: true, baseUrl: DEFAULT_LICENSE_BASE_URL } };
    }
    const settings = requireWorkbench().store.getSettings();
    const result = await ensurePureamLicenseSession(dramaLicense, settings);
    const live = result.snapshot;
    if (!live.activated) return { ok: true, activated: false, snapshot: live };
    hydratePureamDefaults(requireWorkbench().store, live.activationCode);
    return {
      ok: true,
      activated: true,
      offlineGrace: Boolean(live.offlineGrace),
      snapshot: live,
      recoveredStoredAuthorization: result.recovered
    };
  } catch (error) {
    return {
      ok: false,
      activated: false,
      code: error.code || "LICENSE_ERROR",
      message: sanitizePublicMessage(error.message),
      snapshot: dramaLicense.getSnapshot()
    };
  }
});
ipcMain.handle("license:activate", async (_event, activationCode) => {
  try {
    if (licenseBypassAllowed()) {
      return { ok: true, activated: true, bypass: true, snapshot: { activated: true, bypass: true } };
    }
    const requestedCode = String(activationCode || "").trim()
      || dramaLicense.storedActivationCode()
      || storedWorkbenchAuthorizationCode();
    const snapshot = await dramaLicense.login(requestedCode);
    const hydrated = hydratePureamDefaults(requireWorkbench().store, snapshot.activationCode);
    return { ok: true, activated: true, snapshot, configured: hydrated.configured };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("license:logout", () => {
  try {
    dramaLicense.clearLocalSession(true);
    return { ok: true };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:test-provider", async (_event, kind, config) => {
  try {
    if (kind === "video") {
      const probe = new BridgeClient();
      probe.configure(config);
      return await probe.health();
    }
    return await testProvider(kind, config);
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:choose-product", async (_event, projectId) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择带货商品参考图",
      properties: ["openFile"],
      filters: MEDIA_RULES.image.filters
    });
    if (result.canceled) return { ok: true, canceled: true };
    const { store, workflow } = requireWorkbench();
    const initial = await importProductFromPath(projectId, result.filePaths[0], "manual-upload", "");
    const imported = initial.asset;
    let publicUrl = "";
    let warning = "";
    // Best-effort: cache a public URL so later storyboard/video slots can lock the real packshot.
    try {
      const settings = store.getSettings();
      if (hasOssCredentials(settings.videoProvider || {})) {
        const uploaded = await workflow.resolveHttpsReferenceInputs(settings, [{
          path: imported.path,
          url: "",
          label: "商品参考图",
          entityType: "product",
          sourceStage: "product"
        }]);
        if (uploaded[0]?.url) publicUrl = uploaded[0].url;
      }
    } catch (error) {
      warning = sanitizePublicMessage(error?.message || "商品参考图公网暂存失败");
      store.addActivity(projectId, "asset_library_warning", `商品图已保存到本地；公网暂存失败：${warning}`);
    }
    const saved = store.replaceProductAsset(projectId, {
      imagePath: imported.path,
      publicUrl,
      source: "manual-upload",
      reusableAssetId: ""
    });
    return { ok: true, asset: imported, project: saved, warning };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-text-file", async (_event, kind = "script") => {
  try {
    const isPrompt = kind === "shot_prompt";
    const result = await dialog.showOpenDialog(mainWindow, {
      title: isPrompt ? "上传分镜提示词文件" : "上传剧本文件",
      properties: ["openFile"],
      filters: [
        { name: "文本文件", extensions: ["txt", "md", "markdown", "json", "csv"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
    const filePath = result.filePaths[0];
    const text = readBoundedTextFile(filePath, isPrompt ? PROMPT_IMPORT_MAX_CHARS : SCRIPT_IMPORT_MAX_CHARS);
    return { ok: true, text, fileName: path.basename(filePath), filePath };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-candidate", async (_event, projectId, entityType, entityId, stage) => {
  try {
    const type = manualStageMediaType(stage);
    if (!type || !["character", "scene", "shot", "library"].includes(entityType)) throw Object.assign(new Error("手动资产类型无效"), { code: "IMPORT_STAGE_INVALID" });
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "手动上传候选资产",
      properties: ["openFile"],
      filters: MEDIA_RULES[type].filters
    });
    if (result.canceled) return { ok: true, canceled: true };
    const imported = await importCandidateFromPath(projectId, entityType, entityId, stage, result.filePaths[0]);
    return { ok: true, ...imported, project: requireWorkbench().store.getProject(projectId) };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-batch-media", async (_event, projectId, kind) => {
  try {
    if (!["storyboard", "video"].includes(kind)) throw Object.assign(new Error("批量导入类型无效"), { code: "IMPORT_BATCH_KIND_INVALID" });
    const mediaType = kind === "storyboard" ? "image" : "video";
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === "storyboard" ? "批量上传分镜图" : "批量上传分镜视频",
      properties: ["openFile", "multiSelections"],
      filters: MEDIA_RULES[mediaType].filters
    });
    if (result.canceled) return { ok: true, canceled: true };
    const { store } = requireWorkbench();
    const project = store.getProject(projectId);
    const assignments = planBatchMedia(project, result.filePaths, kind);
    if (!assignments.length) {
      const hint = kind === "storyboard"
        ? "请按 S01-start.png、S01-end.png 或 S01-sheet.png 命名；也可一次选择与当前模式所需槽位数量完全一致的图片。"
        : "请按 S01.mp4、S02.mp4 命名；也可一次选择与分镜数完全一致的视频。";
      throw Object.assign(new Error(`无法把文件对应到分镜。${hint}`), { code: "IMPORT_BATCH_MAPPING_FAILED" });
    }
    const imported = [];
    const failed = [];
    for (const assignment of assignments) {
      try {
        const value = await importCandidateFromPath(projectId, "shot", assignment.shot.id, assignment.stage, assignment.filePath);
        imported.push({ shotId: assignment.shot.id, shotNumber: assignment.shot.number, stage: assignment.stage, fileName: path.basename(assignment.filePath), candidateId: value.candidate.id, selected: value.candidate.selected === true });
      } catch (error) {
        failed.push({ shotId: assignment.shot.id, shotNumber: assignment.shot.number, stage: assignment.stage, fileName: path.basename(assignment.filePath), code: error?.code || "IMPORT_FAILED", message: sanitizePublicMessage(error?.message || "导入失败") });
      }
    }
    return { ok: imported.length > 0, imported, failed, project: store.getProject(projectId), message: imported.length ? "" : (failed[0]?.message || "批量导入失败") };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-prompt-batch", async (_event, projectId, scope = "all") => {
  try { return await importPromptBatch(projectId, scope); }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-shot-prompts", async (_event, projectId) => {
  try { return await importPromptBatch(projectId, "videos"); }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-final-video", async (_event, projectId) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: "上传完整成片", properties: ["openFile"], filters: MEDIA_RULES.video.filters });
    if (result.canceled) return { ok: true, canceled: true };
    return { ok: true, ...(await importFinalVideoFromPath(projectId, result.filePaths[0])) };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-reusable-asset", async (_event, kind) => {
  try {
    const normalizedKind = String(kind || "").trim();
    const mediaType = ["character", "scene", "image"].includes(normalizedKind) ? "image" : normalizedKind;
    if (!["character", "scene", "image", "video", "audio"].includes(normalizedKind)) throw Object.assign(new Error("独立资产类型无效"), { code: "REUSABLE_ASSET_KIND_INVALID" });
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `上传${normalizedKind === "character" ? "人物图" : normalizedKind === "scene" ? "场景图" : mediaType === "image" ? "通用图片" : mediaType === "video" ? "视频" : "音频"}到独立资产库`,
      properties: ["openFile", "multiSelections"],
      filters: MEDIA_RULES[mediaType].filters
    });
    if (result.canceled) return { ok: true, canceled: true };
    const { store } = requireWorkbench();
    const entries = [];
    for (const filePath of result.filePaths) {
      const described = await describeMedia(filePath, mediaType);
      entries.push(store.importReusableAsset(filePath, {
        kind: normalizedKind,
        mediaType,
        label: path.basename(filePath, path.extname(filePath)),
        duration: described.duration,
        width: described.width,
        height: described.height,
        qualityAudit: { ok: true, mode: "manual-probe", checkedAt: new Date().toISOString() }
      }));
    }
    return { ok: true, entries, assets: store.listReusableAssets() };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:delete-reusable-asset", (_event, assetId) => {
  try {
    const { store } = requireWorkbench();
    const removed = store.deleteReusableAsset(assetId);
    return { ok: true, removed, assets: store.listReusableAssets() };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:bind-library-asset", async (_event, projectId, target, assetId) => {
  try {
    const { store } = requireWorkbench();
    const entry = store.readReusableAssetLibrary().find(item => item.id === assetId);
    if (!entry?.filePath || !fs.existsSync(entry.filePath)) throw Object.assign(new Error("所选独立资产不存在或文件已丢失"), { code: "REUSABLE_ASSET_NOT_FOUND" });
    const entityType = String(target?.entityType || "");
    const stage = String(target?.stage || "");
    const mediaType = entry.mediaType || (["character", "scene", "image"].includes(entry.kind) ? "image" : entry.kind);
    const expectedType = entityType === "product" ? "image" : entityType === "final" ? "video" : manualStageMediaType(stage);
    if (!expectedType || mediaType !== expectedType) throw Object.assign(new Error("该独立资产不能用于当前目标"), { code: "REUSABLE_ASSET_KIND_MISMATCH" });
    let payload;
    if (entityType === "product") payload = await importProductFromPath(projectId, entry.filePath, "reusable-asset-library", entry.id);
    else if (entityType === "final") payload = await importFinalVideoFromPath(projectId, entry.filePath, "reusable-asset-library", entry.id);
    else payload = await importCandidateFromPath(projectId, entityType, String(target?.entityId || ""), stage, entry.filePath, "reusable-asset-library", entry.id);
    store.touchReusableAssetUse(entry.id);
    return { ok: true, ...payload, project: store.getProject(projectId) };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:analyze-script", async (_event, projectId) => {
  try { return { ok: true, project: await requireWorkbench().workflow.analyzeScript(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-topics", async (_event, projectId) => {
  try { return { ok: true, project: await requireWorkbench().workflow.generateTopicOptions(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-complete-script", async (_event, projectId) => {
  try { return { ok: true, project: await requireWorkbench().workflow.generateCompleteScript(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:control-script-generation", (_event, projectId, intent) => {
  try { return { ok: true, automation: requireWorkbench().workflow.requestScriptControl(projectId, intent) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:resume-script-generation", async (_event, projectId) => {
  try { return { ok: true, result: await requireWorkbench().workflow.resumeScriptGeneration(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:run-idea-pipeline", async (_event, projectId) => {
  try { return { ok: true, result: await requireWorkbench().workflow.runIdeaToFullPipeline(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:preview-image-prompt", async (_event, projectId, stage, entityId) => {
  try { return { ok: true, preview: redactPromptPreview(requireWorkbench().workflow.previewImagePrompt(projectId, stage, entityId)) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:preview-shot-video-prompt", async (_event, projectId, shotId) => {
  try { return { ok: true, preview: redactPromptPreview(await requireWorkbench().workflow.previewShotVideoPrompt(projectId, shotId)) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:preview-character-video-prompt", async (_event, projectId, characterId) => {
  try { return { ok: true, preview: redactPromptPreview(requireWorkbench().workflow.previewCharacterVideoPrompt(projectId, characterId)) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:refresh-creator-prompts", async (_event, projectId, options) => {
  try { return { ok: true, project: await requireWorkbench().workflow.refreshCreatorPrompts(projectId, options || {}) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-image", async (_event, projectId, stage, entityId, prompt) => {
  try { return { ok: true, candidate: await requireWorkbench().workflow.generateImageCandidate(projectId, stage, entityId, prompt) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:remesh-character-asset", async (_event, projectId, candidateId) => {
  try { return { ok: true, candidate: await requireWorkbench().workflow.remeshCharacterAsset(projectId, candidateId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:apply-face-grid", async (_event, projectId, candidateId) => {
  try { return { ok: true, candidate: await requireWorkbench().workflow.applyFaceGrid(projectId, candidateId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-character-video", async (_event, projectId, characterId, prompt) => {
  try { return { ok: true, candidate: await requireWorkbench().workflow.generateCharacterVideo(projectId, characterId, prompt) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:extract-character-voice", async (_event, projectId, characterId) => {
  try { return { ok: true, candidate: await requireWorkbench().workflow.extractCharacterVoice(projectId, characterId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:list-voice-library", () => {
  try { return { ok: true, voices: requireWorkbench().workflow.listVoiceLibrary() }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:list-reusable-assets", (_event, kind) => {
  try { return { ok: true, assets: requireWorkbench().store.listReusableAssets(kind || "") }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:bind-reusable-asset", (_event, projectId, entityType, entityId, assetId) => {
  try { return { ok: true, candidate: requireWorkbench().store.bindReusableAsset(projectId, entityType, entityId, assetId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:deposit-character-voice", (_event, projectId, characterId) => {
  try { return { ok: true, entry: requireWorkbench().workflow.depositCharacterVoiceToLibrary(projectId, characterId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:bind-character-voice-library", async (_event, projectId, characterId, voiceId) => {
  try { return { ok: true, candidate: requireWorkbench().workflow.bindCharacterVoiceLibrary(projectId, characterId, voiceId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:delete-voice-library-entry", (_event, voiceId) => {
  try { return { ok: true, entry: requireWorkbench().store.deleteVoiceLibraryEntry(voiceId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-voice-library", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入长期音色库音频",
      properties: ["openFile"],
      filters: MEDIA_RULES.audio.filters
    });
    if (result.canceled) return { ok: true, canceled: true };
    const { store, workflow } = requireWorkbench();
    const sourcePath = result.filePaths[0];
    const described = await describeMedia(sourcePath, "audio");
    if (Number(described.duration) > 15.05) {
      throw Object.assign(new Error("单个音色参考不能超过音频总上限 15 秒"), { code: "AUDIO_DURATION_INVALID" });
    }
    const entryId = require("./workbench-store").makeId("voice");
    const sourceExtension = `.${described.extension}`;
    const target = path.join(store.voiceLibraryFilesDir, `${entryId}${sourceExtension}`);
    fs.mkdirSync(store.voiceLibraryFilesDir, { recursive: true });
    fs.copyFileSync(sourcePath, target);
    const baseName = path.basename(sourcePath, path.extname(sourcePath));
    const entry = store.upsertVoiceLibraryEntry({
      id: entryId,
      label: baseName || entryId,
      characterName: baseName,
      gender: "",
      ageBand: "",
      voiceDescription: "",
      identityHints: "",
      tags: [baseName].filter(Boolean),
      filePath: target,
      fileUrl: pathToFileURL(target).href,
      duration: Number(described.duration) || 0,
      audioSpec: sourceExtension === ".wav"
        ? { container: "wav", codec: "pcm_s16le", channels: 1, sampleRate: 44100 }
        : { container: described.extension, codec: "", channels: null, sampleRate: null },
      audioAudit: { ok: true, source: "manual-import" },
      mediaProbeVerified: true,
      fingerprint: `manual|${baseName}|${entryId}`,
      source: { projectId: "", projectTitle: "", characterId: "", characterName: baseName, candidateId: "" },
      useCount: 0
    });
    return { ok: true, entry, voices: workflow.listVoiceLibrary() };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-shot-video", async (_event, projectId, shotId, mode) => {
  try { return { ok: true, candidate: await requireWorkbench().workflow.generateShotVideo(projectId, shotId, mode) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-all-assets", async (_event, projectId) => {
  try { return { ok: true, candidates: await requireWorkbench().workflow.generateAllAssets(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-all-storyboards", async (_event, projectId) => {
  try { return { ok: true, candidates: await requireWorkbench().workflow.generateAllStoryboards(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-all-shot-videos", async (_event, projectId) => {
  try { return { ok: true, candidates: await requireWorkbench().workflow.generateAllShotVideos(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:audit-media-quality", async (_event, projectId) => {
  try { return { ok: true, audit: await requireWorkbench().workflow.auditProjectMediaQuality(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:repair-media-quality", async (_event, projectId) => {
  try { return { ok: true, result: await requireWorkbench().workflow.repairFailedMedia(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:run-full-pipeline", async (_event, projectId) => {
  try { return { ok: true, result: await requireWorkbench().workflow.runFullPipeline(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:run-pipeline-from-stage", async (_event, projectId, fromStage) => {
  try { return { ok: true, result: await requireWorkbench().workflow.runPipelineFromStage(projectId, fromStage || "assets") }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:pause-pipeline", (_event, projectId, intent) => {
  try { return { ok: true, automation: requireWorkbench().workflow.pausePipeline(projectId, intent || "pause") }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:list-projects-overview", () => {
  try {
    const { store } = requireWorkbench();
    const { listProjectsOverview } = require("./project-overview");
    const projects = store.listProjects().map(summary => {
      try { return store.getProject(summary.id); }
      catch { return summary; }
    });
    return { ok: true, projects: listProjectsOverview(projects) };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:generate-library-asset", async (_event, projectId, libraryType, assetId) => {
  try { return { ok: true, candidate: await requireWorkbench().workflow.generateLibraryAssetImage(projectId, libraryType, assetId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:confirm-candidate", (_event, projectId, candidateId, discardOthers) => {
  try {
    const { store, workflow } = requireWorkbench();
    const candidate = store.confirmCandidate(projectId, candidateId, discardOthers !== false);
    if (candidate?.entityType === "character" && candidate?.stage === "character_voice") {
      workflow.invalidateShotVideosForVoiceChange(projectId, candidate.entityId, candidate);
    }
    return { ok: true, candidate };
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:discard-candidate", (_event, projectId, candidateId) => {
  try { return { ok: true, ...requireWorkbench().store.discardCandidate(projectId, candidateId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:discard-failed-records", (_event, projectId, scope) => {
  try { return { ok: true, ...requireWorkbench().store.discardFailedRecords(projectId, scope || null) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:clear-automation-failures", (_event, projectId) => {
  try { return { ok: true, ...requireWorkbench().store.clearAutomationFailures(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:stitch", async (_event, projectId) => {
  try { return { ok: true, result: await requireWorkbench().workflow.stitchProject(projectId) }; }
  catch (error) { return publicError(error); }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  process.on("unhandledRejection", (reason) => {
    console.error("[workbench] unhandledRejection", reason);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "后台任务异常",
        message: "有任务未捕获地失败。",
        detail: String(reason?.message || reason || "unknown"),
        buttons: ["知道了"]
      }).catch(() => {});
    }
  });
  process.on("uncaughtException", (error) => {
    console.error("[workbench] uncaughtException", error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "程序异常",
        message: "主进程发生未处理错误。",
        detail: String(error?.message || error || "unknown"),
        buttons: ["知道了"]
      }).catch(() => {});
    }
  });
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    // safeStorage can only decrypt the persisted authorization after Electron is
    // ready. Constructing the client at module load made the `safe:` ciphertext
    // look like a live token and caused every restart to report SESSION_EXPIRED.
    dramaLicense = new DramaLicenseClient();
    const dataRoot = process.env.DRAMA_SLOT_DATA_ROOT || path.join(app.getPath("userData"), "workbench");
    workbenchStore = new WorkbenchStore(dataRoot, {
      encode: value => {
        if (!value) return "";
        if (!safeStorage.isEncryptionAvailable()) {
          throw Object.assign(new Error("系统安全存储不可用，供应商凭据未保存"), { code: "SECRET_STORAGE_UNAVAILABLE" });
        }
        return `enc:${safeStorage.encryptString(value).toString("base64")}`;
      },
      decode: value => {
        if (!String(value || "").startsWith("enc:")) return value || "";
        if (!safeStorage.isEncryptionAvailable()) return "";
        try { return safeStorage.decryptString(Buffer.from(String(value).slice(4), "base64")); }
        catch { return ""; }
      }
    });
    integrityGuard.start();
    hydratePureamDefaults(workbenchStore, dramaLicense.storedActivationCode());
    workbenchWorkflow = new WorkbenchWorkflow({
      store: workbenchStore,
      bridge,
      locateFfmpeg,
      stagingRoot: path.join(process.env.LOCALAPPDATA || app.getPath("temp"), "PureamDramaSlot", "staging"),
      licenseClient: licenseBypassAllowed() ? null : dramaLicense,
      integrityGuard
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
