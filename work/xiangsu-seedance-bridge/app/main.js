"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } = require("electron");
const { BridgeClient } = require("./bridge-client");
const { contractFor, providerDisplayName } = require("./puream-video-adapters");
const { testProvider } = require("./ai-provider");
const { stageSubmissionMedia } = require("./media-staging");
const { WorkbenchStore } = require("./workbench-store");
const { WorkbenchWorkflow } = require("./workbench-workflow");

const APP_USER_MODEL_ID = "cn.puream.drama.slotmachine";
const APP_ICON_PATH = path.join(__dirname, "assets", "app.ico");

// Keep the Windows taskbar identity aligned with the packaged app and desktop shortcut.
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

// Windows GPU process crashes (exit_code=34) leave only the title-bar overlay on a black client area.
// Disable hardware acceleration before ready so the workbench stays software-composited.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

const bridge = new BridgeClient();
let mainWindow;
let workbenchStore;
let workbenchWorkflow;
let accountSwitchRequest = null;
let videoJobSyncRequest = null;
let rendererCrashReloads = 0;

function readOfficialPureamActivationCode() {
  const roaming = process.env.APPDATA || app.getPath("appData");
  const candidates = [
    path.join(roaming, "@puream", "desktop", "config.json"),
    path.join(roaming, "纯梦AI创作平台", "config.json"),
    path.join(roaming, "纯梦大助手", "config.json")
  ];
  for (const filePath of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const code = String(value?.savedActivationCode || value?.activationCode || value?.auth?.activationCode || "").trim();
      if (code) return { code, sourcePath: filePath };
    } catch {}
  }
  return { code: "", sourcePath: "" };
}

function hydratePureamDefaults(store) {
  const settings = store.getSettings();
  const imported = readOfficialPureamActivationCode();
  const pureamTextCredential = settings.textProviderProfiles?.["puream-relay"]?.apiKey
    || (settings.textProvider?.kind === "puream-relay" ? settings.textProvider.apiKey : "")
    || "";
  const existing = settings.imageProvider?.apiKey || settings.digitalHumanProvider?.apiKey || pureamTextCredential;
  const credential = existing || imported.code;
  settings.textProviderProfiles = {
    ...(settings.textProviderProfiles || {}),
    "puream-relay": {
      ...(settings.textProviderProfiles?.["puream-relay"] || {}),
      kind: "puream-relay",
      apiKey: credential
    }
  };
  if (settings.textProvider?.kind === "puream-relay") settings.textProvider = { ...settings.textProvider, apiKey: credential };
  settings.imageProvider = { ...settings.imageProvider, apiKey: credential };
  settings.digitalHumanProvider = { ...settings.digitalHumanProvider, apiKey: credential };
  const saved = store.saveSettings(settings);
  bridge.configure(saved.videoProvider);
  return {
    configured: Boolean(credential),
    source: existing ? "workbench-safe-storage" : imported.sourcePath ? "official-desktop" : "missing",
    settings: saved
  };
}

const MEDIA_RULES = {
  image: {
    maxCount: 9,
    extensions: ["png", "jpg", "jpeg", "webp"],
    filters: [{ name: "参考图片", extensions: ["png", "jpg", "jpeg", "webp"] }]
  },
  video: {
    maxCount: 3,
    extensions: ["mp4", "mov"],
    filters: [{ name: "参考视频", extensions: ["mp4", "mov"] }]
  },
  audio: {
    maxCount: 3,
    extensions: ["mp3", "wav", "aac", "flac"],
    filters: [{ name: "参考音频", extensions: ["mp3", "wav", "aac", "flac"] }]
  }
};

function publicError(error) {
  return {
    ok: false,
    code: error?.code || "UNEXPECTED_ERROR",
    message: error?.message || "发生未知错误"
  };
}

