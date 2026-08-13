"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { generateText } = require("../app/ai-provider");

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
