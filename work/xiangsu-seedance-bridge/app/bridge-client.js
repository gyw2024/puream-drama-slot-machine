"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  LOCAL_XIANGSU_ORIGIN,
  assertPureamCloudRequestUrl,
  assertSafeVideoDownloadUrl,
  normalizeVideoProvider
} = require("./video-provider-policy");
const {
  apiRoutes,
  buildCloudSubmit,
  mapQueryResponse,
  mapSubmitResponse,
  providerDisplayName,
  validateProviderConfig
} = require("./puream-video-adapters");

const BRIDGE_ORIGIN = LOCAL_XIANGSU_ORIGIN;
const REQUEST_TIMEOUT_MS = 20_000;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function buildWindowHiderCommand(executable, launchedAt = null, mode = "hide", controlPath = "", controlValue = "") {
  const quotedExecutable = String(executable).replace(/'/g, "''");
  const quotedControlPath = String(controlPath || "").replace(/'/g, "''");
  const cutoff = launchedAt === null ? "1970-01-01T00:00:00.000Z" : new Date(launchedAt - 2_000).toISOString();
  const requestedControlMode = mode === "login" ? "login" : mode === "show" ? "visible" : "hidden";
  const expectedControlValue = String(controlValue || requestedControlMode).replace(/'/g, "''");
  const script = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PureamWindowControl {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  private static string Title(IntPtr hWnd) {
    var text = new StringBuilder(256);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }

  private static bool IsLoginTitle(string title) {
    return title == "\u767b\u5f55" || title == "\u6296\u97f3\u767b\u5f55" || title == "\u624b\u673a\u53f7\u767b\u5f55";
  }

  public static void Apply(uint[] processIds, string mode) {
    var ids = new HashSet<uint>(processIds ?? new uint[0]);
    IntPtr loginWindow = IntPtr.Zero;
    if (mode == "login") {
      EnumWindows(delegate(IntPtr window, IntPtr state) {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        if (ids.Contains(processId) && IsLoginTitle(Title(window))) {
          loginWindow = window;
          return false;
        }
        return true;
      }, IntPtr.Zero);
    }
    EnumWindows(delegate(IntPtr window, IntPtr state) {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (!ids.Contains(processId)) return true;
      if (mode == "login") {
        if (loginWindow != IntPtr.Zero && window == loginWindow) {
          if (!IsWindowVisible(window)) ShowWindowAsync(window, 9);
          SetForegroundWindow(window);
        } else if (IsWindowVisible(window)) {
          ShowWindowAsync(window, 0);
        }
      } else if (mode == "show") {
        if (!IsWindowVisible(window)) ShowWindowAsync(window, 9);
        if (Title(window).Length > 0) SetForegroundWindow(window);
      } else if (IsWindowVisible(window)) {
        ShowWindowAsync(window, 0);
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@
$targetPath = '${quotedExecutable}'
$controlPath = '${quotedControlPath}'
$cutoff = [DateTime]::Parse('${cutoff}').ToUniversalTime()
for ($attempt = 0; $attempt -lt 600; $attempt++) {
  if ($controlPath -and (Test-Path -LiteralPath $controlPath)) {
    try {
      $requestedMode = (Get-Content -LiteralPath $controlPath -Raw).Trim()
      if ($requestedMode -ne '${expectedControlValue}') { break }
    } catch {}
  }
  $processIds = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      if ($_.Path -eq $targetPath -and $_.StartTime.ToUniversalTime() -ge $cutoff) {
        [uint32]$_.Id
      }
    } catch {}
  })
  if ($processIds.Count -gt 0) {
    [PureamWindowControl]::Apply([uint32[]]$processIds, '${mode}')
  }
  Start-Sleep -Milliseconds 100
}
`;
  return Buffer.from(script, "utf16le").toString("base64");
}

function resolveWindowHider() {
  const helperCandidates = [
    process.resourcesPath && path.join(process.resourcesPath, "app.asar.unpacked", "app", "assets", "xiangsu-window-hider.exe"),
    path.join(__dirname, "assets", "xiangsu-window-hider.exe")
  ].filter(Boolean);
  return helperCandidates.find(candidate => fs.existsSync(candidate)) || null;
}

function controlXiangsuWindows(executable, launchedAt, mode, controlPath, controlValue = "") {
  const helper = resolveWindowHider();
  if (helper) {
    const cutoff = launchedAt === null ? "1970-01-01T00:00:00.000Z" : new Date(launchedAt - 2_000).toISOString();
    const nativeHider = spawn(helper, [executable, cutoff, mode, controlPath || "", controlValue || ""], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    nativeHider.unref();
    return;
  }
  const encodedCommand = buildWindowHiderCommand(executable, launchedAt, mode, controlPath, controlValue);
  const hider = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-EncodedCommand", encodedCommand
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  hider.unref();
}

class BridgeClient {
  constructor(options = {}) {
    this.fetch = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch.bind(globalThis);
    this.tokenPath = process.env.SEEDANCE_BRIDGE_TOKEN_PATH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SeedanceBridge", "bridge-token");
    this.stateDir = path.dirname(this.tokenPath);
    this.remoteTasksPath = path.join(this.stateDir, "remote-tasks.json");
    this.windowControlPath = path.join(this.stateDir, "xiangsu-window-mode");
    this.config = normalizeVideoProvider({ kind: "local-xiangsu" });
  }

  setWindowMode(mode) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const normalized = mode === "login" ? "login" : mode === "visible" ? "visible" : "hidden";
    const value = `${normalized}:${crypto.randomUUID()}`;
    fs.writeFileSync(this.windowControlPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
    return value;
  }

  configure(config = {}) {
    try {
      this.config = { ...normalizeVideoProvider(config), policyError: "", policyErrorCode: "" };
    } catch (error) {
      this.config = {
        kind: ["remote-api", "puream-seedance", "puream-hailuo-h3"].includes(config.kind) ? (config.kind === "remote-api" ? "puream-seedance" : config.kind) : "local-xiangsu",
        baseUrl: String(config.baseUrl || "").trim(),
        apiKey: String(config.apiKey || "").trim(),
        model: String(config.model || "").trim(),
        resolution: "720p",
        policyError: error.message,
        policyErrorCode: error.code
      };
    }
    return this.config;
  }

  isRemote() {
    return this.config.kind !== "local-xiangsu";
  }

  authorization() {
    return this.isRemote() ? this.config.apiKey : this.ensureToken();
  }

  ensureToken() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    if (!fs.existsSync(this.tokenPath)) {
      fs.writeFileSync(this.tokenPath, crypto.randomBytes(32).toString("hex"), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
    }
    return fs.readFileSync(this.tokenPath, "utf8").trim();
  }

  async request(route, options = {}) {
    if (this.config.policyError) {
      throw Object.assign(new Error(this.config.policyError), { code: this.config.policyErrorCode || "VIDEO_PROVIDER_POLICY_REJECTED" });
    }
    const token = this.authorization();
    if (!token) {
      const error = new Error(this.isRemote() ? "纯梦视频授权码未配置" : "本机桥令牌不可用");
      error.code = "BRIDGE_AUTH_REQUIRED";
      throw error;
    }
    if (!this.config.baseUrl) {
      const error = new Error("纯梦视频 API 地址未配置");
      error.code = "BRIDGE_BASE_URL_REQUIRED";
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);

    try {
      const requestUrl = `${this.config.baseUrl}${route}`;
      if (this.isRemote()) assertPureamCloudRequestUrl(requestUrl);
      const response = await this.fetch(requestUrl, {
        method: options.method || "GET",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
          ...(options.headers || {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: this.isRemote() ? "error" : "follow"
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { message: text || `HTTP ${response.status}` };
      }
      if (!response.ok) {
        const error = new Error(payload.message || `桥接请求失败：HTTP ${response.status}`);
        error.code = payload.code || "BRIDGE_HTTP_ERROR";
        error.status = response.status;
        error.details = payload.result || null;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async health() {
    try {
      if (this.isRemote()) {
        validateProviderConfig(this.config, { hasLocalMedia: false });
        return {
          ok: true,
          ready: true,
          sessionReady: true,
          remote: true,
          providerKind: this.config.kind,
          message: `${providerDisplayName(this.config.kind)}接口合同与授权配置已就绪；校验不创建计费任务`
        };
      }
      return await this.request("/v1/health", { timeoutMs: 2_500 });
    } catch (error) {
      return {
        ok: false,
        code: error.name === "AbortError" ? "BRIDGE_TIMEOUT" : "BRIDGE_OFFLINE",
        remote: this.isRemote(),
        message: this.isRemote() ? `${providerDisplayName(this.config.kind)}配置不可用：${error.message}` : "像塑后台桥未连接"
      };
    }
  }

  diagnostics() {
    if (this.isRemote()) {
      try {
        const contract = validateProviderConfig(this.config, { hasLocalMedia: false });
        return Promise.resolve({ ok: true, remote: true, providerKind: this.config.kind, contract, message: "纯梦官网视频接口合同配置有效" });
      } catch (error) {
        return Promise.resolve({ ok: false, remote: true, code: error.code, message: error.message });
      }
    }
    return this.request("/v1/diagnostics");
  }

  sessionCheck() {
    if (this.isRemote()) return Promise.resolve({ ok: true, authenticated: true, remote: true, accountFingerprint: "", message: "正式远程 API 凭据已配置" });
    return this.request("/v1/session-check", { timeoutMs: 15_000 });
  }

  accountAction(action) {
    if (this.isRemote()) return Promise.resolve({ ok: true, remote: true, action });
    return this.request("/v1/account-switch", {
      method: "POST",
      body: { action },
      timeoutMs: action === "logout" ? 20_000 : 10_000
    });
  }

  async waitForLocalBridge(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.health();
      if (last.ok && last.ready) return last;
      await delay(500);
    }
    const error = new Error(last?.message || "像塑后台桥接重启超时");
    error.code = last?.code || "XIANGSU_BRIDGE_RESTART_TIMEOUT";
    throw error;
  }

  async beginOfficialAccountSwitch() {
    if (this.isRemote()) return { ok: true, remote: true, message: "远程 API 不需要切换像塑账号" };
    let logoutError = null;
    try {
      await this.accountAction("logout");
    } catch (error) {
      logoutError = error;
    }
    await delay(700);
    let health = await this.health();
    if (!(health.ok && health.ready)) {
      this.launchXiangsuBridge();
      health = await this.waitForLocalBridge();
    }
    if (logoutError) {
      let session = null;
      try { session = await this.sessionCheck(); } catch {}
      if (session?.ok && session?.authenticated) throw logoutError;
    }
    const login = await this.accountAction("login");
    return {
      ok: true,
      official: true,
      loggedOut: true,
      loginWindowRequested: Boolean(login?.loginWindowRequested),
      message: "旧账号已退出，像塑官方扫码或手机号登录页已准备"
    };
  }

  async requestOfficialLogin() {
    if (this.isRemote()) return { ok: true, remote: true, loginWindowRequested: false };
    let health = await this.health();
    if (!(health.ok && health.ready)) {
      this.launchXiangsuBridge();
      health = await this.waitForLocalBridge();
    }
    return this.accountAction("login");
  }

  readRemoteTasks() {
    try { return JSON.parse(fs.readFileSync(this.remoteTasksPath, "utf8")); }
    catch { return {}; }
  }

  saveRemoteTask(taskId, value) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tasks = this.readRemoteTasks();
    tasks[taskId] = value;
    const temporary = `${this.remoteTasksPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(tasks, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.remoteTasksPath);
  }

  async submit(payload) {
    if (!this.isRemote()) return this.request("/v1/videos", { method: "POST", body: payload, timeoutMs: 600_000 });
    const cloud = await buildCloudSubmit(this.config, payload, this.fetch, fs);
    const raw = await this.request(apiRoutes(this.config.kind).submit, {
      method: "POST",
      body: cloud.body,
      headers: { "idempotency-key": cloud.requestId },
      timeoutMs: 600_000
    });
    const result = mapSubmitResponse(raw, this.config.kind);
    this.saveRemoteTask(result.taskId, {
      outputDir: payload.outputDir,
      providerKind: this.config.kind,
      requestedMode: this.config.kind === "puream-hailuo-h3" ? (payload.hailuoApiMode || payload.mode || this.config.hailuoApiMode || "auto") : "",
      submittedAt: new Date().toISOString()
    });
    return result;
  }

  async downloadRemoteVideo(taskId, videoUrl = "") {
    const task = this.readRemoteTasks()[taskId];
    if (!task?.outputDir || !path.isAbsolute(task.outputDir)) {
      const error = new Error("远程任务缺少本地输出目录映射");
      error.code = "REMOTE_OUTPUT_DIR_MISSING";
      throw error;
    }
    fs.mkdirSync(task.outputDir, { recursive: true });
    const target = path.join(task.outputDir, `${taskId}.mp4`);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
    if (task.providerKind && task.providerKind !== this.config.kind) {
      throw Object.assign(new Error(`该任务由 ${providerDisplayName(task.providerKind)} 提交，请切回对应供应商后继续下载`), { code: "REMOTE_TASK_PROVIDER_MISMATCH" });
    }
    let safeVideoUrl = videoUrl ? assertSafeVideoDownloadUrl(videoUrl) : "";
    if (!safeVideoUrl) {
      const downloadUrl = `${this.config.baseUrl}${apiRoutes(this.config.kind, taskId).download}`;
      assertPureamCloudRequestUrl(downloadUrl);
      const redirect = await this.fetch(downloadUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${this.authorization()}` },
        signal: AbortSignal.timeout(120_000),
        redirect: "manual"
      });
      if ([301, 302, 303, 307, 308].includes(redirect.status)) {
        safeVideoUrl = assertSafeVideoDownloadUrl(redirect.headers.get("location"));
      } else if (redirect.ok && String(redirect.headers.get("content-type") || "").toLowerCase().includes("video")) {
        const temporary = `${target}.part`;
        fs.writeFileSync(temporary, Buffer.from(await redirect.arrayBuffer()));
        fs.renameSync(temporary, target);
        return target;
      } else {
        const errorText = await redirect.text();
        throw Object.assign(new Error(errorText || `纯梦下载接口失败：HTTP ${redirect.status}`), { code: "PUREAM_DOWNLOAD_REDIRECT_FAILED", status: redirect.status });
      }
    }
    const response = await this.fetch(safeVideoUrl, { signal: AbortSignal.timeout(600_000), redirect: "follow" });
    if (!response.ok) throw Object.assign(new Error(`下载远程视频失败：HTTP ${response.status}`), { code: "REMOTE_VIDEO_DOWNLOAD_FAILED" });
    const temporary = `${target}.part`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(temporary, target);
    return target;
  }

  async query(taskId) {
    if (!this.isRemote()) return this.request(`/v1/videos/${encodeURIComponent(taskId)}`, { timeoutMs: 120_000 });
    const task = this.readRemoteTasks()[taskId];
    if (task?.providerKind && task.providerKind !== this.config.kind) {
      throw Object.assign(new Error(`该任务属于 ${providerDisplayName(task.providerKind)}，当前设置为 ${providerDisplayName(this.config.kind)}`), { code: "REMOTE_TASK_PROVIDER_MISMATCH" });
    }
    const raw = await this.request(apiRoutes(this.config.kind, taskId).query, { timeoutMs: 120_000 });
    const result = mapQueryResponse(raw, this.config.kind, taskId);
    if (this.config.kind === "puream-hailuo-h3") result.requestedMode = task?.requestedMode || "auto";
    if (result.status === "finished") {
      result.localPath = await this.downloadRemoteVideo(taskId, result.videoUrl);
      result.downloaded = true;
    }
    return result;
  }

  resolveBundledPluginDir() {
    const candidates = [
      process.resourcesPath && path.join(process.resourcesPath, "xiangsu-plugin"),
      path.resolve(__dirname, "..", "plugin")
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(path.join(candidate, "plugin.manifest.json"))) || null;
  }

  locatePluginSlots() {
    const root = process.env.XIANGSU_PLUGIN_ROOT || path.join(process.env.LOCALAPPDATA || "", "DouyinAR", "Plugins");
    if (!root || !fs.existsSync(root)) return [];
    const versions = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^v\d+(?:\.\d+)+$/.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => {
        const av = a.slice(1).split(".").map(Number);
        const bv = b.slice(1).split(".").map(Number);
        for (let index = 0; index < Math.max(av.length, bv.length); index += 1) {
          const delta = (bv[index] || 0) - (av[index] || 0);
          if (delta) return delta;
        }
        return 0;
      });
    return versions.map(version => path.join(root, version, "Local"));
  }

  ensurePluginInstalled() {
    const sourceDir = this.resolveBundledPluginDir();
    const slots = this.locatePluginSlots();
    if (!sourceDir) {
      const error = new Error("独立应用中缺少像塑桥接插件资源");
      error.code = "PLUGIN_RESOURCE_MISSING";
      throw error;
    }
    if (!slots.length) {
      const error = new Error("未找到像塑本地插件目录；请先安装并登录一次像塑");
      error.code = "XIANGSU_PLUGIN_SLOT_NOT_FOUND";
      throw error;
    }

    const destinations = [];
    for (const slot of slots) {
      fs.mkdirSync(slot, { recursive: true });
      const destination = path.join(slot, "SeedanceBridge@0.2.0");
      fs.cpSync(sourceDir, destination, { recursive: true, force: true });

      const configPath = path.join(slot, "plugins.config.json");
      let config = { plugins: [] };
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch {}
      if (!Array.isArray(config.plugins)) config.plugins = [];
      const existing = config.plugins.find(item => item && item.name === "SeedanceBridge");
      if (existing) {
        existing.version = "0.2.0";
        existing.loadOnStartup = true;
      } else {
        config.plugins.push({ name: "SeedanceBridge", version: "0.2.0", loadOnStartup: true });
      }
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      destinations.push(destination);
    }
    return { ok: true, destinations };
  }

  locateXiangsu() {
    const candidates = [
      process.env.XIANGSU_EXE,
      "D:\\根目录\\Douyin AR\\Douyin AR.exe",
      path.join(process.env.LOCALAPPDATA || "", "Douyin AR", "Douyin AR.exe"),
      path.join(process.env.ProgramFiles || "", "Douyin AR", "Douyin AR.exe")
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
  }

  launchXiangsuBridge() {
    if (this.isRemote()) return { ok: true, remote: true, message: "纯梦云端视频 API 不需要启动像塑" };
    const executable = this.locateXiangsu();
    if (!executable) {
      const error = new Error("未找到像塑安装程序");
      error.code = "XIANGSU_NOT_FOUND";
      throw error;
    }
    this.ensureToken();
    this.ensurePluginInstalled();
    const controlValue = this.setWindowMode("hidden");
    const launchedAt = Date.now();
    const child = spawn(executable, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        SEEDANCE_BRIDGE_TOKEN_PATH: this.tokenPath,
        SEEDANCE_BRIDGE_BACKGROUND: "1"
      }
    });
    controlXiangsuWindows(executable, launchedAt, "hide", this.windowControlPath, controlValue);
    child.unref();
    return { ok: true, executable, hidden: true };
  }

  hideRunningXiangsuWindows() {
    if (this.isRemote()) return { ok: true, remote: true, hidden: false };
    const executable = this.locateXiangsu();
    if (!executable) {
      const error = new Error("未找到像塑安装程序");
      error.code = "XIANGSU_NOT_FOUND";
      throw error;
    }
    const controlValue = this.setWindowMode("hidden");
    controlXiangsuWindows(executable, null, "hide", this.windowControlPath, controlValue);
    return { ok: true, executable, hidden: true };
  }

  showXiangsuForOfficialLogin() {
    if (this.isRemote()) return { ok: true, remote: true, visible: false, message: "远程 API 不需要切换像塑账号" };
    const executable = this.locateXiangsu();
    if (!executable) {
      const error = new Error("未找到像塑安装程序");
      error.code = "XIANGSU_NOT_FOUND";
      throw error;
    }
    this.ensureToken();
    this.ensurePluginInstalled();
    const controlValue = this.setWindowMode("login");
    controlXiangsuWindows(executable, null, "login", this.windowControlPath, controlValue);
    return { ok: true, executable, visible: true, officialLogin: true, launched: false };
  }

  probeOfficialLoginWindow() {
    if (this.isRemote()) return { supported: true, exists: false, remote: true };
    const executable = this.locateXiangsu();
    const helper = resolveWindowHider();
    if (!executable || !helper) return { supported: false, exists: false };
    const result = spawnSync(helper, [executable, "1970-01-01T00:00:00.000Z", "probe-login"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 3_000
    });
    return { supported: !result.error, exists: !result.error && result.status === 0 };
  }
}

module.exports = { BridgeClient, BRIDGE_ORIGIN, buildWindowHiderCommand };
