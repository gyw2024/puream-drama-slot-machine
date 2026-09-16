"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { resolveUserDataDirectory } = require("../user-data-location");

const RESPONSE_LIMIT = 8 * 1024 * 1024;

function defaultConnectionFile() {
  if (process.env.PUREAM_MCP_CONNECTION_FILE) return path.resolve(process.env.PUREAM_MCP_CONNECTION_FILE);
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Roaming");
  const userData = process.env.PUREAM_DRAMA_USER_DATA_DIR || resolveUserDataDirectory({ appDataPath: appData });
  return path.join(userData, "mcp-control.json");
}

function readConnection(filePath = defaultConnectionFile()) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (data?.closedByUser === true) {
    throw Object.assign(new Error("软件已由用户关闭；请手动打开纯梦短剧老虎机后再继续任务。"), { code: "MCP_APP_CLOSED_BY_USER" });
  }
  if (data?.protocol !== "puream-local-control/1" || !data?.pipeName || !data?.token) {
    throw Object.assign(new Error("应用 MCP 连接信息无效"), { code: "MCP_CONNECTION_INVALID" });
  }
  Object.defineProperty(data,'connectionFile',{value:path.resolve(filePath),enumerable:false});
  return data;
}

function requestConnection(connection, method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.pipeName);
    const requestId = crypto.randomUUID();
    let buffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("应用 MCP 控制请求超时"), { code: "MCP_CONTROL_TIMEOUT" })), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: requestId, token: connection.token, method, params, acceptResponseFile:1 })}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > RESPONSE_LIMIT) {
        finish(Object.assign(new Error("应用 MCP 控制响应超过 8MB 限制"), { code: "MCP_CONTROL_RESPONSE_TOO_LARGE" }));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); }
      catch { finish(Object.assign(new Error("应用 MCP 控制响应不是有效 JSON"), { code: "MCP_CONTROL_RESPONSE_INVALID" })); return; }
      if (response?.id !== requestId) return;
      if (!response.ok) {
        finish(Object.assign(new Error(response?.error?.message || "应用控制失败"), { code: response?.error?.code || "MCP_APP_CONTROL_FAILED" }));
        return;
      }
      if(response.resultFile){
        const files=require('./control-response-files');
        let file;
        try{file=files.responsePath(connection.connectionFile||defaultConnectionFile(),connection.instanceId,requestId);}
        catch(error){finish(Object.assign(error,{code:'MCP_CONTROL_RESPONSE_INVALID'}));return;}
        files.read(file,response.resultFile).then(result=>finish(null,result),error=>finish(Object.assign(error,{code:'MCP_CONTROL_RESPONSE_INVALID'})));
        return;
      }
      finish(null, response.result);
    });
    socket.on("error", error => finish(Object.assign(new Error("未连接到正在运行的纯梦短剧老虎机"), { code: "MCP_APP_NOT_RUNNING", cause: error })));
    socket.on("end", () => { if (!settled) finish(Object.assign(new Error("应用在返回 MCP 结果前断开"), { code: "MCP_APP_DISCONNECTED" })); });
  });
}

function launchDesktopApp() {
  if (process.env.PUREAM_MCP_NO_AUTOLAUNCH === "1") {
    throw Object.assign(new Error("纯梦短剧老虎机尚未运行，且当前 MCP 配置禁用了自动启动"), { code: "MCP_APP_NOT_RUNNING" });
  }
  const args = process.defaultApp ? [path.resolve(__dirname, "..", "..")] : [];
  if (process.env.PUREAM_MCP_DESKTOP_USER_DATA_DIR) {
    args.push(`--user-data-dir=${path.resolve(process.env.PUREAM_MCP_DESKTOP_USER_DATA_DIR)}`);
  }
  const desktopEnv = { ...process.env, PUREAM_MCP_CHILD: "1" };
  // The stdio sidecar intentionally runs under ELECTRON_RUN_AS_NODE.  Never
  // leak that mode into the desktop process we auto-launch.
  delete desktopEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: desktopEnv
  });
  child.unref();
}

async function waitForConnection(filePath, previousInstanceId = "") {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const connection = readConnection(filePath);
      if (!previousInstanceId || connection.instanceId !== previousInstanceId) {
        await requestConnection(connection, "app_status", {}, 2_000);
        return connection;
      }
      await requestConnection(connection, "app_status", {}, 2_000);
      return connection;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Object.assign(new Error("启动纯梦短剧老虎机后仍无法建立 MCP 本地控制连接"), { code: "MCP_APP_START_TIMEOUT", cause: lastError });
}

async function ensureConnection() {
  const filePath = defaultConnectionFile();
  let prior = null;
  try {
    prior = readConnection(filePath);
    await requestConnection(prior, "app_status", {}, 2_000);
    return prior;
  } catch (error) {
    if (error?.code === "MCP_APP_CLOSED_BY_USER") throw error;
  }
  launchDesktopApp();
  return waitForConnection(filePath, prior?.instanceId || "");
}

async function invokeApp(method, params = {}) {
  // The authenticated request proves liveness. A separate 2-second project
  // inventory falsely declared the busy app closed and lost operation polls.
  let existing;
  try { existing = readConnection(); }
  catch (error) { if (error?.code === 'MCP_APP_CLOSED_BY_USER') throw error; }
  if (existing) {
    try { return await requestConnection(existing, method, params); }
    catch (error) {
      if (!['MCP_APP_NOT_RUNNING', 'MCP_APP_DISCONNECTED'].includes(String(error?.code || ''))) throw error;
    }
  }
  let connection = await ensureConnection();
  try {
    return await requestConnection(connection, method, params);
  } catch (error) {
    if (!['MCP_APP_NOT_RUNNING', 'MCP_APP_DISCONNECTED'].includes(String(error?.code || ""))) throw error;
    connection = await ensureConnection();
    return requestConnection(connection, method, params);
  }
}

module.exports = { defaultConnectionFile, readConnection, requestConnection, ensureConnection, invokeApp };
