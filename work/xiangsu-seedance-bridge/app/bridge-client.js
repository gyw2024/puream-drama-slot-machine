"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  LOCAL_XIANGSU_ORIGIN,
  assertPureamCloudRequestUrl,
  assertResolvedPublicUrl,
  assertSafeVideoDownloadUrl,
  normalizeProviderKind,
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
const MAX_REMOTE_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_LOCAL_BRIDGE_RESPONSE_BYTES = 5 * 1024 * 1024;
let localBridgeRecoveryPromise = null;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function localBridgeReadyForSubmission(health) {
  return health?.ok === true
    && health?.ready === true
    && health?.restartRequired !== true
    && health?.sessionReady !== false;
}

function isLocalPreconnectFailure(error) {
  return ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(String(error?.code || "").toUpperCase());
}

/**
 * Node's built-in fetch currently inherits an internal response-header deadline
 * even when AbortSignal has no timeout. Local Xiangsu submissions intentionally
 * keep the HTTP response open while native reference uploads finish, so use the
 * lower-level client whose production path has no implicit wall-clock cutoff.
 */
function requestLocalBridge(requestUrl, init = {}, expectedOrigin = BRIDGE_ORIGIN) {
  const target = new URL(requestUrl);
  if (target.origin !== new URL(expectedOrigin).origin) {
    throw Object.assign(new Error("本地像塑桥地址无效"), { code: "LOCAL_BRIDGE_ORIGIN_INVALID" });
  }
  const body = init.body === undefined || init.body === null ? null : Buffer.from(String(init.body), "utf8");
  const headers = { ...(init.headers || {}) };
  if (body && !Object.keys(headers).some(key => key.toLowerCase() === "content-length")) headers["content-length"] = String(body.length);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init.method || "GET",
      headers,
      agent: false
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_LOCAL_BRIDGE_RESPONSE_BYTES) {
          request.destroy(Object.assign(new Error("本地像塑桥响应超过安全上限"), { code: "LOCAL_BRIDGE_RESPONSE_TOO_LARGE" }));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => finish(resolve, {
        ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
        status: Number(response.statusCode) || 0,
        text: async () => Buffer.concat(chunks).toString("utf8")
      }));
      response.on("error", error => finish(reject, error));
    });
    const onAbort = () => {
      const reason = init.signal?.reason instanceof Error
        ? init.signal.reason
        : Object.assign(new Error("本地像塑桥请求已取消"), { name: "AbortError", code: "PROVIDER_REQUEST_ABORTED" });
      request.destroy(reason);
    };
    request.on("error", error => finish(reject, error));
    if (init.signal?.aborted) {
      onAbort();
      return;
    }
    init.signal?.addEventListener("abort", onAbort, { once: true });
    if (body) request.write(body);
    request.end();
  });
}

function normalizeRemoteTaskId(taskId) {
  const value = String(taskId ?? "").trim();
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    const error = new Error("远程视频任务标识无效");
    error.code = "REMOTE_TASK_ID_INVALID";
    throw error;
  }
  return value;
}

function safeRemoteTaskFilename(taskId) {
  const value = normalizeRemoteTaskId(taskId);
  const stem = /^[A-Za-z0-9_-]{1,160}$/.test(value)
    ? value
    : crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return `${stem}.mp4`;
}

function replaceFileWithRetries(temporary, target) {
  let lastError = null;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 40) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw lastError;
}

