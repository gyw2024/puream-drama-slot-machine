"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { _electron: electron } = require("playwright-core");
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

async function waitForFile(filePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const executablePath = path.join(root, packageJson.build.directories.output, "win-unpacked", "纯梦短剧老虎机.exe");
  assert.ok(fs.existsSync(executablePath), "packaged executable must exist");
  const evidenceRoot = process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
    ? path.resolve(process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR)
    : path.join(root, ".codex_tests", "TASK-20260815-MCP-CONTROL-BILLING-001", "packaged-mcp");
  const runDir = path.join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  const connectionFile = path.join(userDataDir, "mcp-control.json");
  const auditAutolaunch = process.env.PUREAM_MCP_AUDIT_AUTOLAUNCH === "1";
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workbenchDir, { recursive: true });
  const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE
    || path.join(process.env.APPDATA || "", packageJson.name, "drama-license.json");
  assert.ok(fs.existsSync(licenseSource), "packaged MCP audit requires an existing activation snapshot");
  fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
  const localStateSource = path.join(path.dirname(licenseSource), "Local State");
  assert.ok(fs.existsSync(localStateSource), "packaged MCP audit requires the Electron Local State encryption key");
  fs.copyFileSync(localStateSource, path.join(userDataDir, "Local State"));

  const electronApp = auditAutolaunch ? null : await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: workbenchDir }
  });
  let client = null;
  let launchedDesktopPid = 0;
  try {
    if (electronApp) {
      const page = await electronApp.firstWindow({ timeout: 20_000 });
      await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
      await waitForFile(connectionFile);
    }
    const transport = new StdioClientTransport({
      command: executablePath,
      args: ["--mcp-stdio"],
      env: {
        ...process.env,
        PUREAM_MCP_CONNECTION_FILE: connectionFile,
        DRAMA_SLOT_DATA_ROOT: workbenchDir,
        ...(auditAutolaunch
          ? { PUREAM_MCP_DESKTOP_USER_DATA_DIR: userDataDir }
          : { PUREAM_MCP_NO_AUTOLAUNCH: "1" })
      },
      stderr: "pipe"
    });
    client = new Client({ name: "puream-packaged-release-audit", version: "1.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    const expected = ["app_status", "get_project", "get_production_status", "get_cost_ledger", "run_full_pipeline", "generate_all_assets", "generate_all_videos"];
    assert.equal(expected.every(name => names.includes(name)), true, "packaged MCP sidecar must expose the production control surface");
    const status = await client.callTool({ name: "app_status", arguments: {} });
    assert.notEqual(status.isError, true);
    assert.equal(status.structuredContent?.version, packageJson.version);
    assert.equal(status.structuredContent?.ok, true);
    assert.equal(Number(status.structuredContent?.license?.videoConcurrency) > 0, true, "app status must expose backend video concurrency");
    await waitForFile(connectionFile);
    launchedDesktopPid = Number(JSON.parse(fs.readFileSync(connectionFile, "utf8"))?.pid || 0);
    assert.equal(launchedDesktopPid > 0, true, "MCP connection must identify the controlling desktop process");
    const resources = await client.listResources();
    assert.equal(resources.resources.some(resource => resource.uri === "puream://app/status"), true);
    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts.some(prompt => prompt.name === "produce_short_drama"), true);
    const report = {
      ok: true,
      auditAutolaunch,
      version: packageJson.version,
      executablePath,
      toolCount: names.length,
      expectedTools: expected,
      resourceUris: resources.resources.map(resource => resource.uri),
      promptNames: prompts.prompts.map(prompt => prompt.name),
      appStatus: {
        ok: status.structuredContent?.ok,
        version: status.structuredContent?.version,
        concurrency: {
          image: status.structuredContent?.license?.imageConcurrency,
          video: status.structuredContent?.license?.videoConcurrency,
          authority: status.structuredContent?.license?.concurrencyAuthority
        },
        projectCount: status.structuredContent?.projects
      }
    };
    fs.writeFileSync(path.join(runDir, "audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, runDir, toolCount: names.length, version: packageJson.version }, null, 2)}\n`);
  } finally {
    await client?.close?.().catch(() => {});
    if (auditAutolaunch && launchedDesktopPid <= 0 && fs.existsSync(connectionFile)) {
      try { launchedDesktopPid = Number(JSON.parse(fs.readFileSync(connectionFile, "utf8"))?.pid || 0); } catch {}
    }
    if (electronApp) {
      await Promise.race([
        electronApp.close().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5_000))
      ]);
    } else if (launchedDesktopPid > 0 && process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(launchedDesktopPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else if (launchedDesktopPid > 0) {
      try { process.kill(launchedDesktopPid, "SIGTERM"); } catch {}
    }
  }
}

main().then(() => process.exit(0)).catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
});
