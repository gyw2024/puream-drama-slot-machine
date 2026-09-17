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

test("production text attempts use twenty minutes and one receipt-aware recovery", () => {
  const options = WorkbenchWorkflow.prototype.productionTextOptions.call({
    textStageDedupeScope: WorkbenchWorkflow.prototype.textStageDedupeScope,
    operationControls: new Map(),
    setAutomation() {}
  }, "project-test", "asset_prompt", { timeoutMs: 90_000, maxReconnectAttempts: 1 });
  assert.equal(options.timeoutMs, 20 * 60_000);
  assert.equal(options.maxReconnectAttempts, 2);
});

test("production text rate-limit recovery exposes the provider wait without changing the logical task", () => {
  const updates = [];
  const options = WorkbenchWorkflow.prototype.productionTextOptions.call({
    textStageDedupeScope: WorkbenchWorkflow.prototype.textStageDedupeScope,
    operationControls: new Map(),
    setAutomation(_projectId, update) { updates.push(update); }
  }, "project-rate-limit", "topics", {});
  options.onAttemptFailure({
    retrying: true,
    attempt: 2,
    status: 429,
    code: "RESOURCE_EXHAUSTED",
    waitMs: 13_250
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "running");
  assert.match(updates[0].message, /14 秒后自动续接同一请求/);
  assert.match(updates[0].message, /任务标识保持不变/);
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

test("PUREAM retries one empty uncharged completion with the same idempotency key", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, init = {}) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length === 1) {
      return new Response('event: done\ndata: {}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return new Response([
      'event: delta\ndata: {"text":"重试成功"}',
      'event: done\ndata: {"usage":{"inputTokens":4,"outputTokens":4}}',
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
    }, [{ role: "user", content: "test" }], {
      sessionId: "logical-empty-uncharged",
      maxReconnectAttempts: 2,
      retryBaseDelayMs: 1
    });
    assert.equal(result, "重试成功");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.headers["idempotency-key"] === "logical-empty-uncharged"));
    assert.ok(calls.every(call => call.body.clientRequestId === "logical-empty-uncharged"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM timeout covers a stalled SSE body after response headers", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  const startedAt = Date.now();
  try {
    await assert.rejects(generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "TEST-AUTH-CODE",
      model: "gpt-5-6-sol",
      maxTokens: 512
    }, [{ role: "user", content: "test" }], {
      sessionId: "logical-stalled-sse",
      timeoutMs: 30,
      __testOnlyTimeoutMs: 30,
      maxReconnectAttempts: 1
    }), error => error?.code === "PROVIDER_TIMEOUT");
    assert.equal(calls, 1);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    global.fetch = originalFetch;
  }
});
