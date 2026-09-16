"use strict";

const MCP_SERVER_NAME = "puream-drama-workbench";
const MCP_TRANSPORT = "stdio";
const MCP_ARGS = Object.freeze(["--mcp-stdio"]);

function cleanExecutablePath(value) {
  const executablePath = String(value || "").trim();
  if (!executablePath) throw Object.assign(new Error("无法确定当前短剧老虎机程序路径"), { code: "MCP_EXECUTABLE_MISSING" });
  return executablePath;
}

function createGenericJson(executablePath) {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: cleanExecutablePath(executablePath),
        args: [...MCP_ARGS]
      }
    }
  }, null, 2);
}

function createCodexToml(executablePath) {
  const command = JSON.stringify(cleanExecutablePath(executablePath));
  return `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${command}\nargs = ["--mcp-stdio"]\n`;
}

function createConnectionInfo({ executablePath, appVersion, gatewayRunning = false, toolCount = 41 } = {}) {
  const command = cleanExecutablePath(executablePath);
  return {
    serverName: MCP_SERVER_NAME,
    transport: MCP_TRANSPORT,
    command,
    args: [...MCP_ARGS],
    appVersion: String(appVersion || ""),
    gatewayRunning: Boolean(gatewayRunning),
    toolCount: Math.max(0, Number(toolCount) || 0),
    genericJson: createGenericJson(command),
    codexToml: createCodexToml(command),
    requiresSecret: false,
    note: "配置写入本地 Agent；短剧老虎机不要求填写 URL、端口、令牌或 API Key。"
  };
}

async function probeStdioConnection({ executablePath, timeoutMs = 10_000 } = {}) {
  const { Client } = require("@modelcontextprotocol/client");
  const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
  const command = cleanExecutablePath(executablePath);
  const errors = [];
  const transport = new StdioClientTransport({
    command,
    args: [...MCP_ARGS],
    env: { ...process.env, PUREAM_MCP_NO_AUTOLAUNCH: "1" },
    stderr: "pipe"
  });
  transport.stderr?.on?.("data", chunk => {
    if (errors.join("").length < 2_000) errors.push(String(chunk || ""));
  });
  const client = new Client({ name: "puream-desktop-mcp-self-test", version: "1.0.0" });
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("MCP 握手超过 10 秒"), { code: "MCP_PROBE_TIMEOUT" })), Math.max(1_000, Number(timeoutMs) || 10_000));
      timer.unref?.();
    });
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);
    const status = await Promise.race([client.callTool({ name: "app_status", arguments: {} }), timeout]);
    if (status?.isError || status?.structuredContent?.ok === false) {
      throw Object.assign(new Error(status?.structuredContent?.message || "MCP 已启动，但应用状态读取失败"), { code: "MCP_PROBE_STATUS_FAILED" });
    }
    return {
      ok: true,
      serverName: MCP_SERVER_NAME,
      transport: MCP_TRANSPORT,
      toolCount: Array.isArray(listed?.tools) ? listed.tools.length : 0,
      appVersion: String(status?.structuredContent?.version || ""),
      projectCount: Number(status?.structuredContent?.projects || 0)
    };
  } catch (error) {
    const detail = errors.join("").trim().replace(/\s+/g, " ").slice(0, 400);
    if (detail && !String(error?.message || "").includes(detail)) error.message = `${error.message || "MCP 握手失败"}：${detail}`;
    throw error;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

module.exports = {
  MCP_SERVER_NAME,
  MCP_TRANSPORT,
  MCP_ARGS,
  createGenericJson,
  createCodexToml,
  createConnectionInfo,
  probeStdioConnection
};
