"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function localPipeName(instanceId) {
  const safe = String(instanceId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "");
  if (process.platform === "win32") return `\\\\.\\pipe\\puream-drama-mcp-${safe}`;
  return path.join(os.tmpdir(), `puream-drama-mcp-${safe}.sock`);
}

function publicGatewayError(error) {
  return {
    code: String(error?.code || "MCP_APP_CONTROL_FAILED"),
    message: String(error?.message || error || "应用控制失败").slice(0, 4000)
  };
}

function startControlGateway(options = {}) {
  const controller = options.controller;
  const connectionFile = path.resolve(String(options.connectionFile || ""));
  if (!controller || typeof controller.dispatch !== "function") throw new Error("MCP controller is required");
  if (!connectionFile) throw new Error("MCP connection file is required");
  const instanceId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const pipeName = localPipeName(instanceId);
  if (process.platform !== "win32") {
    try { fs.rmSync(pipeName, { force: true }); } catch {}
  }

  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let closed = false;
    const responseFiles=new Set();
    const reply = async (value,allowFile=false) => {
      if (closed || socket.destroyed) return;
      if(allowFile&&value.ok){
        const files=require('./control-response-files'),serialized=JSON.stringify(value.result);
        if(serialized&&Buffer.byteLength(serialized,'utf8')>files.INLINE_BYTES){
          const file=files.responsePath(connectionFile,instanceId,value.id);
          responseFiles.add(file);
          const receipt=await files.write(file,serialized);
          if(closed||socket.destroyed){await fs.promises.unlink(file).catch(()=>{});return;}
          socket.write(`${JSON.stringify({id:value.id,ok:true,resultFile:receipt})}\n`);
          return;
        }
      }
      socket.write(`${JSON.stringify(value)}\n`);
    };
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
        reply({ id: null, ok: false, error: { code: "MCP_MESSAGE_TOO_LARGE", message: "控制消息超过 2MB 限制" } });
        socket.end();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!raw) continue;
        let request;
        try { request = JSON.parse(raw); }
        catch {
          reply({ id: null, ok: false, error: { code: "MCP_CONTROL_PARSE_ERROR", message: "控制消息不是有效 JSON" } });
          continue;
        }
        const id = request?.id ?? null;
        const suppliedToken = crypto.createHash("sha256").update(String(request?.token || ""), "utf8").digest();
        const expectedToken = crypto.createHash("sha256").update(token, "utf8").digest();
        if (!crypto.timingSafeEqual(suppliedToken, expectedToken)) {
          reply({ id, ok: false, error: { code: "MCP_CONTROL_UNAUTHORIZED", message: "MCP 本地控制令牌无效" } });
          continue;
        }
        Promise.resolve(controller.dispatch(String(request?.method || ""), request?.params || {}))
          .then(result => reply({ id, ok: true, result },request.acceptResponseFile===1))
          .catch(error => reply({ id, ok: false, error: publicGatewayError(error) }));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      closed = true;
      sockets.delete(socket);
      // Delete only response files created by this authenticated connection.
      // The client closes after reading and checking the exact result bytes.
      for(const file of responseFiles)fs.promises.unlink(file).catch(()=>{});
    });
  });

  let closing = false;
  server.listen(pipeName, () => {
    if (closing) { try { server.close(); } catch {} return; }
    atomicWriteJson(connectionFile, {
      version: 1,
      protocol: "puream-local-control/1",
      instanceId,
      pid: process.pid,
      appVersion: String(options.appVersion || ""),
      pipeName,
      token,
      startedAt: new Date().toISOString()
    });
  });
  // The MCP gateway is optional.  It must never keep Electron alive after the
  // desktop window has closed; active requests are explicitly destroyed below.
  server.unref();
  server.on("error", error => console.error("[mcp-control] gateway failed", error?.message || error));

  const close = (options = {}) => {
    if (closing) return;
    closing = true;
    for (const socket of sockets) {
      try { socket.destroy(); } catch {}
    }
    sockets.clear();
    try { server.close(); } catch {}
    try {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(connectionFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!current || current.instanceId === instanceId) {
        if (options.userClosed) {
          // A token-free tombstone prevents idle MCP clients from reopening the UI.
          // A normal manual launch replaces this with a fresh connection receipt.
          atomicWriteJson(connectionFile, { version: 1, protocol: "puream-local-control/1", instanceId, closedByUser: true, closedAt: new Date().toISOString() });
        } else fs.rmSync(connectionFile, { force: true });
      }
    } catch {}
    if (process.platform !== "win32") {
      try { fs.rmSync(pipeName, { force: true }); } catch {}
    }
  };
  return { server, instanceId, pipeName, connectionFile, close };
}

module.exports = { startControlGateway, localPipeName, MAX_MESSAGE_BYTES };
