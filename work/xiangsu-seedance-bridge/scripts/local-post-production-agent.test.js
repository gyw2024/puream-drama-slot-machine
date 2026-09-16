"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LocalPostProductionAgent } = require("../app/mcp/local-post-production-agent");

test("roughcut button agent reads, starts and waits exclusively through MCP tools", async () => {
  const calls = [];
  let operationReads = 0;
  const controller = {
    async dispatch(method, params) {
      calls.push({ method, params });
      if (method === "get_project") return { ok: true, project: { id: params.project_id } };
      if (method === "get_production_status") return { ok: true, projectId: params.project_id, finalVideoPath: operationReads ? "D:\\project\\roughcut.mp4" : "" };
      if (method === "stitch_final_video") return { ok: true, operation: { operationId: "mcpop-roughcut", status: "running" } };
      if (method === "get_operation") return { ok: true, operation: { status: ++operationReads === 1 ? "running" : "completed", result: { finalVideoPath: "D:\\project\\roughcut.mp4" } } };
      throw new Error(`unexpected ${method}`);
    }
  };
  const agent = new LocalPostProductionAgent({ controller, pollIntervalMs: 0, timeoutMs: 5_000 });
  const result = await agent.runRoughCut("P01");
  assert.equal(result.result.finalVideoPath, "D:\\project\\roughcut.mp4");
  assert.deepEqual(calls.map(item => item.method), [
    "get_project", "get_production_status", "stitch_final_video",
    "get_operation", "get_production_status", "get_operation", "get_production_status"
  ]);
  assert.ok(calls.every(item => item.params.project_id === "P01" || item.params.operation_id === "mcpop-roughcut"));
});

test("agent preserves MCP cancellation boundary", async () => {
  const agent = new LocalPostProductionAgent({ controller: { dispatch: async (method, params) => ({ ok: true, method, params }) } });
  const result = await agent.cancel("P02");
  assert.equal(result.method, "cancel_post_production");
  assert.equal(result.params.project_id, "P02");
});

test("both desktop roughcut IPC entries are wired to the MCP agent rather than the workflow", () => {
  const main = fs.readFileSync(path.join(__dirname, "../app/main.js"), "utf8");
  assert.match(main, /const \{ LocalPostProductionAgent \} = require\("\.\/mcp\/local-post-production-agent"\);/);
  assert.match(main, /case "stitchProject":\s*if \(!simpleLocalPostProductionAgent\)[\s\S]{0,280}simpleLocalPostProductionAgent\.runRoughCut\(values\[0\]\)/);
  assert.match(main, /ipcMain\.handle\("workbench:stitch", async \(_event, projectId\) => \{[\s\S]{0,360}localPostProductionAgent\.runRoughCut\(projectId\)/);
  assert.match(main, /new LocalPostProductionAgent\(\{ controller: mcpAppController \}\)/);
});
