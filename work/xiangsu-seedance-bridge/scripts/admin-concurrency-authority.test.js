"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DramaLicenseClient,
  ADMIN_CONCURRENCY_AUTHORITY,
  WEBSITE_SESSION_AUTHORITY,
  PUREAM_WEBSITE_DESKTOP_LOGIN_URL,
  OFFLINE_GRACE_MS
} = require("../app/license-gate");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createStateStore(initial = {}) {
  let state = { ...initial };
  return {
    read: () => ({ ...state }),
    write: next => {
      state = { ...next };
      return { ...state };
    },
    snapshot: () => ({ ...state })
  };
}

test("官网确认管理员身份后客户端不再施加图片或视频批次并发上限", async () => {
  const workflow = new WorkbenchWorkflow({
    store: {},
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    licenseClient: {
      ensureSession: async () => ({
        administratorEntitled: true,
        imageConcurrency: 32,
        videoConcurrency: 16,
        concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY
      })
    }
  });
  const authority = await workflow.authoritativeGenerationConcurrency({ generation: {} });
  assert.equal(authority.unbounded, true);
  assert.equal(authority.source, "admin_license");
});

test("官网授权必须换取管理后台真实令牌并使用服务端租约", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const baseUrl = "https://drama-slot.puream.cn";
  const store = createStateStore();
  const calls = [];
  let limits = { image: 2, video: 1 };
  let activeVideo = 0;

  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url: String(url), pathname, body, authorization: options.headers?.authorization || "" });
    if (String(url) === PUREAM_WEBSITE_DESKTOP_LOGIN_URL) {
      return jsonResponse(200, {
        ok: true,
        data: {
          pureamAuthorizationCode: "ABCDEF0123456789",
          phone: "15100000001",
          name: "官网用户",
          entitlementProduct: "drama-monthly",
          imageConcurrency: limits.image,
          videoConcurrency: limits.video,
          concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY
        }
      });
    }
    if (pathname === "/api/auth/login") {
      return jsonResponse(200, {
        ok: true,
        token: "server-issued-admin-token",
        pureamAuthorizationCode: body.activationCode,
        phone: "15100000001",
        name: "官网用户",
        credentialSource: "PUREAM_WEBSITE",
        imageConcurrency: limits.image,
        videoConcurrency: limits.video
      });
    }
    if (pathname === "/api/lease/acquire") {
      assert.equal(options.headers.authorization, "Bearer server-issued-admin-token");
      if (body.kind === "video" && activeVideo >= limits.video) {
        return jsonResponse(429, { ok: false, code: "QUEUE", message: "已达生视频并发上限", limit: limits.video });
      }
      if (body.kind === "video") activeVideo += 1;
      return jsonResponse(200, {
        ok: true,
        leaseId: `lease-${body.kind}-${body.taskId}`,
        taskId: body.taskId,
        kind: body.kind,
        limit: limits[body.kind]
      });
    }
    if (pathname === "/api/lease/release") {
      activeVideo = Math.max(0, activeVideo - 1);
      return jsonResponse(200, { ok: true, released: true, leaseId: body.leaseId });
    }
    if (pathname === "/api/auth/heartbeat") {
      return jsonResponse(200, {
        ok: true,
        account: { phone: "15100000001", name: "官网用户", imageConcurrency: limits.image, videoConcurrency: limits.video }
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const client = new DramaLicenseClient({
    baseUrl,
    stateReader: store.read,
    stateWriter: store.write,
    leaseRetrySleep: async () => {}
  });
  t.after(() => client.stopHeartbeat());

  const snapshot = await client.loginWithPureamWebsite("ABCDEF0123456789");
  assert.equal(snapshot.activated, true);
  assert.equal(snapshot.sessionAuthority, WEBSITE_SESSION_AUTHORITY);
  assert.equal(snapshot.concurrencyAuthority, ADMIN_CONCURRENCY_AUTHORITY);
  assert.equal(snapshot.imageConcurrency, 2);
  assert.equal(snapshot.videoConcurrency, 1);
  assert.equal(store.snapshot().token, "server-issued-admin-token");
  assert.doesNotMatch(store.snapshot().token, /^website:/);

  const lease = await client.acquireLease("video", "project-a-video-001", { projectId: "project-a" });
  assert.equal(lease.leaseId, "lease-video-project-a-video-001");
  assert.equal(lease.limit, 1);
  assert.ok(calls.some(item => item.pathname === "/api/lease/acquire" && item.body.taskId === "project-a-video-001"));
  await client.releaseLease(lease.leaseId, "project-a-video-001");
});

test("升级旧官网假令牌后，管理后台暂不可达会无限等待同一租约直至用户取消", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const store = createStateStore({
    token: "website:legacy-local-proof",
    activationCode: "ABCDEF0123456789",
    machineId: "",
    imageConcurrency: 0,
    videoConcurrency: 0,
    sessionAuthority: WEBSITE_SESSION_AUTHORITY,
    activatedAt: new Date().toISOString(),
    lastHeartbeatOkAt: new Date().toISOString()
  });
  let leaseTransportFailures = 0;
  const controller = new AbortController();

  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (String(url) === PUREAM_WEBSITE_DESKTOP_LOGIN_URL) {
      return jsonResponse(200, { ok: true, data: { pureamAuthorizationCode: "ABCDEF0123456789" } });
    }
    if (pathname === "/api/auth/login") {
      return jsonResponse(200, {
        ok: true,
        token: "migrated-server-token",
        pureamAuthorizationCode: body.activationCode,
        credentialSource: "PUREAM_WEBSITE",
        imageConcurrency: 3,
        videoConcurrency: 2
      });
    }
    if (pathname === "/api/lease/acquire") {
      leaseTransportFailures += 1;
      if (leaseTransportFailures === 4) {
        controller.abort(Object.assign(new Error("用户暂停生产"), { code: "SCRIPT_GENERATION_PAUSED" }));
      }
      throw new Error("simulated transport outage");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write,
    leaseRetrySleep: async () => {}
  });
  t.after(() => client.stopHeartbeat());
  const migrated = await client.ensureSession();
  assert.equal(migrated.concurrencyAuthority, ADMIN_CONCURRENCY_AUTHORITY);
  assert.equal(migrated.imageConcurrency, 3);
  assert.equal(migrated.videoConcurrency, 2);
  assert.equal(store.snapshot().token, "migrated-server-token");

  await assert.rejects(
    () => client.acquireLease("image", "project-c-image-001", { projectId: "project-c" }, { signal: controller.signal }),
    error => error?.code === "SCRIPT_GENERATION_PAUSED"
  );
  assert.equal(leaseTransportFailures, 4);
  assert.equal(client.offlineLeases.size, 0);
});

