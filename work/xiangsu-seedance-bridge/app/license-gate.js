"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
// Pure transport helpers are also loaded by the MCP Node sidecar. Desktop
// services are resolved only when an actual licensing operation needs them.
const desktop = new Proxy({}, { get: (_target, key) => require("electron")[key] });

/** Unified PUREAM website authorization service. */
const DEFAULT_LICENSE_BASE_URL = "https://drama-slot.puream.cn";
const LEGACY_LICENSE_BASE_URL = "https://drama.puream.cn";
// Website-issued codes must use the short-drama authorization endpoint. It owns a
// separate device slot and never reads or writes the AI Creation Platform slot.
const PUREAM_WEBSITE_DESKTOP_LOGIN_URL = "https://puream.cn/api/drama/auth/login";
const PUREAM_WEBSITE_BASE_URL = "https://puream.cn";
const WEBSITE_SESSION_AUTHORITY = "puream-website";
const ADMIN_CONCURRENCY_AUTHORITY = "drama-admin";
const APP_ID = "puream-drama-slot-stats";
const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000;
const AUTO_RELOGIN_COOLDOWN_MS = 60 * 1000;
const TRUSTED_PERSISTED_LICENSE_ORIGINS = new Set([
  "https://drama.puream.cn",
  "https://drama-slot.puream.cn"
]);

// Device binding is an entitlement decision owned by the official website or
// the short-drama sidecar.  Keep the vocabulary deliberately small: a client
// may display the server's explicit policy, but must never infer administrator
// status from a local field such as concurrencyAuthority.
const DEVICE_BINDING_POLICY_BOUND = "bound";
const DEVICE_BINDING_POLICY_MULTI_DEVICE = "multi-device";

function normalizeDeviceBindingPolicy(value) {
  if (typeof value === "string") {
    const mode = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
    if (["unbound", "none", "unlimited", "multi-device", "multi-device-admin", "administrator-multi-device"].includes(mode)) {
      return DEVICE_BINDING_POLICY_MULTI_DEVICE;
    }
    if (["bound", "single", "device-bound", "single-device"].includes(mode)) return DEVICE_BINDING_POLICY_BOUND;
    return "";
  }
  if (!value || typeof value !== "object") return "";
  return normalizeDeviceBindingPolicy(
    value.mode
      || value.policy
      || value.binding
      || value.deviceBinding
      || value.device_binding
      || value.scope
      || ""
  );
}

function extractServerDeviceBinding(data) {
  const sources = [
    data,
    data?.account,
    data?.entitlement,
    data?.administratorEntitlement,
    data?.administrator_entitlement
  ].filter(item => item && typeof item === "object");
  for (const source of sources) {
    const raw = source.deviceBindingPolicy
      ?? source.device_binding_policy
      ?? source.devicePolicy
      ?? source.device_policy;
    const policy = normalizeDeviceBindingPolicy(raw);
    if (policy) {
      return {
        policy,
        administrator: policy === DEVICE_BINDING_POLICY_MULTI_DEVICE
          && (source.administrator === true
            || source.isAdministrator === true
            || source.role === "administrator"
            || source.role === "admin"
            || source.type === "administrator"
            || source.kind === "administrator")
      };
    }
  }
  return { policy: "", administrator: false };
}

function normalizeAuthorizationCode(value) {
  const code = String(value || "").replace(/[\s-]+/g, "").trim().toUpperCase();
  return /^[A-Z0-9]{12,64}$/.test(code) ? code : "";
}

function trustedPersistedLicenseBaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.username || url.password || url.port || url.search || url.hash || (url.pathname && url.pathname !== "/")) return "";
    if (url.protocol !== "https:" || !TRUSTED_PERSISTED_LICENSE_ORIGINS.has(url.origin)) return "";
    // Existing installs may have persisted the retired host. Migrate them to the
    // unified service instead of keeping the old split backend forever.
    return url.origin === LEGACY_LICENSE_BASE_URL ? DEFAULT_LICENSE_BASE_URL : url.origin;
  } catch {
    return "";
  }
}

function licenseBypassAllowed() {
  if (process.env.DRAMA_LICENSE_BYPASS !== "1") return false;
  // Never honor bypass in packaged release builds.
  try {
    if (desktop.app?.isPackaged) return false;
  } catch {
    /* app may be unavailable in unit tests */
  }
  return true;
}

