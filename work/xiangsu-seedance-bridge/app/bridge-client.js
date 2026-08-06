"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BRIDGE_ORIGIN = "http://127.0.0.1:28911";
const REQUEST_TIMEOUT_MS = 20_000;

class BridgeClient {
  constructor() {
    this.stateDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SeedanceBridge");
    this.tokenPath = path.join(this.stateDir, "bridge-token");
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
    const token = this.ensureToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${BRIDGE_ORIGIN}${route}`, {
        method: options.method || "GET",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
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
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async health() {
    try {
      return await this.request("/v1/health", { timeoutMs: 2_500 });
    } catch (error) {
      return {
        ok: false,
        code: error.name === "AbortError" ? "BRIDGE_TIMEOUT" : "BRIDGE_OFFLINE",
        message: "像塑后台桥未连接"
      };
    }
  }

  diagnostics() {
    return this.request("/v1/diagnostics");
  }

  submit(payload) {
    return this.request("/v1/videos", {
      method: "POST",
      body: payload,
      timeoutMs: 60_000
    });
  }

  query(taskId) {
    return this.request(`/v1/videos/${encodeURIComponent(taskId)}`, { timeoutMs: 30_000 });
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
    const executable = this.locateXiangsu();
    if (!executable) {
      const error = new Error("未找到像塑安装程序");
      error.code = "XIANGSU_NOT_FOUND";
      throw error;
    }
    this.ensureToken();
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
    child.unref();
    return { ok: true, executable };
  }
}

module.exports = { BridgeClient, BRIDGE_ORIGIN };