function createWindow() {
  const capturePath = process.env.DRAMA_SLOT_CAPTURE_PATH;
  const captureResultPath = process.env.DRAMA_SLOT_CAPTURE_RESULT_PATH;
  const captureScenario = String(process.env.DRAMA_SLOT_CAPTURE_SCENARIO || "").replace(/[^a-z]/g, "");
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
    // Soft-render + limited auto-reload: unbounded reload loops look like opening flicker.
    if (rendererCrashReloads >= 2) {
      console.error("[workbench] renderer crash reload budget exhausted; leaving window for manual restart");
      return;
    }
    rendererCrashReloads += 1;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.reload();
    }, 250);
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.error("[workbench] renderer became unresponsive");
  });
  if (fs.existsSync(APP_ICON_PATH)) {
    try { mainWindow.setIcon(nativeImage.createFromPath(APP_ICON_PATH)); } catch {}
  }
  if (app.isPackaged) {
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
            document.querySelector('#videoBaseUrl').value = 'https://puream.cn';
            document.querySelector('#videoApiKey').value = '本机加密保存的纯梦授权码';
            document.querySelector('#videoOssAccessKeyId').value = 'OSS AccessKey ID';
            document.querySelector('#videoOssAccessKeySecret').value = '本机加密保存';
            document.querySelector('#videoOssBucket').value = 'your-bucket';
            document.querySelector('#videoOssEndpoint').value = 'oss-cn-beijing.aliyuncs.com';
            document.querySelector('#hailuoApiMode').value = 'multimodal_to_video';
            document.querySelector('#hailuoApiMode').dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#hailuoRefImageSize').value = 'max';
            document.querySelector('#hailuoSeed').value = '20260804';
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
            kind.value = 'puream-hailuo-h3';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            const card = document.querySelector('.video-provider-card');
            document.querySelector('.settings-grid')?.prepend(card);
            card?.scrollIntoView({ block: 'start' });
          })()`);
          await new Promise(resolve => setTimeout(resolve, 240));
          await mainWindow.webContents.executeJavaScript(`(() => {
            document.querySelectorAll('.stage-panel').forEach(node => {
              const active = node.dataset.panel === 'settings';
              node.classList.toggle('active', active);
              node.style.setProperty('display', active ? 'block' : 'none', 'important');
            });
            document.querySelector('.video-provider-card')?.scrollIntoView({ block: 'start' });
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

function locateFfmpeg() {
  const xiangsu = bridge.locateXiangsu();
  if (!xiangsu) return null;
  const candidates = [
    path.join(path.dirname(xiangsu), "x64", "ffmpeg.exe"),
    path.join(path.dirname(xiangsu), "ffmpeg.exe")
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function readAvMetadata(filePath) {
  const ffmpeg = locateFfmpeg();
  if (!ffmpeg) return Promise.resolve({ duration: null, width: null, height: null });
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", filePath], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let output = "";
    child.stderr.on("data", chunk => {
      if (output.length < 256_000) output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      const videoMatch = output.match(/Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
      const duration = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : null;
      resolve({
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
  const metadata = type === "image"
    ? (() => {
        const size = nativeImage.createFromPath(filePath).getSize();
        return { duration: null, width: size.width, height: size.height };
      })()
    : await readAvMetadata(filePath);
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
  const providerKind = settings.videoProvider?.kind || "local-xiangsu";
  const contract = contractFor(providerKind);
  const defaultDuration = Math.max(contract.durationMin, Math.min(contract.durationMax, Number(settings.generation?.shotDuration) || 10));
  return {
    captureMode: Boolean(process.env.DRAMA_SLOT_CAPTURE_PATH),
    outputDir: path.join(app.getPath("videos"), "纯梦短剧老虎机"),
    providerKind,
    providerName: providerDisplayName(providerKind),
    hailuoApiMode: settings.videoProvider?.hailuoApiMode || "auto",
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
  try {
    workbenchStore?.assertVideoSubmissionsAllowed?.();
    staged = stageSubmissionMedia({
      ...payload,
      providerKind: bridge.config.kind,
      hailuoApiMode: bridge.config.kind === "puream-hailuo-h3" ? (payload?.hailuoApiMode || bridge.config.hailuoApiMode || "auto") : "",
      outputDir: payload?.outputDir || path.join(app.getPath("videos"), "纯梦短剧老虎机")
    }, path.join(process.env.LOCALAPPDATA || app.getPath("temp"), "PureamDramaSlot", "staging"));
    return await bridge.submit(staged.payload);
  } catch (error) {
    return publicError(error);
  } finally {
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
    message: item.message,
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
    } catch {}
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
    return { ok: true, state: { ...state, pendingJobs: publicPendingJobs(store.listActiveVideoJobs()) } };
  } catch (error) { return publicError(error); }
});

ipcMain.handle("workbench:sync-video-jobs", async () => {
  if (videoJobSyncRequest) return videoJobSyncRequest;
  videoJobSyncRequest = (async () => {
    try {
      const { store, workflow } = requireWorkbench();
      const active = store.listActiveVideoJobs();
      if (!active.length) {
        workflow.reconcileDetachedAutomations();
        return { ok: true, jobs: [] };
      }
      const health = await bridge.health();
      if (!(health.ok && health.ready && health.sessionReady)) return { ok: true, jobs: publicPendingJobs(active), deferred: true };
      const jobs = await workflow.reconcileOrphanedVideoJobs();
      workflow.reconcileDetachedAutomations();
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
  try { return { ok: true, project: requireWorkbench().store.createProject(title, options || {}) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:get-project", (_event, projectId) => {
  try { return { ok: true, project: requireWorkbench().store.getProject(projectId) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:patch-project", (_event, projectId, patch) => {
  try { return { ok: true, project: requireWorkbench().store.patchProject(projectId, patch || {}) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:get-settings", () => {
  try { return { ok: true, settings: requireWorkbench().store.getSettings() }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:save-settings", (_event, settings) => {
  try {
    const saved = requireWorkbench().store.saveSettings(settings || {});
    bridge.configure(saved.videoProvider);
    return { ok: true, settings: saved };
  }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:reset-settings", () => {
  try {
    const { store } = requireWorkbench();
    const settings = store.resetSettings({ preserveSecrets: true });
    bridge.configure(settings.videoProvider);
    return { ok: true, settings };
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
      source: settings.textProvider?.authSource || "official-desktop",
      masked: credential ? `${credential.slice(0, 2)}••••${credential.slice(-2)}` : ""
    };
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
    const imported = workflow.importAsset(projectId, "product", result.filePaths[0], "product");
    const project = store.getProject(projectId);
    project.product.imagePath = imported.path;
    store.saveProject(project);
    return { ok: true, asset: imported, project };
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
    const text = fs.readFileSync(filePath, "utf8");
    return { ok: true, text, fileName: path.basename(filePath), filePath };
  } catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:import-candidate", async (_event, projectId, entityType, entityId, stage) => {
  try {
    const imageStages = new Set(["character_three_view", "character_intro", "scene_asset", "storyboard_start", "storyboard_end", "wardrobe_asset", "prop_asset"]);
    const videoStages = new Set(["character_video", "shot_video"]);
    const audioStages = new Set(["character_voice"]);
    const type = imageStages.has(stage) ? "image" : videoStages.has(stage) ? "video" : audioStages.has(stage) ? "audio" : "";
    if (!type || !["character", "scene", "shot", "library"].includes(entityType)) throw Object.assign(new Error("手动资产类型无效"), { code: "IMPORT_STAGE_INVALID" });
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "手动上传候选资产",
      properties: ["openFile"],
      filters: MEDIA_RULES[type].filters
    });
    if (result.canceled) return { ok: true, canceled: true };
    const { store, workflow } = requireWorkbench();
    const described = await describeMedia(result.filePaths[0], type);
    if (stage === "shot_video" && Number(described.duration) > 15.05) {
      throw Object.assign(new Error("分镜视频参考时长超出合同上限"), { code: "VIDEO_DURATION_INVALID" });
    }
    if (stage === "character_voice" && Number(described.duration) > 15.05) {
      throw Object.assign(new Error("单个音色参考不能超过音频总上限 15 秒"), { code: "AUDIO_DURATION_INVALID" });
    }
    const category = type === "image"
      ? (entityType === "character" || entityType === "library" ? "characters" : entityType === "scene" ? "scenes" : "storyboards")
      : type === "video" ? "videos" : "audio";
    const imported = workflow.importAsset(projectId, category, result.filePaths[0], `${stage}-manual`);
    let candidate = store.addCandidate(projectId, {
      entityType,
      entityId,
      stage,
      prompt: "手动上传资产",
      filePath: imported.path,
      fileUrl: imported.fileUrl,
      duration: described.duration,
      source: "manual-upload",
      qualityAudit: ["shot_video", "character_video"].includes(stage) ? { ok: true, mode: "manual", skipped: true, checkedAt: new Date().toISOString() } : undefined,
      faceMesh: entityType === "character" && ["character_three_view", "character_intro"].includes(stage)
        ? { required: store.getProject(projectId).generation?.engine !== "hailuo-h3", applied: false, method: "manual-awaiting-remesh" }
        : undefined
    });
    if (entityType === "character" && ["character_three_view", "character_intro"].includes(stage) && store.getProject(projectId).generation?.engine !== "hailuo-h3") {
      candidate = await workflow.remeshCharacterAsset(projectId, candidate.id);
    }
    if (stage === "storyboard_start" || stage === "storyboard_end") {
      await workflow.auditStoryboardCandidate(projectId, entityId, candidate.id);
      candidate = store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    return { ok: true, candidate };
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
  try { return { ok: true, candidate: requireWorkbench().store.confirmCandidate(projectId, candidateId, discardOthers !== false) }; }
  catch (error) { return publicError(error); }
});
ipcMain.handle("workbench:stitch", async (_event, projectId) => {
  try { return { ok: true, result: await requireWorkbench().workflow.stitchProject(projectId) }; }
  catch (error) { return publicError(error); }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    const dataRoot = process.env.DRAMA_SLOT_DATA_ROOT || path.join(app.getPath("userData"), "workbench");
    workbenchStore = new WorkbenchStore(dataRoot, {
      encode: value => {
        if (!value || !safeStorage.isEncryptionAvailable()) return value;
        return `enc:${safeStorage.encryptString(value).toString("base64")}`;
      },
      decode: value => {
        if (!String(value || "").startsWith("enc:") || !safeStorage.isEncryptionAvailable()) return value || "";
        try { return safeStorage.decryptString(Buffer.from(String(value).slice(4), "base64")); }
        catch { return ""; }
      }
    });
    hydratePureamDefaults(workbenchStore);
    workbenchWorkflow = new WorkbenchWorkflow({
      store: workbenchStore,
      bridge,
      locateFfmpeg,
      stagingRoot: path.join(process.env.LOCALAPPDATA || app.getPath("temp"), "PureamDramaSlot", "staging")
    });
    workbenchWorkflow.reconcileDetachedAutomations();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