function getMachineId() {
  let seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.cpus()[0]?.model || ""}`;
  try {
    if (process.platform === "win32") {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000
      });
      const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      if (match?.[1]) seed = match[1];
    }
  } catch {
    /* fall back to hostname seed */
  }
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function licenseStatePath() {
  return path.join(desktop.app.getPath("userData"), "drama-license.json");
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

function encryptSecret(plain) {
  const text = String(plain || "");
  if (!text) return "";
  try {
    if (desktop.safeStorage?.isEncryptionAvailable?.()) {
      return `safe:${desktop.safeStorage.encryptString(text).toString("base64")}`;
    }
  } catch (error) {
    throw Object.assign(new Error("系统安全存储不可用，授权码未保存"), { code: "SECRET_STORAGE_UNAVAILABLE", cause: error });
  }
  throw Object.assign(new Error("系统安全存储不可用，授权码未保存"), { code: "SECRET_STORAGE_UNAVAILABLE" });
}

function decryptSecret(stored) {
  const raw = String(stored || "");
  if (!raw) return "";
  try {
    if (raw.startsWith("safe:")) {
      if (!desktop.safeStorage?.isEncryptionAvailable?.()) return "";
      return desktop.safeStorage.decryptString(Buffer.from(raw.slice(5), "base64"));
    }
    if (raw.startsWith("b64:")) return Buffer.from(raw.slice(4), "base64").toString("utf8");
    // Legacy plaintext token
    return raw;
  } catch {
    return "";
  }
}

function decodeLicenseState(parsed) {
  if (parsed.tokenEnc || parsed.token) parsed.token = decryptSecret(parsed.tokenEnc || parsed.token);
  if (parsed.activationCodeEnc) parsed.activationCode = decryptSecret(parsed.activationCodeEnc);
  return parsed;
}

function readLicenseState() {
  const filePath = licenseStatePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return decodeLicenseState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (primaryError) {
    const backupPath = `${filePath}.bak`;
    let recoveryTemporary = "";
    try {
      const rawBackup = fs.readFileSync(backupPath, "utf8");
      const recovered = JSON.parse(rawBackup);
      recoveryTemporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.recovery`;
      fs.writeFileSync(recoveryTemporary, rawBackup, { encoding: "utf8", mode: 0o600 });
      replaceFileWithRetries(recoveryTemporary, filePath);
      recoveryTemporary = "";
      return decodeLicenseState(recovered);
    } catch (backupError) {
      try { if (recoveryTemporary && fs.existsSync(recoveryTemporary)) fs.unlinkSync(recoveryTemporary); } catch {}
      console.error("[license] activation state is corrupted and no valid backup is available", primaryError?.message, backupError?.message);
      return { storageCorrupted: true };
    }
  }
}

function writeLicenseState(next) {
  const filePath = licenseStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const { token, activationCode, ...rest } = next || {};
  const persisted = {
    ...rest,
    tokenEnc: token ? encryptSecret(token) : "",
    activationCodeEnc: activationCode ? encryptSecret(activationCode) : ""
  };
  delete persisted.token;
  delete persisted.activationCode;
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
        console.warn(`[license] skipped invalid activation-state backup: ${error?.message || error}`);
      }
    }
    replaceFileWithRetries(tmp, filePath);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return { ...rest, token: token || "", activationCode: activationCode || "" };
}

class DramaLicenseClient {
  constructor(options = {}) {
    this.state = typeof options.stateReader === "function" ? (options.stateReader() || {}) : readLicenseState();
    this.stateWriter = typeof options.stateWriter === "function" ? options.stateWriter : writeLicenseState;
    const explicitBaseUrl = options.baseUrl || process.env.DRAMA_LICENSE_BASE_URL || "";
    // Authorization, device binding and concurrency are server-side security
    // boundaries. Never let a packaged-process environment variable (or a
    // tampered persisted file) redirect those requests to an attacker-owned
    // server that can mint fake sessions and leases. Tests may still pass one
    // of the two official origins and mock the transport itself.
    this.baseUrl = String(
      trustedPersistedLicenseBaseUrl(explicitBaseUrl)
      || trustedPersistedLicenseBaseUrl(this.state.baseUrl)
      || DEFAULT_LICENSE_BASE_URL
    ).replace(/\/$/, "");
    this.heartbeatTimer = null;
    this.leaseHeartbeats = new Map();
    this.offlineLeases = new Map();
    this.pendingCosts = Array.isArray(this.state.pendingCosts)
      ? this.state.pendingCosts.slice(-200)
      : [];
    this.pendingCostKeys = new Set(this.pendingCosts.map(item => this.pendingCostKey(item)));
    this.autoReloginPromise = null;
    this.lastAutoReloginAt = 0;
    this.leaseRetrySleep = typeof options.leaseRetrySleep === "function"
      ? options.leaseRetrySleep
      : ms => new Promise(resolve => setTimeout(resolve, ms));
  }

