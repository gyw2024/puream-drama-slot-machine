"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { generateText } = require("../app/ai-provider");
const { WorkbenchWorkflow, bindSourceDialogueLedgerToAnalysis, assertSourceDialogueParity } = require("../app/workbench-workflow");

test("dialogue binding collapses duplicated shot/subshot views to one authored line", () => {
  const ledger = [
    { id: "D001", speaker: "甲", text: "第一句", tone: "克制" },
    { id: "D002", speaker: "乙", text: "第二句", tone: "坚定" }
  ];
  const normalized = bindSourceDialogueLedgerToAnalysis({
    characters: [{ id: "C01", name: "甲" }, { id: "C02", name: "乙" }],
    shots: [
      {
        subshots: [
          { sourceDialogueIds: ["D001"], dialogueTurns: [{ sourceDialogueId: "D001", text: "第一句" }] },
          { sourceDialogueIds: ["D001"], dialogueTurns: [{ sourceDialogueId: "D001", text: "第一句" }] }
        ]
      },
      { sourceDialogueBindings: [{ sourceDialogueId: "D002" }] }
    ]
  }, ledger);
  assertSourceDialogueParity(normalized, ledger);
  assert.deepEqual(normalized.shots.flatMap(shot => shot.sourceDialogueIds), ["D001", "D002"]);
});

test("production text attempts are bounded inside the five-minute stage SLA", () => {
  const options = WorkbenchWorkflow.prototype.productionTextOptions.call({
    operationControls: new Map(),
    setAutomation() {}
  }, "project-test", "asset_prompt");
  assert.equal(options.timeoutMs, 240_000);
  assert.equal(options.maxReconnectAttempts, 1);
});

test("PUREAM text reconnects rejected pre-response requests using one logical id", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, init = {}) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length < 3) throw Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
    return new Response([
      'event: delta\ndata: {"text":"恢复成功"}',
      'event: done\ndata: {"sessionId":"server-session","usage":{"input_tokens":4,"output_tokens":4},"charge_cents":0,"billing_status":"charged"}',
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "TEST-AUTH-CODE",
      model: "gpt-5-6-sol",
      maxTokens: 512
    }, [{ role: "user", content: "测试" }], { sessionId: "logical-text-001" });
    assert.equal(result, "恢复成功");
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.headers["idempotency-key"] === "logical-text-001"));
    assert.ok(calls.every(call => call.body.clientRequestId === "logical-text-001"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM text recognizes Electron net::ERR_FAILED as a pre-response interruption", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, init = {}) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length === 1) throw Object.assign(new Error("net::ERR_FAILED"), { code: "ERR_FAILED" });
    return new Response([
      'event: delta\ndata: {"text":"连接恢复"}',
      'event: done\ndata: {"sessionId":"server-session","usage":{"input_tokens":4,"output_tokens":4},"charge_cents":0,"billing_status":"charged"}',
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "TEST-AUTH-CODE",
      model: "gpt-5-6-sol",
      maxTokens: 512
    }, [{ role: "user", content: "测试" }], { sessionId: "logical-text-err-failed" });
    assert.equal(result, "连接恢复");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.headers["idempotency-key"] === "logical-text-err-failed"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM text does not replay a stream that already returned content", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response([
      'event: delta\ndata: {"text":"已生成部分正文"}',
      'event: error\ndata: {"code":"UPSTREAM_NETWORK_ERROR","message":"连接波动"}',
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "TEST-AUTH-CODE",
      model: "gpt-5-6-sol",
      maxTokens: 512
    }, [{ role: "user", content: "测试" }], { sessionId: "logical-text-002" }), error => {
      assert.equal(error.partialText, "已生成部分正文");
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM settled outputTokens zero is checkpointable failure and never replayed", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response([
      'event: done\ndata: {"sessionId":"settled-empty","usage":{"inputTokens":1200,"outputTokens":0},"charge_cents":18,"billing_status":"charged"}',
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "TEST-AUTH-CODE",
      model: "gpt-5-6-sol",
      maxTokens: 512
    }, [{ role: "user", content: "test" }], {
      sessionId: "logical-settled-empty",
      maxReconnectAttempts: 2
    }), error => error?.code === "TEXT_RESULT_EMPTY"
      && error?.upstreamDone === true
      && error?.upstreamReceipt?.outputTokens === 0);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