test("服务端并发队列没有总时长上限并复用同一任务编号", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const store = createStateStore({
    token: "server-issued-admin-token",
    activationCode: "ABCDEF0123456789",
    machineId: "",
    imageConcurrency: 2,
    videoConcurrency: 1,
    sessionAuthority: WEBSITE_SESSION_AUTHORITY,
    concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY,
    activatedAt: new Date().toISOString(),
    lastHeartbeatOkAt: new Date().toISOString()
  });
  const taskIds = [];
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (pathname === "/api/auth/heartbeat") {
      return jsonResponse(200, { ok: true, account: { imageConcurrency: 2, videoConcurrency: 1 } });
    }
    if (pathname === "/api/lease/acquire") {
      taskIds.push(body.taskId);
      if (taskIds.length < 7) return jsonResponse(429, { ok: false, code: "QUEUE", message: "排队中" });
      return jsonResponse(200, { ok: true, leaseId: "lease-after-unbounded-queue", taskId: body.taskId, kind: body.kind, limit: 1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write,
    leaseRetrySleep: async () => {}
  });
  t.after(() => client.stopHeartbeat());
  const lease = await client.acquireLease("video", "stable-idempotency-key", { projectId: "project-queue" });
  assert.equal(lease.leaseId, "lease-after-unbounded-queue");
  assert.equal(taskIds.length, 7);
  assert.deepEqual([...new Set(taskIds)], ["stable-idempotency-key"]);
});

