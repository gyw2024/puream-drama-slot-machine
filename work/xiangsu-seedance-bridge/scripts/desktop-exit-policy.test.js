"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { installDesktopExitPolicy, wasClosedByUser } = require("../app/desktop-exit-policy");
const { startControlGateway } = require("../app/mcp/control-gateway");
const { readConnection, requestConnection, ensureConnection } = require("../app/mcp/control-client");

for (const work of ["idle", "running", "failed", "pending upstream receipt"]) {
  test(`user close exits with ${work}; no window is recreated`, () => {
    const app = new EventEmitter();
    const calls = [];
    app.quit = () => calls.push("quit");
    app.createWindow = () => assert.fail("must not recreate a window");
    app.activeWork = work;
    installDesktopExitPolicy({ app, closeGateway: options => calls.push(options) });
    app.emit("window-all-closed");
    assert.deepEqual(calls, [{ userClosed: true }, "quit"]);
  });
}
test("headless service is not mistaken for a user-closed desktop", () => {
  const app = new EventEmitter();
  app.quit = () => assert.fail("headless runtime must remain available");
  installDesktopExitPolicy({ app, headless: true, closeGateway: () => assert.fail() });
  app.emit("window-all-closed");
});
test("gateway failure cannot lock user inside the application", () => {
  const app = new EventEmitter();
  let quits = 0;
  app.quit = () => quits++;
  installDesktopExitPolicy({ app, closeGateway: () => { throw new Error("simulated disk failure"); } });
  app.emit("window-all-closed");
  assert.equal(quits, 1);
});
test("real IPC exit receipt blocks auto-relaunch and manual launch reconnects", async () => {
  const root = path.resolve(__dirname, "../../../.codex_tests/TASK-20260905-DRAMA-CLOSE-180/ipc");
  fs.mkdirSync(root, { recursive: true });
  const connectionFile = path.join(root, `connection-${process.pid}-${Date.now()}.json`);
  const controller = { dispatch: async () => ({ ok: true, version: "test", activeProjects: 1 }) };
  const first = startControlGateway({ controller, connectionFile });
  await once(first.server, "listening");
  assert.equal((await requestConnection(readConnection(connectionFile), "app_status")).activeProjects, 1);
  first.close({ userClosed: true });
  first.close(); // before-quit must not erase the user-exit receipt.
  assert.equal(wasClosedByUser(connectionFile), true);
  assert.equal(JSON.parse(fs.readFileSync(connectionFile, "utf8")).token, undefined);
  assert.throws(() => readConnection(connectionFile), { code: "MCP_APP_CLOSED_BY_USER" });
  const previous = process.env.PUREAM_MCP_CONNECTION_FILE;
  process.env.PUREAM_MCP_CONNECTION_FILE = connectionFile;
  try { await assert.rejects(ensureConnection(), { code: "MCP_APP_CLOSED_BY_USER" }); }
  finally {
    if (previous === undefined) delete process.env.PUREAM_MCP_CONNECTION_FILE;
    else process.env.PUREAM_MCP_CONNECTION_FILE = previous;
  }
  const restarted = startControlGateway({ controller, connectionFile });
  await once(restarted.server, "listening");
  assert.equal(wasClosedByUser(connectionFile), false);
  assert.equal((await requestConnection(readConnection(connectionFile), "app_status")).ok, true);
  restarted.close();
});
test("main process wires exit policy and blocks legacy MCP relaunch", () => {
  const main = fs.readFileSync(path.join(__dirname, "../app/main.js"), "utf8");
  assert.match(main, /installDesktopExitPolicy\(\{/);
  assert.match(main, /PUREAM_MCP_CHILD === "1" && wasClosedByUser/);
  assert.doesNotMatch(main, /last window closed during live work; restoring/);
  assert.match(main, /videoJobRecoveryScheduler\?\.stop/);
});