  machineId() {
    return getMachineId();
  }

  getSnapshot() {
    const lastOk = Date.parse(this.state.lastHeartbeatOkAt || this.state.activatedAt || 0);
    const graceRemainingMs = Number.isFinite(lastOk)
      ? Math.max(0, lastOk + OFFLINE_GRACE_MS - Date.now())
      : 0;
    return {
      activated: Boolean(this.state.token && this.state.activationCode),
      activationCode: this.state.activationCode || "",
      phone: this.state.phone || "",
      name: this.state.name || "",
      machineId: getMachineId(),
      imageConcurrency: Number(this.state.imageConcurrency || 0),
      videoConcurrency: Number(this.state.videoConcurrency || 0),
      distributorId: this.state.distributorId || "",
      entitlementProduct: this.state.entitlementProduct || APP_ID,
      sessionAuthority: this.state.sessionAuthority || "drama-admin",
      concurrencyAuthority: this.state.concurrencyAuthority || "",
      // Informational only. This value is copied from the last server response;
      // it is never used to bypass storedStateMatchesMachine or lease checks.
      deviceBindingPolicy: this.state.deviceBindingPolicy || "",
      administratorEntitled: this.state.administratorEntitled === true,
      appId: APP_ID,
      baseUrl: this.baseUrl,
      offlineGrace: Boolean(this.state.offlineGrace),
      offlineGraceRemainingMs: graceRemainingMs,
      lastHeartbeatOkAt: this.state.lastHeartbeatOkAt || "",
      storageCorrupted: this.state.storageCorrupted === true
    };
  }

  validOfflineGraceSnapshot(kind = "") {
    const snapshot = this.getSnapshot();
    if (!snapshot.activated || !snapshot.offlineGrace || snapshot.offlineGraceRemainingMs <= 0) return null;
    if (kind) {
      const limit = Number(kind === "image" ? snapshot.imageConcurrency : snapshot.videoConcurrency);
      if (!Number.isFinite(limit) || limit < 1) return null;
    }
    return snapshot;
  }

  saveState(next) {
    this.state = this.stateWriter(next);
    return this.state;
  }

  storedActivationCode() {
    return normalizeAuthorizationCode(this.state.activationCode);
  }

  storedStateMatchesMachine() {
    const storedMachineId = String(this.state.machineId || "").trim();
    // Legacy states did not persist machineId; /api/auth/login remains the authoritative
    // device-binding check because it always receives the current machineId. Do
    // not special-case a persisted administrator/device policy here: the local
    // JSON is user-controlled and can be tampered with between launches.
    return !storedMachineId || storedMachineId === getMachineId();
  }

  canAutoRelogin() {
    return Boolean(
      this.storedActivationCode()
      && this.storedStateMatchesMachine()
      && this.state.autoReloginBlocked !== true
    );
  }

