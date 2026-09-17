"use strict";
// T17: 主流 Agent 能力与事件适配——每个声明支持的客户端都有事件分类证据
// 与版本核验证据。
const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyEvent, businessComplete } = require("../app/production-v2/terminal-policy");
const { AGENTS } = require("../app/local-agent-runtime");
const terminalPolicy = require("../app/production-v2/terminal-policy");
const versionNoteModule = require("../app/agent-catalog-version");

// 每个客户端一个真实终局事件 fixture（来自各 CLI 的实际事件流）。
const TERMINAL_FIXTURES = {
  codex: { type: "turn.completed" },
  "claude-code": { type: "result", subtype: "success" },
  workbuddy: { type: "result", subtype: "success" },
  antigravity: { event: "result", result: { response: "x" } },
  grokbuild: { type: "turn.completed" },
  "deepseek-harness": { event: "result", result: { text: "x" } }
};

test("每个声明支持的客户端都有终局事件分类证据", () => {
  assert.ok(AGENTS.length >= 5, `声明客户端数异常: ${AGENTS.length}`);
  for (const agent of AGENTS) {
    const fixture = TERMINAL_FIXTURES[agent.id];
    assert.ok(fixture, `${agent.id} 缺少终局事件 fixture`);
    const classified = classifyEvent(agent.id, fixture);
    assert.equal(classified.status, "transport_complete", `${agent.id} 的终局事件必须被识别`);
    // 中间事件不得被误判为终局。
    const mid = classifyEvent(agent.id, { type: "assistant", event: "update", message: {} });
    assert.equal(mid.status, "running", `${agent.id} 的中间事件不得判为终局`);
  }
});

test("每个客户端的失败与截断事件也能被识别", () => {
  assert.equal(classifyEvent("codex", { type: "turn.failed" }).status, "failed");
  assert.equal(classifyEvent("antigravity", { event: "error", message: "boom" }).status, "failed");
  assert.equal(classifyEvent("grokbuild", { type: "turn.failed" }).status, "failed");
  assert.equal(classifyEvent("deepseek-harness", { event: "error" }).status, "failed");
  assert.equal(classifyEvent("workbuddy", { type: "result", subtype: "error_during_execution" }).status, "failed");
  // error_max_turns 是容量截断（断点已保存、可续），不是失败。
  assert.equal(classifyEvent("workbuddy", { type: "result", subtype: "error_max_turns" }).status, "incomplete");
  for (const agent of AGENTS) {
    assert.equal(classifyEvent(agent.id, { type: "x", stop_reason: "max_tokens" }).status, "incomplete", `${agent.id} 截断必须标 incomplete`);
  }
});

test("businessComplete 仍要求全部业务证据，不因 transport_complete 放水", () => {
  assert.equal(businessComplete({ transport: "transport_complete", validReceipt: false, validSchema: false, coverageComplete: false, sourceCurrent: true, cancelled: false }), false);
  assert.equal(businessComplete({ transport: "running", validReceipt: true, validSchema: true, coverageComplete: true, sourceCurrent: true, cancelled: false }), true);
});

test("每个客户端都有版本核验路径（版本证据函数覆盖全部声明客户端）", async () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "app", "agent-catalog-version.js"), "utf8");
  for (const agent of AGENTS) {
    assert.match(source, new RegExp(`['"]${agent.id}['"]`), `${agent.id} 必须纳入版本证据名单`);
  }
  // 注入 run stub：本机版本可读 + 无远端 → 本机核验文案。
  const calls = [];
  const note = await versionNoteModule("codex", "codex.exe", async (exe, args) => { calls.push(args); return { output: "codex-cli 2.4.1" }; }, ".");
  assert.match(note, /客户端 2\.4\.1；本机核验/);
  assert.deepEqual(calls, [["--version"]]);
  const failNote = await versionNoteModule("antigravity", "agy", async () => { throw new Error("no cli"); }, ".");
  assert.match(failNote, /版本检查失败/);
});

test("运行时事件循环对全部声明客户端接入分类（不再是 codex/claude 专属）", () => {
  const runtime = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "app", "local-agent-runtime.js"), "utf8");
  assert.match(runtime, /if\(definition\(id\)\)\{\s*const classified=terminalPolicy\.classifyEvent/);
  assert.doesNotMatch(runtime, /if\(id==='codex'\|\|id==='claude-code'\)\{\s*const classified/);
});