function atomicWriteJsonWithBackup(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    if (fs.existsSync(filePath)) {
      let backupTemporary = "";
      try {
        JSON.parse(fs.readFileSync(filePath, "utf8"));
        const backupPath = `${filePath}.bak`;
        backupTemporary = `${backupPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.copyFileSync(filePath, backupTemporary);
        JSON.parse(fs.readFileSync(backupTemporary, "utf8"));
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        replaceFileWithRetries(backupTemporary, backupPath);
        backupTemporary = "";
      } catch (error) {
        try { if (backupTemporary && fs.existsSync(backupTemporary)) fs.unlinkSync(backupTemporary); } catch {}
        console.warn(`[bridge] skipped invalid task-registry backup: ${error?.message || error}`);
      }
    }
    replaceFileWithRetries(temporary, filePath);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function writeResponseToFile(response, target, maximumBytes = MAX_REMOTE_VIDEO_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw Object.assign(new Error("远程视频超过 500MB 安全上限"), { code: "REMOTE_VIDEO_TOO_LARGE" });
  }
  if (!response.body) throw Object.assign(new Error("远程视频响应没有文件内容"), { code: "REMOTE_VIDEO_BODY_MISSING" });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.part`;
  const handle = fs.openSync(temporary, "wx");
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maximumBytes) throw Object.assign(new Error("远程视频超过 500MB 安全上限"), { code: "REMOTE_VIDEO_TOO_LARGE" });
      fs.writeSync(handle, buffer);
    }
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    if (!total) throw Object.assign(new Error("远程视频文件为空"), { code: "REMOTE_VIDEO_EMPTY" });
    fs.renameSync(temporary, target);
    return target;
  } catch (error) {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function fetchPublicVideo(fetchImpl, initialUrl, options = {}, maxRedirects = 5) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    currentUrl = await assertResolvedPublicUrl(assertSafeVideoDownloadUrl(currentUrl), {
      privateCode: "REMOTE_VIDEO_URL_BLOCKED",
      unresolvedCode: "REMOTE_VIDEO_URL_DNS_UNRESOLVED"
    });
    const response = await fetchImpl(currentUrl, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw Object.assign(new Error("远程视频重定向缺少目标地址"), { code: "REMOTE_VIDEO_REDIRECT_INVALID" });
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw Object.assign(new Error("远程视频重定向次数过多"), { code: "REMOTE_VIDEO_REDIRECT_LIMIT" });
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
    this.fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
    this.fetch = this.fetchImpl || globalThis.fetch.bind(globalThis);
    this.tokenPath = options.tokenPath || process.env.SEEDANCE_BRIDGE_TOKEN_PATH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SeedanceBridge", "bridge-token");
    this.stateDir = path.dirname(this.tokenPath);
    this.remoteTasksPath = path.join(this.stateDir, "remote-tasks.json");
    this.windowControlPath = path.join(this.stateDir, "xiangsu-window-mode");
    this.config = normalizeVideoProvider({ kind: "local-xiangsu" });
  }

  fork(config = this.config) {
    const client = new BridgeClient({ ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), tokenPath: this.tokenPath });
    client.configure(config);
    return client;
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
    const requestedTimeoutMs = Object.prototype.hasOwnProperty.call(options, "timeoutMs")
      ? Number(options.timeoutMs)
      : REQUEST_TIMEOUT_MS;
    const timeout = requestedTimeoutMs > 0 ? setTimeout(() => controller.abort(), requestedTimeoutMs) : null;
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

    try {
      const requestUrl = `${this.config.baseUrl}${route}`;
      if (this.isRemote()) assertPureamCloudRequestUrl(requestUrl);
      const requestInit = {
        method: options.method || "GET",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
          ...(options.headers || {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: this.isRemote() ? "error" : "follow"
      };
      const response = !this.isRemote() && !this.fetchImpl
        ? await requestLocalBridge(requestUrl, requestInit)
        : await this.fetch(requestUrl, requestInit);
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
        error.retryable = payload.retryable === true;
        throw error;
      }
      return payload;
    } catch (error) {
      if (externalSignal?.aborted) {
        throw externalSignal.reason instanceof Error
          ? externalSignal.reason
          : Object.assign(new Error("视频生产任务已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
      }
      if (error?.name === "AbortError" && requestedTimeoutMs > 0) {
        throw Object.assign(new Error("视频服务连接超时"), { code: "BRIDGE_REQUEST_TIMEOUT", cause: error });
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  async health() {
    try {
      if (this.isRemote()) {
        validateProviderConfig(this.config, { hasLocalMedia: false });
        const probeUrl = `${this.config.baseUrl}${apiRoutes(this.config.kind).submit}`;
        assertPureamCloudRequestUrl(probeUrl);
        const response = await this.fetch(probeUrl, {
          method: "HEAD",
          headers: { authorization: `Bearer ${this.authorization()}` },
          signal: AbortSignal.timeout(10_000),
          redirect: "error"
        });
        if ([401, 403].includes(response.status)) {
          throw Object.assign(new Error("授权已失效或没有访问权限"), { code: "PUREAM_AUTH_REJECTED", status: response.status });
        }
        if ((response.status >= 400 && response.status !== 405) || response.status >= 500) {
          throw Object.assign(new Error(`云端服务暂不可用：HTTP ${response.status}`), { code: "PUREAM_HEALTH_FAILED", status: response.status });
        }
        return {
          ok: true,
          ready: true,
          sessionReady: true,
          remote: true,
          providerKind: this.config.kind,
          status: response.status,
          message: `${providerDisplayName(this.config.kind)}网络与授权校验通过；校验不创建计费任务`
        };
      }
      const installation = this.ensurePluginInstalled();
      const localHealth = await this.request("/v1/health", { timeoutMs: 2_500 });
      const runningVersion = String(localHealth?.version || "").trim();
      if (runningVersion !== installation.version) {
        return {
          ...localHealth,
          ok: false,
          ready: false,
          code: "XIANGSU_PLUGIN_RESTART_REQUIRED",
          runningVersion,
          expectedVersion: installation.version,
          pluginUpdated: installation.updated === true,
          restartRequired: true,
          message: `像塑桥接插件已更新到 ${installation.version}，请退出并重新打开像塑后继续；不会重新提交已存在的任务`
        };
      }
      return {
        ...localHealth,
        expectedVersion: installation.version,
        pluginUpdated: installation.updated === true,
        restartRequired: false
      };
    } catch (error) {
      return {
        ok: false,
        code: error.name === "AbortError" ? "BRIDGE_TIMEOUT" : (error.code || "BRIDGE_OFFLINE"),
        remote: this.isRemote(),
        message: this.isRemote() ? `${providerDisplayName(this.config.kind)}配置不可用：${error.message}` : (error.message || "像塑后台桥未连接")
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
    if (!fs.existsSync(this.remoteTasksPath)) return {};
    try { return JSON.parse(fs.readFileSync(this.remoteTasksPath, "utf8")); }
    catch (primaryError) {
      try {
        const recovered = JSON.parse(fs.readFileSync(`${this.remoteTasksPath}.bak`, "utf8"));
        this.writeRemoteTasks(recovered);
        return recovered;
      } catch {
        throw Object.assign(new Error("视频任务索引已损坏，且没有可用备份；已停止覆盖任务记录"), {
          code: "REMOTE_TASK_REGISTRY_CORRUPTED",
          cause: primaryError
        });
      }
    }
  }

  writeRemoteTasks(tasks) {
    atomicWriteJsonWithBackup(this.remoteTasksPath, tasks);
  }

  saveRemoteTask(taskId, value) {
    taskId = normalizeRemoteTaskId(taskId);
    const tasks = this.readRemoteTasks();
    Object.defineProperty(tasks, taskId, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    this.writeRemoteTasks(tasks);
  }

  async submit(payload, options = {}) {
    // Payload providerKind is the job contract. Never let a stale BridgeClient
    // default (local-xiangsu) swallow a Hailuo H3 / Seedance cloud submission —
    // local plugin only accepts ability SD_2.0_MINI and returns ABILITY_NOT_ALLOWED.
    const requestedKind = normalizeProviderKind(payload?.providerKind || this.config.kind);
    const scopedConfig = {
      ...this.config,
      kind: requestedKind,
      baseUrl: requestedKind === "local-xiangsu"
        ? LOCAL_XIANGSU_ORIGIN
        : (/^https:\/\/([a-z0-9.-]+\.)?puream\.cn(\/|$)/i.test(String(this.config.baseUrl || "")) ? this.config.baseUrl : "https://puream.cn")
    };
    return this.fork(scopedConfig).submitScoped(payload, options);
  }

  async ensureLocalSubmissionBridge(options = {}) {
    if (this.isRemote()) return { ok: true, ready: true, sessionReady: true, remote: true };
    if (localBridgeRecoveryPromise) return localBridgeRecoveryPromise;

    const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || 45_000);
    const stabilizeMs = Math.max(0, Object.prototype.hasOwnProperty.call(options, "stabilizeMs")
      ? Number(options.stabilizeMs) || 0
      : 700);
    const recover = async () => {
      let health = options.forceLaunch === true ? null : await this.health();
      if (health?.restartRequired) {
        throw Object.assign(new Error(health.message || "The Xiangsu bridge plugin must be restarted before video submission."), {
          code: health.code || "XIANGSU_PLUGIN_RESTART_REQUIRED",
          health
        });
      }
      if (!localBridgeReadyForSubmission(health)) {
        this.launchXiangsuBridge();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          health = await this.health();
          if (health?.restartRequired) {
            throw Object.assign(new Error(health.message || "The Xiangsu bridge plugin must be restarted before video submission."), {
              code: health.code || "XIANGSU_PLUGIN_RESTART_REQUIRED",
              health
            });
          }
          if (localBridgeReadyForSubmission(health)) break;
          await delay(500);
        }
      }
      if (!localBridgeReadyForSubmission(health)) {
        throw Object.assign(new Error(health?.message || "Xiangsu did not become ready for video submission."), {
          code: health?.code || "XIANGSU_SUBMISSION_BRIDGE_NOT_READY",
          health
        });
      }

      // Keep the native editor available as a background service. The hider is
      // token-controlled, so the explicit login action can still reveal only
      // the official login window without racing this background guard.
      try { this.hideRunningXiangsuWindows(); } catch {}
      if (stabilizeMs > 0) await delay(stabilizeMs);
      const stableHealth = await this.health();
      if (!localBridgeReadyForSubmission(stableHealth)) {
        throw Object.assign(new Error(stableHealth?.message || "Xiangsu closed while preparing the video submission."), {
          code: stableHealth?.code || "XIANGSU_SUBMISSION_BRIDGE_UNSTABLE",
          health: stableHealth
        });
      }
      return stableHealth;
    };

    localBridgeRecoveryPromise = recover();
    try {
      return await localBridgeRecoveryPromise;
    } finally {
      localBridgeRecoveryPromise = null;
    }
  }

  async submitScoped(payload, options = {}) {
    if (!this.isRemote()) {
      const ability = String(payload?.ability || "SD_2.0_MINI");
      if (ability !== "SD_2.0_MINI") {
        throw Object.assign(new Error(`本地像塑只允许 SD_2.0_MINI，不能提交 ${ability}；纯梦云端算力项目请保持系统设置为云端算力`), {
          code: "ABILITY_NOT_ALLOWED",
          ability,
          providerKind: this.config.kind
        });
      }
      await this.ensureLocalSubmissionBridge();
      let result;
      try {
        result = await this.request("/v1/videos", { method: "POST", body: payload, timeoutMs: 0, signal: options.signal });
      } catch (error) {
        // ECONNREFUSED happens before a TCP connection is accepted, so no paid
        // upstream task can exist. It is therefore safe to relaunch and replay
        // the same stable clientRequestId once. Other transport failures remain
        // response-unknown and are never blindly duplicated.
        if (!isLocalPreconnectFailure(error)) {
          if (["ECONNRESET", "EPIPE"].includes(String(error?.code || "").toUpperCase())) {
            error.code = "VIDEO_SUBMISSION_RESPONSE_UNKNOWN";
            error.remoteSubmissionUnknown = true;
            error.clientRequestId = payload?.clientRequestId || "";
          }
          throw error;
        }
        await this.ensureLocalSubmissionBridge({ forceLaunch: true });
        result = await this.request("/v1/videos", { method: "POST", body: payload, timeoutMs: 0, signal: options.signal });
      }
      if (result?.taskId) this.saveRemoteTask(result.taskId, {
        outputDir: payload.outputDir,
        providerKind: "local-xiangsu",
        submittedAt: new Date().toISOString()
      });
      return result;
    }
    const cloud = await buildCloudSubmit(this.config, payload, this.fetch, fs, options);
    let raw;
    try {
      raw = await this.request(apiRoutes(this.config.kind).submit, {
        method: "POST",
        body: cloud.body,
        headers: { "idempotency-key": cloud.requestId },
        timeoutMs: 0,
        signal: options.signal
      });
    } catch (error) {
      const status = Number(error?.status) || 0;
      const explicitProviderCode = String(error?.code || "").trim();
      const responseUnknown = error?.name === "AbortError"
        || !status
        || ([502, 503, 504].includes(status) && ["", "BRIDGE_HTTP_ERROR", "SERVER_ERROR"].includes(explicitProviderCode));
      if (responseUnknown) {
        error.code = "VIDEO_SUBMISSION_RESPONSE_UNKNOWN";
        error.remoteSubmissionUnknown = true;
        error.clientRequestId = cloud.requestId;
        error.idempotencyKey = cloud.requestId;
      }
      throw error;
    }
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
    taskId = normalizeRemoteTaskId(taskId);
    const task = this.readRemoteTasks()[taskId];
    if (!task?.outputDir || !path.isAbsolute(task.outputDir)) {
      const error = new Error("远程任务缺少本地输出目录映射");
      error.code = "REMOTE_OUTPUT_DIR_MISSING";
      throw error;
    }
    fs.mkdirSync(task.outputDir, { recursive: true });
    const target = path.join(task.outputDir, safeRemoteTaskFilename(taskId));
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
    let safeVideoUrl = videoUrl ? await assertResolvedPublicUrl(assertSafeVideoDownloadUrl(videoUrl), {
      privateCode: "REMOTE_VIDEO_URL_BLOCKED",
      unresolvedCode: "REMOTE_VIDEO_URL_DNS_UNRESOLVED"
    }) : "";
    if (!safeVideoUrl) {
      const downloadUrl = `${this.config.baseUrl}${apiRoutes(this.config.kind, taskId).download}`;
      assertPureamCloudRequestUrl(downloadUrl);
      const redirect = await this.fetch(downloadUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${this.authorization()}` },
        redirect: "manual"
      });
      if ([301, 302, 303, 307, 308].includes(redirect.status)) {
        safeVideoUrl = await assertResolvedPublicUrl(assertSafeVideoDownloadUrl(redirect.headers.get("location")), {
          privateCode: "REMOTE_VIDEO_URL_BLOCKED",
          unresolvedCode: "REMOTE_VIDEO_URL_DNS_UNRESOLVED"
        });
      } else if (redirect.ok && String(redirect.headers.get("content-type") || "").toLowerCase().includes("video")) {
        return writeResponseToFile(redirect, target);
      } else {
        const errorText = await redirect.text();
        throw Object.assign(new Error(errorText || `纯梦下载接口失败：HTTP ${redirect.status}`), { code: "PUREAM_DOWNLOAD_REDIRECT_FAILED", status: redirect.status });
      }
    }
    const response = await fetchPublicVideo(this.fetch, safeVideoUrl);
    if (!response.ok) throw Object.assign(new Error(`下载远程视频失败：HTTP ${response.status}`), { code: "REMOTE_VIDEO_DOWNLOAD_FAILED" });
    return writeResponseToFile(response, target);
  }

  async query(taskId, options = {}) {
    taskId = normalizeRemoteTaskId(taskId);
    const task = this.readRemoteTasks()[taskId];
    const taskKind = task?.providerKind ? normalizeProviderKind(task.providerKind) : this.config.kind;
    const scopedConfig = {
      ...this.config,
      kind: taskKind,
      baseUrl: taskKind === "local-xiangsu"
        ? LOCAL_XIANGSU_ORIGIN
        : (/^https:\/\/([a-z0-9.-]+\.)?puream\.cn(\/|$)/i.test(String(this.config.baseUrl || "")) ? this.config.baseUrl : "https://puream.cn")
    };
    return this.fork(scopedConfig).queryScoped(taskId, task, options);
  }

  async queryScoped(taskId, task = null, options = {}) {
    if (!this.isRemote()) {
      const outputDir = typeof task?.outputDir === "string" && path.isAbsolute(task.outputDir)
        ? `?outputDir=${encodeURIComponent(task.outputDir)}`
        : "";
      try {
        return await this.request(`/v1/videos/${encodeURIComponent(taskId)}${outputDir}`, { timeoutMs: 0, signal: options.signal });
      } catch (error) {
        if (!isLocalPreconnectFailure(error)) throw error;
        await this.ensureLocalSubmissionBridge({ forceLaunch: true });
        return this.request(`/v1/videos/${encodeURIComponent(taskId)}${outputDir}`, { timeoutMs: 0, signal: options.signal });
      }
    }
    const raw = await this.request(apiRoutes(this.config.kind, taskId).query, { timeoutMs: 0, signal: options.signal });
    const result = mapQueryResponse(raw, this.config.kind, taskId);
    if (this.config.kind === "puream-hailuo-h3") result.requestedMode = task?.requestedMode || "auto";
    if (result.status === "finished") {
      try {
        result.localPath = await this.downloadRemoteVideo(taskId, result.videoUrl);
        result.downloaded = true;
      } catch (error) {
        throw Object.assign(error, {
          taskId: result.taskId || taskId,
          remoteUrl: result.videoUrl || "",
          remoteGenerationCompleted: true,
          chargeYuan: result.chargeYuan,
          settlementStatus: result.settlementStatus || "",
          upstream: result.raw
        });
      }
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

  resolveBundledPluginVersion(sourceDir = this.resolveBundledPluginDir()) {
    if (!sourceDir) return "";
    for (const name of ["plugin.manifest.json", "package.json"]) {
      try {
        const version = String(JSON.parse(fs.readFileSync(path.join(sourceDir, name), "utf8"))?.version || "").trim();
        if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return version;
      } catch {}
    }
    return "";
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
    const pluginVersion = this.resolveBundledPluginVersion(sourceDir);
    if (!pluginVersion) {
      const error = new Error("像塑桥接插件缺少有效版本信息");
      error.code = "PLUGIN_VERSION_INVALID";
      throw error;
    }

    const destinations = [];
    let updated = false;
    const sourceEntry = path.join(sourceDir, "lib", "plugin", "index.js");
    const sourceEntryHash = fs.existsSync(sourceEntry)
      ? crypto.createHash("sha256").update(fs.readFileSync(sourceEntry)).digest("hex")
      : "";
    for (const slot of slots) {
      fs.mkdirSync(slot, { recursive: true });
      const destination = path.join(slot, `SeedanceBridge@${pluginVersion}`);
      const destinationEntry = path.join(destination, "lib", "plugin", "index.js");
      const destinationEntryHash = fs.existsSync(destinationEntry)
        ? crypto.createHash("sha256").update(fs.readFileSync(destinationEntry)).digest("hex")
        : "";
      if (!sourceEntryHash || sourceEntryHash !== destinationEntryHash) {
        fs.cpSync(sourceDir, destination, { recursive: true, force: true });
        updated = true;
      }

      const configPath = path.join(slot, "plugins.config.json");
      let config = { plugins: [] };
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch {}
      if (!Array.isArray(config.plugins)) config.plugins = [];
      const existing = config.plugins.find(item => item && item.name === "SeedanceBridge");
      if (existing) {
        if (existing.version !== pluginVersion || existing.loadOnStartup !== true) updated = true;
        existing.version = pluginVersion;
        existing.loadOnStartup = true;
      } else {
        config.plugins.push({ name: "SeedanceBridge", version: pluginVersion, loadOnStartup: true });
        updated = true;
      }
      if (updated || !fs.existsSync(configPath)) atomicWriteJsonWithBackup(configPath, config);
      destinations.push(destination);
    }
    return { ok: true, version: pluginVersion, updated, destinations };
  }

  locateXiangsu() {
    if (this.xiangsuExecutable && fs.existsSync(this.xiangsuExecutable)) return this.xiangsuExecutable;
    const candidates = [
      process.env.XIANGSU_EXE,
      path.join(process.env.LOCALAPPDATA || "", "Douyin AR", "Douyin AR.exe"),
      path.join(process.env.ProgramFiles || "", "Douyin AR", "Douyin AR.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "Douyin AR", "Douyin AR.exe")
    ].filter(Boolean);
    if (process.platform === "win32") {
      try {
        const registryScript = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
          + "$keys=@('Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Douyin AR',"
          + "'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Douyin AR',"
          + "'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Douyin AR');"
          + "foreach($key in $keys){try{$item=Get-ItemProperty -LiteralPath $key -ErrorAction Stop;if($item.DisplayIcon){$item.DisplayIcon};if($item.UninstallString){$item.UninstallString}}catch{}}";
        const query = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", registryScript], {
          windowsHide: true,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000
        });
        for (let executable of String(query.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
          executable = executable.replace(/^"|"$/g, "").replace(/,\s*\d+$/, "");
          if (/Uninstall\.exe$/i.test(executable)) executable = path.join(path.dirname(executable), "Douyin AR.exe");
          candidates.push(executable);
        }
      } catch {}
    }
    const found = candidates.find(candidate => fs.existsSync(candidate)) || null;
    if (found) this.xiangsuExecutable = found;
    return found;
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

module.exports = { BridgeClient, BRIDGE_ORIGIN, buildWindowHiderCommand, requestLocalBridge, safeRemoteTaskFilename };
