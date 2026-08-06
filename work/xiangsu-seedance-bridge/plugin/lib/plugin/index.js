"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 28911;
const MAX_BODY_BYTES = 1_000_000;
const MODULE_NAMES = [
  "@orion/Business/BusinessCommon/Utils",
  "@orion/Business/BusinessCommon/Utils/index",
  "@orion/Business/BusinessCommon/Utils/PlatformUtils",
  "@orion/Business/AIEffectWindow/controller/AIVideoController",
  "@orion/Business/AIEffectWindow/controller/SubController/MultiRefImagePromptController/apiUtils",
  "@orion/Business/API/aigc_api",
  "@orion/Business/API/ai_effect_api",
  "@orion/Business/AIGC",
  "@orion/Business/AIGC/AIGCService",
  "@orion/Business/AIGC/AIVideoService"
];

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求体过大"), { code: "BODY_TOO_LARGE" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("请求 JSON 无效"), { code: "INVALID_JSON" }));
      }
    });
    request.on("error", reject);
  });
}

function getTokenPath() {
  return process.env.SEEDANCE_BRIDGE_TOKEN_PATH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SeedanceBridge", "bridge-token");
}

function getToken() {
  try {
    return fs.readFileSync(getTokenPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function authorized(request) {
  const token = getToken();
  const header = request.headers.authorization || "";
  if (!token || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (supplied.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

function describeExport(value) {
  if (value === null) return { type: "null" };
  const type = typeof value;
  if (type === "function") {
    let source = "";
    try {
      source = Function.prototype.toString.call(value).replace(/\s+/g, " ").slice(0, 240);
    } catch {}
    return { type, arity: value.length, source };
  }
  if (type !== "object") return { type };
  const properties = {};
  for (const key of Object.getOwnPropertyNames(value).sort()) {
    if (/cookie|token|sign|auth|session|passport/i.test(key)) {
      properties[key] = { type: typeof value[key], redacted: true };
    } else {
      properties[key] = describeExport(value[key]);
    }
  }
  return { type, properties };
}

function findModules() {
  const registry = globalThis.orion || {};
  const candidates = new Set(MODULE_NAMES);
  for (const name of Object.keys(registry)) {
    if (/(AIGC|AIVideo|AI.*Video|BusinessCommon\/Utils)/i.test(name)) candidates.add(name);
  }
  const modules = {};
  for (const name of [...candidates].sort()) {
    if (!(name in registry)) continue;
    try {
      modules[name] = describeExport(registry[name]);
    } catch (error) {
      modules[name] = { error: error.message };
    }
  }
  return modules;
}

function resolveRuntime() {
  const registry = globalThis.orion || {};
  const utils = registry["@orion/Business/BusinessCommon/Utils"] || registry["@orion/Business/BusinessCommon/Utils/index"] || null;
  return {
    registry,
    utils,
    platformUtils: utils?.PlatformUtils || registry["@orion/Business/BusinessCommon/Utils/PlatformUtils"] || null,
    cookieManager: utils?.CookieManager || null
  };
}

async function handleVideos(request, response, runtime) {
  const payload = await readBody(request);
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
    return json(response, 400, { ok: false, code: "PROMPT_REQUIRED", message: "请输入提示词" });
  }
  if (payload.ability !== "SD_2.0_MINI") {
    return json(response, 400, { ok: false, code: "ABILITY_NOT_ALLOWED", message: "仅允许 SD_2.0_MINI" });
  }
  if (!runtime.platformUtils || typeof runtime.platformUtils.genSignData !== "function") {
    return json(response, 503, {
      ok: false,
      code: "SIGNER_UNAVAILABLE",
      message: "像塑原生签名器尚未就绪；请完成一次插件能力检测"
    });
  }
  return json(response, 501, {
    ok: false,
    code: "PROTOCOL_NOT_BOUND",
    message: "桥接在线，但提交协议仍在绑定中；不会消耗像塑额度"
  });
}

class PluginInstance {
  constructor() {
    this.server = null;
    this.initPlugin = this.initPlugin.bind(this);
    this.deinitPlugin = this.deinitPlugin.bind(this);
  }

  initPlugin() {
    if (this.server) return;
    const runtime = resolveRuntime();
    this.server = http.createServer(async (request, response) => {
      try {
        if (!authorized(request)) {
          return json(response, 401, { ok: false, code: "UNAUTHORIZED", message: "本机桥接鉴权失败" });
        }
        const url = new URL(request.url, `http://${HOST}:${PORT}`);
        if (request.method === "GET" && url.pathname === "/v1/health") {
          const signerReady = Boolean(runtime.platformUtils && typeof runtime.platformUtils.genSignData === "function");
          const cookieReady = Boolean(runtime.cookieManager && typeof runtime.cookieManager.getCookie === "function");
          return json(response, 200, {
            ok: true,
            ready: signerReady && cookieReady,
            sessionReady: signerReady && cookieReady,
            signerReady,
            cookieReady,
            product: "DYEH",
            version: "0.1.0",
            message: signerReady && cookieReady ? "像塑原生会话桥已就绪" : "插件在线，正在等待像塑业务模块"
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/diagnostics") {
          return json(response, 200, {
            ok: true,
            safe: true,
            note: "仅返回模块名称、导出键和函数参数数量，不返回凭证或签名值",
            modules: findModules()
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/videos") {
          return handleVideos(request, response, runtime);
        }
        if (request.method === "GET" && url.pathname.startsWith("/v1/videos/")) {
          return json(response, 501, { ok: false, code: "PROTOCOL_NOT_BOUND", message: "查询协议尚未绑定" });
        }
        return json(response, 404, { ok: false, code: "NOT_FOUND", message: "接口不存在" });
      } catch (error) {
        return json(response, 500, { ok: false, code: error.code || "BRIDGE_ERROR", message: error.message || "桥接内部错误" });
      }
    });
    this.server.on("error", error => {
      if (error.code !== "EADDRINUSE") console.error("[SeedanceBridge]", error.message);
    });
    this.server.listen(PORT, HOST);
  }

  deinitPlugin() {
    if (this.server) this.server.close();
    this.server = null;
  }
}

module.exports = PluginInstance;