  async autoRelogin(triggerError) {
    if (!this.canAutoRelogin()) throw triggerError;
    if (this.autoReloginPromise) return this.autoReloginPromise;
    if (Date.now() - this.lastAutoReloginAt < AUTO_RELOGIN_COOLDOWN_MS) throw triggerError;
    const code = this.storedActivationCode();
    this.lastAutoReloginAt = Date.now();
    const attempt = (async () => {
      try {
        return this.state.sessionAuthority === WEBSITE_SESSION_AUTHORITY
          ? await this.loginWithPureamWebsite(code)
          : await this.login(code);
      } catch (error) {
        const block = ["INVALID_CODE", "DEVICE_BOUND", "USER_DISABLED"].includes(String(error?.code || ""));
        try {
          this.clearLocalSession(false, { autoReloginBlocked: block });
        } catch (clearError) {
          console.warn("[license] failed to clear rejected session", clearError?.message || clearError);
        }
        throw error;
      }
    })();
    this.autoReloginPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (this.autoReloginPromise === attempt) this.autoReloginPromise = null;
    }
  }

  enterOfflineGrace(error) {
    const lastOk = Date.parse(this.state.lastHeartbeatOkAt || this.state.activatedAt || 0);
    if (this.state.token && this.state.activationCode && Number.isFinite(lastOk) && Date.now() - lastOk < OFFLINE_GRACE_MS) {
      if (!this.state.offlineGrace) {
        this.saveState({ ...this.state, offlineGrace: true });
      }
      return this.getSnapshot();
    }
    throw Object.assign(
      new Error("授权服务器暂时不可达，且本地离线宽限期已过。请联网后重试。"),
      { code: "LICENSE_OFFLINE_EXPIRED", cause: error }
    );
  }

  async request(pathname, { method = "GET", body, token } = {}) {
    const headers = { "content-type": "application/json", accept: "application/json" };
    const auth = token || this.state.token;
    if (auth) headers.authorization = `Bearer ${auth}`;
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw Object.assign(new Error(`无法连接授权服务器：${error.message || "网络错误"}`), { code: "LICENSE_OFFLINE" });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      if ([408, 425, 500, 502, 503, 504].includes(Number(res.status))) {
        throw Object.assign(new Error("授权与并发服务暂时不可达，软件将沿用本机有效授权宽限"), {
          code: "LICENSE_OFFLINE",
          status: res.status,
          data
        });
      }
      throw Object.assign(new Error(data.message || data.error || `授权失败 HTTP ${res.status}`), {
        code: data.code || "LICENSE_ERROR",
        status: res.status,
        data
      });
    }
    return data;
  }

  async websiteRequest(pathname, { method = "GET", body } = {}) {
    const activationCode = this.storedActivationCode();
    if (!activationCode) throw Object.assign(new Error("请先激活纯梦账号"), { code: "PUREAM_AUTH_REQUIRED" });
    let res;
    try {
      res = await fetch(`${PUREAM_WEBSITE_BASE_URL}${pathname}`, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer puream-desktop:${activationCode}`
        },
        body: body == null ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw Object.assign(new Error("官网账户服务正在自动重连"), { code: "PUREAM_ACCOUNT_OFFLINE", cause: error });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok === false) {
      throw Object.assign(new Error(payload.message || payload.error || `官网账户请求失败 HTTP ${res.status}`), {
        code: payload.code || "PUREAM_ACCOUNT_ERROR",
        status: res.status
      });
    }
    return payload.data && typeof payload.data === "object" ? payload.data : payload;
  }

  async walletStatus() {
    return this.websiteRequest("/api/desktop/account/balance");
  }

  async createRechargeOrder(amountYuan) {
    const rechargeCents = Math.round(Number(amountYuan) * 100);
    if (!Number.isFinite(rechargeCents) || rechargeCents < 5000) {
      throw Object.assign(new Error("软件内充值金额最低 50 元；官网充值仍为 30 元起"), { code: "RECHARGE_AMOUNT_INVALID" });
    }
    return this.websiteRequest("/api/desktop/payments/create", { method: "POST", body: { rechargeCents } });
  }

  async rechargeOrderStatus(orderNo) {
    const safeOrderNo = String(orderNo || "").trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(safeOrderNo)) {
      throw Object.assign(new Error("充值订单号无效"), { code: "RECHARGE_ORDER_INVALID" });
    }
    return this.websiteRequest(`/api/desktop/payments/${encodeURIComponent(safeOrderNo)}/status`);
  }

  async loginWithPureamWebsite(activationCode) {
    const code = normalizeAuthorizationCode(activationCode);
    let res;
    try {
      res = await fetch(PUREAM_WEBSITE_DESKTOP_LOGIN_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ activationCode: code, machineId: getMachineId() })
      });
    } catch (error) {
      throw Object.assign(new Error(`无法连接纯梦官网授权服务：${error.message || "网络错误"}`), { code: "LICENSE_OFFLINE" });
    }
    const response = await res.json().catch(() => ({}));
    if (!res.ok || response.ok === false) {
      if ([408, 425, 500, 502, 503, 504].includes(Number(res.status))) {
        throw Object.assign(new Error("纯梦官网授权服务暂时不可达，软件将沿用本机有效授权宽限"), {
          code: "LICENSE_OFFLINE",
          status: res.status,
          data: response
        });
      }
      throw Object.assign(new Error(response.message || response.error || `纯梦官网授权失败 HTTP ${res.status}`), {
        code: response.code || "INVALID_CODE",
        status: res.status,
        data: response
      });
    }
    const data = response.data && typeof response.data === "object" ? response.data : response;
    const websiteDeviceBinding = extractServerDeviceBinding(data);
    const canonicalCode = normalizeAuthorizationCode(
      data.pureamAuthorizationCode || data.authorizationCode || data.activationCode || code
    );
    if (!canonicalCode) {
      throw Object.assign(new Error("纯梦官网返回了无效的授权码"), { code: "INVALID_SERVER_CODE" });
    }
    let concurrencySession;
    try {
      // The website owns membership and device binding, while the short-drama
      // admin service is the sole authority for per-account image/video leases.
      // Never create a local proof token here: every generation path must hold a
      // real server-issued lease that reflects the current admin values.
      concurrencySession = await this.request("/api/auth/login", {
        method: "POST",
        body: { activationCode: canonicalCode, machineId: getMachineId() }
      });
    } catch (error) {
      if (error?.code === "LICENSE_OFFLINE") {
        throw Object.assign(
          new Error("用户并发控制服务暂时不可用，已停止新的生图和视频任务，请稍后重试"),
          { code: "CONCURRENCY_AUTHORITY_OFFLINE", cause: error }
        );
      }
      throw error;
    }
    const imageConcurrency = Math.floor(Number(concurrencySession.imageConcurrency));
    const videoConcurrency = Math.floor(Number(concurrencySession.videoConcurrency));
    if (!concurrencySession.token || imageConcurrency < 1 || videoConcurrency < 1) {
      throw Object.assign(
        new Error("管理后台没有返回有效的用户并发额度，已停止新的生成任务"),
        { code: "CONCURRENCY_AUTHORITY_INVALID" }
      );
    }
    const sidecarDeviceBinding = extractServerDeviceBinding(concurrencySession);
    // Prefer the sidecar's fresh entitlement response. The website response is
    // retained as a fallback because the two official services may roll out the
    // same policy at slightly different times. Neither value is used as a local
    // authorization bypass; it is only surfaced as server-issued metadata.
    const serverDeviceBinding = sidecarDeviceBinding.policy
      ? sidecarDeviceBinding
      : websiteDeviceBinding;
    const now = new Date().toISOString();
    this.saveState({
      token: concurrencySession.token,
      activationCode: canonicalCode,
      machineId: getMachineId(),
      phone: concurrencySession.phone || data.phone || data.account?.phone || "",
      name: concurrencySession.name || data.name || data.account?.name || "",
      imageConcurrency,
      videoConcurrency,
      distributorId: data.distributorId || data.referrerId || data.referralId || "",
      entitlementProduct: data.entitlementProduct || data.planId || "puream-website",
      sessionAuthority: WEBSITE_SESSION_AUTHORITY,
      concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY,
      deviceBindingPolicy: serverDeviceBinding.policy,
      administratorEntitled: serverDeviceBinding.administrator === true,
      activatedAt: now,
      lastHeartbeatOkAt: now,
      offlineGrace: false,
      autoReloginBlocked: false,
      pendingCosts: this.pendingCosts,
      baseUrl: this.baseUrl
    });
    this.startHeartbeat();
    return this.getSnapshot();
  }

  async login(activationCode) {
    const code = normalizeAuthorizationCode(activationCode);
    if (!code) {
      throw Object.assign(new Error("请输入纯梦官网发放的授权码"), { code: "INVALID_CODE" });
    }
    let data;
    try {
      data = await this.request("/api/auth/login", {
        method: "POST",
        body: { activationCode: code, machineId: getMachineId() }
      });
    } catch (error) {
      // The short-drama admin still issues legacy 32-character codes. Official
      // website member codes have a different length and must be authenticated by
      // the website's desktop endpoint, not rejected or converted locally.
      if (String(error?.code || "") === "INVALID_CODE" && code.length !== 32) {
        return this.loginWithPureamWebsite(code);
      }
      throw error;
    }
    const canonicalCode = normalizeAuthorizationCode(data.pureamAuthorizationCode || data.activationCode || code);
    if (!canonicalCode) {
      throw Object.assign(new Error("授权服务器返回了无效的纯梦授权码"), { code: "INVALID_SERVER_CODE" });
    }
    const imageConcurrency = Math.floor(Number(data.imageConcurrency));
    const videoConcurrency = Math.floor(Number(data.videoConcurrency));
    if (!data.token || imageConcurrency < 1 || videoConcurrency < 1) {
      throw Object.assign(
        new Error("管理后台没有返回有效的用户并发额度，已停止新的生成任务"),
        { code: "CONCURRENCY_AUTHORITY_INVALID" }
      );
    }
    const websiteAccount = String(data.credentialSource || "").toUpperCase() === "PUREAM_WEBSITE";
    const serverDeviceBinding = extractServerDeviceBinding(data);
    this.saveState({
      token: data.token,
      activationCode: canonicalCode,
      machineId: getMachineId(),
      phone: data.phone || "",
      name: data.name || "",
      imageConcurrency,
      videoConcurrency,
      distributorId: data.distributorId || data.referrerId || data.referralId || "",
      entitlementProduct: data.entitlementProduct || APP_ID,
      sessionAuthority: websiteAccount ? WEBSITE_SESSION_AUTHORITY : ADMIN_CONCURRENCY_AUTHORITY,
      concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY,
      deviceBindingPolicy: serverDeviceBinding.policy,
      administratorEntitled: serverDeviceBinding.administrator === true,
      activatedAt: new Date().toISOString(),
      lastHeartbeatOkAt: new Date().toISOString(),
      offlineGrace: false,
      autoReloginBlocked: false,
      pendingCosts: this.pendingCosts,
      baseUrl: this.baseUrl
    });
    this.startHeartbeat();
    void this.flushPendingCosts();
    return this.getSnapshot();
  }

  async ensureSession() {
    if (licenseBypassAllowed()) {
      return { ...this.getSnapshot(), activated: true, bypass: true };
    }
    if (this.state.storageCorrupted === true) {
      throw Object.assign(new Error("本机授权记录已损坏且没有有效备份。旧文件已保留，请重新输入授权码激活。"), { code: "LICENSE_STATE_CORRUPTED" });
    }
    if (!this.state.token) {
      const error = Object.assign(new Error("请先输入授权码激活应用"), { code: "NEED_ACTIVATION" });
      if (this.canAutoRelogin()) return this.autoRelogin(error);
      throw error;
    }
    if (this.state.sessionAuthority === WEBSITE_SESSION_AUTHORITY) {
      const hasRealConcurrencySession = !String(this.state.token || "").startsWith("website:")
        && this.state.concurrencyAuthority === ADMIN_CONCURRENCY_AUTHORITY
        && Number(this.state.imageConcurrency) >= 1
        && Number(this.state.videoConcurrency) >= 1;
      if (!hasRealConcurrencySession) {
        return this.loginWithPureamWebsite(this.storedActivationCode());
      }
      const lastOk = Date.parse(this.state.lastHeartbeatOkAt || 0);
      if (Number.isFinite(lastOk) && Date.now() - lastOk < 4 * 60_000) {
        this.startHeartbeat();
        return this.getSnapshot();
      }
      try {
        return await this.loginWithPureamWebsite(this.storedActivationCode());
      } catch (error) {
        if (["LICENSE_OFFLINE", "CONCURRENCY_AUTHORITY_OFFLINE"].includes(String(error.code || ""))) return this.enterOfflineGrace(error);
        if (["INVALID_CODE", "DEVICE_BOUND", "USER_DISABLED", "SUBSCRIPTION_EXPIRED"].includes(String(error.code || ""))) {
          this.clearLocalSession(false, { autoReloginBlocked: true });
        }
        throw error;
      }
    }
    try {
      const data = await this.request("/api/auth/heartbeat", { method: "POST", body: {} });
      if (data.account) {
        this.saveState({
          ...this.state,
          machineId: getMachineId(),
          phone: data.account.phone,
          name: data.account.name,
          imageConcurrency: data.account.imageConcurrency,
          videoConcurrency: data.account.videoConcurrency,
          lastHeartbeatOkAt: new Date().toISOString(),
          offlineGrace: false
        });
      } else {
        this.saveState({
          ...this.state,
          machineId: getMachineId(),
          lastHeartbeatOkAt: new Date().toISOString(),
          offlineGrace: false
        });
      }
      this.startHeartbeat();
      void this.flushPendingCosts();
      return this.getSnapshot();
    } catch (error) {
      if (error.code === "DEVICE_BOUND" || error.code === "USER_DISABLED") {
        this.clearLocalSession(false, { autoReloginBlocked: true });
        throw error;
      }
      if (error.code === "SESSION_EXPIRED" || error.code === "UNAUTHORIZED") {
        if (this.canAutoRelogin()) return this.autoRelogin(error);
        this.clearLocalSession(false);
        throw error;
      }
      if (error.code === "LICENSE_OFFLINE") {
        return this.enterOfflineGrace(error);
      }
      throw error;
    }
  }

  clearLocalSession(wipeCode = true, retained = {}) {
    this.stopHeartbeat();
    for (const timer of this.leaseHeartbeats.values()) clearInterval(timer);
    this.leaseHeartbeats.clear();
    this.offlineLeases.clear();
    this.saveState(wipeCode ? {} : {
      activationCode: this.state.activationCode || "",
      machineId: this.state.machineId || getMachineId(),
      autoReloginBlocked: retained.autoReloginBlocked === true,
      pendingCosts: this.pendingCosts,
      baseUrl: this.baseUrl
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.ensureSession().catch((error) => {
        if (error?.code && !String(error.code).includes("OFFLINE")) {
          console.warn("[license] heartbeat failed", error.code, error.message);
        }
      });
    }, 5 * 60_000);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async waitForLeaseRetry(milliseconds, signal = null) {
    if (!signal) return this.leaseRetrySleep(milliseconds);
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("生产任务已取消"), { code: "LEASE_ACQUIRE_ABORTED" });
    }
    let abortListener;
    try {
      await Promise.race([
        Promise.resolve(this.leaseRetrySleep(milliseconds)),
        new Promise((_, reject) => {
          abortListener = () => reject(signal.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error("生产任务已取消"), { code: "LEASE_ACQUIRE_ABORTED" }));
          signal.addEventListener("abort", abortListener, { once: true });
        })
      ]);
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  async acquireLease(kind, taskId, meta = {}, options = {}) {
    const normalizedKind = String(kind || "").trim().toLowerCase();
    if (!["image", "video"].includes(normalizedKind)) {
      throw Object.assign(new Error("kind 必须是 image 或 video"), { code: "BAD_KIND" });
    }
    const session = await this.ensureSession();
    if (session.offlineGrace) {
      throw Object.assign(
        new Error("管理后台并发控制服务离线，已停止新的生图和视频任务，请联网后重试"),
        { code: "CONCURRENCY_AUTHORITY_OFFLINE" }
      );
    }
    let transportFailures = 0;
    const signal = options?.signal || null;
    // The administrator owns concurrency, but a queue position is not a
    // failure.  Production work has no wall-clock deadline: keep the same
    // task/idempotency key queued until a slot opens or the user explicitly
    // pauses/stops the operation.
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("生产任务已取消"), { code: "LEASE_ACQUIRE_ABORTED" });
      }
      try {
        const data = await this.request("/api/lease/acquire", {
          method: "POST",
          body: { kind: normalizedKind, taskId, meta }
        });
        const leaseId = data.leaseId;
        const timer = setInterval(() => {
          this.request("/api/lease/heartbeat", { method: "POST", body: { leaseId } }).catch(() => {});
        }, 60_000);
        if (typeof timer.unref === "function") timer.unref();
        this.leaseHeartbeats.set(leaseId, timer);
        return data;
      } catch (error) {
        if (error.code === "LICENSE_OFFLINE") {
          transportFailures += 1;
          await this.waitForLeaseRetry(Math.min(30_000, transportFailures * 1000), signal);
          continue;
        }
        if (["SESSION_EXPIRED", "UNAUTHORIZED"].includes(String(error.code || ""))) {
          await this.autoRelogin(error);
          transportFailures = 0;
          continue;
        }
        if (error.code !== "QUEUE" && error.status !== 429) throw error;
        await this.waitForLeaseRetry(2500, signal);
      }
    }
  }

  async acquireOfflineLease(kind, taskId, meta = {}) {
    void kind;
    void taskId;
    void meta;
    throw Object.assign(
      new Error("管理后台并发控制服务离线，已停止新的生图和视频任务，请联网后重试"),
      { code: "CONCURRENCY_AUTHORITY_OFFLINE" }
    );
  }

  async releaseLease(leaseId, taskId) {
    if (leaseId && this.offlineLeases.has(leaseId)) {
      this.offlineLeases.delete(leaseId);
      return { released: true, leaseId, taskId, offlineGrace: true };
    }
    if (leaseId && this.leaseHeartbeats.has(leaseId)) {
      clearInterval(this.leaseHeartbeats.get(leaseId));
      this.leaseHeartbeats.delete(leaseId);
    }
    try {
      await this.request("/api/lease/release", {
        method: "POST",
        body: { leaseId, taskId }
      });
    } catch {
      // best-effort release
    }
  }

  async reportCost(amountYuan, kind, taskId, meta = {}) {
    const amount = Number(amountYuan || 0);
    if (!Number.isFinite(amount) || amount <= 0 || !this.state.token) {
      return { ok: false, skipped: true };
    }
    if (this.state.sessionAuthority === WEBSITE_SESSION_AUTHORITY) {
      return { ok: true, serverRecorded: true, authority: WEBSITE_SESSION_AUTHORITY };
    }
    const payload = { amountYuan: amount, kind, taskId, meta, queuedAt: new Date().toISOString() };
    if (this.validOfflineGraceSnapshot()) {
      this.enqueuePendingCost(payload);
      return { ok: false, pending: true, code: "LICENSE_OFFLINE", message: "离线宽限期内，费用上报已排队" };
    }
    try {
      const result = await this.request("/api/telemetry/cost", {
        method: "POST",
        body: { amountYuan: amount, kind, taskId, meta }
      });
      return { ok: true, result };
    } catch (error) {
      this.enqueuePendingCost(payload);
      return { ok: false, pending: true, code: error.code || "COST_REPORT_FAILED", message: error.message };
    }
  }

  pendingCostKey(item = {}) {
    const meta = item.meta || {};
    return [
      String(item.kind || ""),
      String(item.taskId || ""),
      String(Number(item.amountYuan || 0)),
      String(meta.projectId || ""),
      String(meta.operation || ""),
      String(meta.entityId || "")
    ].join("|");
  }

  persistPendingCosts() {
    try {
      this.saveState({ ...this.state, pendingCosts: this.pendingCosts });
    } catch {
      // In-memory queue remains authoritative until persistence is available.
    }
  }

  enqueuePendingCost(payload) {
    const key = this.pendingCostKey(payload);
    if (this.pendingCostKeys.has(key)) return false;
    this.pendingCosts.push({ ...payload, reportKey: key });
    this.pendingCostKeys.add(key);
    while (this.pendingCosts.length > 200) {
      const removed = this.pendingCosts.shift();
      this.pendingCostKeys.delete(removed?.reportKey || this.pendingCostKey(removed));
    }
    this.persistPendingCosts();
    return true;
  }

  async flushPendingCosts() {
    if (!this.pendingCosts.length || !this.state.token) return;
    const queue = this.pendingCosts.splice(0, this.pendingCosts.length);
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      try {
        await this.request("/api/telemetry/cost", {
          method: "POST",
          body: {
            amountYuan: item.amountYuan,
            kind: item.kind,
            taskId: item.taskId,
            meta: { ...(item.meta || {}), flushedFromPending: true, queuedAt: item.queuedAt }
          }
        });
        this.pendingCostKeys.delete(item.reportKey || this.pendingCostKey(item));
      } catch {
        this.pendingCosts = [...queue.slice(index), ...this.pendingCosts];
        break;
      }
    }
    this.persistPendingCosts();
  }
}

module.exports = {
  DramaLicenseClient,
  getMachineId,
  normalizeAuthorizationCode,
  licenseBypassAllowed,
  APP_ID,
  DEFAULT_LICENSE_BASE_URL,
  PUREAM_WEBSITE_DESKTOP_LOGIN_URL,
  WEBSITE_SESSION_AUTHORITY,
  ADMIN_CONCURRENCY_AUTHORITY,
  DEVICE_BINDING_POLICY_BOUND,
  DEVICE_BINDING_POLICY_MULTI_DEVICE,
  normalizeDeviceBindingPolicy,
  extractServerDeviceBinding,
  OFFLINE_GRACE_MS
};