test("旧视频直提入口也必须申请管理后台视频租约", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  const handler = mainSource.slice(
    mainSource.indexOf('ipcMain.handle("video:submit"'),
    mainSource.indexOf('ipcMain.handle("video:query"')
  );
  assert.match(handler, /dramaLicense\.acquireLease\("video"/);
  assert.match(handler, /dramaLicense\.releaseLease\(lease\.leaseId/);
  assert.doesNotMatch(handler, /upstreamManagedConcurrency/);
});

test("篡改环境变量或本地授权文件不能重定向授权与并发服务器", (t) => {
  const previous = process.env.DRAMA_LICENSE_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DRAMA_LICENSE_BASE_URL;
    else process.env.DRAMA_LICENSE_BASE_URL = previous;
  });
  process.env.DRAMA_LICENSE_BASE_URL = "https://attacker.invalid";
  const client = new DramaLicenseClient({
    stateReader: () => ({ baseUrl: "http://127.0.0.1:31337" }),
    stateWriter: value => value
  });
  assert.equal(client.baseUrl, "https://drama-slot.puream.cn");
  client.stopHeartbeat();
});

test("官网明确签发管理员多机策略时，客户端只展示策略并把设备判断交给服务端", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const store = createStateStore({ machineId: "old-machine-from-another-computer" });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ pathname, body });
    if (pathname !== "/api/auth/login") throw new Error(`unexpected fetch ${url}`);
    return jsonResponse(200, {
      ok: true,
      token: "server-issued-admin-multi-device-token",
      pureamAuthorizationCode: body.activationCode,
      phone: "15100000001",
      name: "管理员",
      imageConcurrency: 3,
      videoConcurrency: 2,
      isAdministrator: true,
      deviceBindingPolicy: "UNLIMITED"
    });
  };
  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write
  });
  t.after(() => client.stopHeartbeat());

  // A state file copied from another computer is locally mismatched, but this
  // must not pre-block an explicit fresh login; the server receives the new
  // machineId and decides whether the administrator policy permits it.
  assert.equal(client.storedStateMatchesMachine(), false);
  const snapshot = await client.login("ABCDEF0123456789");
  assert.equal(snapshot.activated, true);
  assert.equal(snapshot.deviceBindingPolicy, "multi-device");
  assert.equal(snapshot.administratorEntitled, true);
  assert.equal(store.snapshot().deviceBindingPolicy, "multi-device");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.machineId, client.machineId());
  assert.equal(client.storedStateMatchesMachine(), true);
});

test("官网与 sidecar 的实际 SINGLE/UNLIMITED 契约可被规范化", () => {
  const { normalizeDeviceBindingPolicy } = require("../app/license-gate");
  assert.equal(normalizeDeviceBindingPolicy("UNLIMITED"), "multi-device");
  assert.equal(normalizeDeviceBindingPolicy("SINGLE"), "bound");
});

test("本地篡改的多机字段不能绕过普通用户设备绑定或自动重登门禁", () => {
  const store = createStateStore({
    token: "copied-token",
    activationCode: "ABCDEF0123456789",
    machineId: "another-machine",
    deviceBindingPolicy: "multi-device",
    administratorEntitled: true,
    sessionAuthority: WEBSITE_SESSION_AUTHORITY,
    concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY
  });
  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write
  });
  assert.equal(client.getSnapshot().deviceBindingPolicy, "multi-device");
  assert.equal(client.storedStateMatchesMachine(), false);
  assert.equal(client.canAutoRelogin(), false);
  client.stopHeartbeat();
});

test("普通授权未收到明确多机策略时保持服务端设备绑定语义", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const store = createStateStore({ machineId: "old-machine-from-another-computer" });
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (pathname !== "/api/auth/login") throw new Error(`unexpected fetch ${url}`);
    assert.equal(typeof body.machineId, "string");
    assert.ok(body.machineId.length > 0);
    return jsonResponse(403, { ok: false, code: "DEVICE_BOUND", message: "该授权码已绑定其他设备" });
  };
  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write
  });
  await assert.rejects(() => client.login("ABCDEF0123456789"), error => error?.code === "DEVICE_BOUND");
  assert.equal(store.snapshot().token, undefined);
  client.stopHeartbeat();
});

