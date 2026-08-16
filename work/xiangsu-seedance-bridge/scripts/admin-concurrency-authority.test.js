"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DramaLicenseClient,
  ADMIN_CONCURRENCY_AUTHORITY,
  WEBSITE_SESSION_AUTHORITY,
  PUREAM_WEBSITE_DESKTOP_LOGIN_URL
} = require("../app/license-gate");

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