test("有效官网授权遇到 sidecar HTTP 502 时进入本机离线宽限", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const lastHeartbeatOkAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const store = createStateStore({
    token: "existing-server-issued-token",
    activationCode: "ABCDEF0123456789",
    machineId: "",
    imageConcurrency: 3,
    videoConcurrency: 2,
    sessionAuthority: WEBSITE_SESSION_AUTHORITY,
    concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY,
    activatedAt: lastHeartbeatOkAt,
    lastHeartbeatOkAt,
    offlineGrace: false
  });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ url: String(url), pathname, method: options.method || "GET" });
    if (String(url) === PUREAM_WEBSITE_DESKTOP_LOGIN_URL) {
      return jsonResponse(200, {
        ok: true,
        data: {
          pureamAuthorizationCode: "ABCDEF0123456789",
          phone: "15100000001",
          name: "官网用户",
          entitlementProduct: "drama-yearly"
        }
      });
    }
    if (pathname === "/api/auth/login") {
      return jsonResponse(502, { ok: false, message: "Bad Gateway" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write
  });
  t.after(() => client.stopHeartbeat());

  const snapshot = await client.ensureSession();
  assert.equal(snapshot.activated, true);
  assert.equal(snapshot.offlineGrace, true);
  assert.ok(snapshot.offlineGraceRemainingMs > 0);
  assert.equal(store.snapshot().token, "existing-server-issued-token");
  assert.equal(store.snapshot().offlineGrace, true);
  assert.deepEqual(calls.map(item => item.pathname), ["/api/drama/auth/login", "/api/auth/login"]);
});

test("离线宽限内的新租约被拒绝且不会向 sidecar 创建任务", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const store = createStateStore({
    token: "existing-server-issued-token",
    activationCode: "ABCDEF0123456789",
    machineId: "",
    imageConcurrency: 3,
    videoConcurrency: 2,
    sessionAuthority: WEBSITE_SESSION_AUTHORITY,
    concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY,
    activatedAt: new Date().toISOString(),
    lastHeartbeatOkAt: new Date().toISOString(),
    offlineGrace: true
  });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    throw new Error(`offline grace must not call sidecar: ${url}`);
  };
  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write
  });
  t.after(() => client.stopHeartbeat());

  await assert.rejects(
    () => client.acquireLease("video", "must-not-be-created", { projectId: "project-offline" }),
    error => error?.code === "CONCURRENCY_AUTHORITY_OFFLINE"
  );
  assert.deepEqual(calls, []);
  assert.equal(client.leaseHeartbeats.size, 0);
  assert.equal(client.offlineLeases.size, 0);
});

test("sidecar HTTP 502 不能延长已经过期的离线宽限", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const expiredAt = new Date(Date.now() - OFFLINE_GRACE_MS - 60_000).toISOString();
  const store = createStateStore({
    token: "expired-server-issued-token",
    activationCode: "ABCDEF0123456789",
    machineId: "",
    imageConcurrency: 3,
    videoConcurrency: 2,
    sessionAuthority: WEBSITE_SESSION_AUTHORITY,
    concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY,
    activatedAt: expiredAt,
    lastHeartbeatOkAt: expiredAt,
    offlineGrace: true
  });
  const calls = [];
  global.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (String(url) === PUREAM_WEBSITE_DESKTOP_LOGIN_URL) {
      return jsonResponse(200, { ok: true, data: { pureamAuthorizationCode: "ABCDEF0123456789" } });
    }
    if (pathname === "/api/auth/login") return jsonResponse(502, { ok: false, message: "Bad Gateway" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write
  });
  t.after(() => client.stopHeartbeat());

  await assert.rejects(() => client.ensureSession(), error => error?.code === "LICENSE_OFFLINE_EXPIRED");
  assert.deepEqual(calls, ["/api/drama/auth/login", "/api/auth/login"]);
  assert.equal(client.getSnapshot().offlineGraceRemainingMs, 0);
});

test("没有令牌和授权码时离线宽限标记也不能绕过激活", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error(`unactivated client must not call network: ${url}`);
  };
  const store = createStateStore({
    token: "",
    activationCode: "",
    imageConcurrency: 3,
    videoConcurrency: 2,
    sessionAuthority: WEBSITE_SESSION_AUTHORITY,
    concurrencyAuthority: ADMIN_CONCURRENCY_AUTHORITY,
    activatedAt: new Date().toISOString(),
    lastHeartbeatOkAt: new Date().toISOString(),
    offlineGrace: true
  });
  const client = new DramaLicenseClient({
    baseUrl: "https://drama-slot.puream.cn",
    stateReader: store.read,
    stateWriter: store.write
  });
  t.after(() => client.stopHeartbeat());

  await assert.rejects(() => client.ensureSession(), error => error?.code === "NEED_ACTIVATION");
  assert.deepEqual(calls, []);
  assert.equal(client.getSnapshot().activated, false);
});
