"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateText, parsePureamSse } = require("../app/ai-provider");

test("desktop parser accepts the early relay frame and later topic payload", () => {
  const parsed = parsePureamSse([
    'event: relay',
    'data: {"status":"connecting"}',
    '',
    ': puream-connecting',
    '',
    'event: meta',
    'data: {"sessionId":"s1","modelSlug":"claude-opus-5"}',
    '',
    'event: delta',
    'data: {"text":"{\\"topics\\":[]}"}',
    '',
    'event: done',
    'data: {"outputTokens":8,"billing_status":"charged"}',
    ''
  ].join("\n"));
  assert.equal(parsed.text, '{"topics":[]}');
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsed.streamError, "");
  assert.ok(parsed.events.some(item => item.event === "done"));
});

test("desktop parser preserves a server stream error code", () => {
  const parsed = parsePureamSse('event: error\ndata: {"code":"UPSTREAM_NETWORK_ERROR","message":"文本模型连接失败，请稍后重试"}\n\n');
  assert.equal(parsed.streamErrorCode, "UPSTREAM_NETWORK_ERROR");
  assert.match(parsed.streamError, /连接失败/);
});

test("a transport interruption performs exactly one provider request", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const error = new Error("net::ERR_EMPTY_RESPONSE");
    error.code = "ERR_EMPTY_RESPONSE";
    throw error;
  };
  try {
    await assert.rejects(
      generateText({
        kind: "puream-relay",
        baseUrl: "https://puream.invalid",
        apiKey: "test-only",
        model: "claude-opus-5"
      }, [{ role: "user", content: "test" }], { timeoutMs: 30_000 }),
      error => error?.code === "PUREAM_TRANSPORT_INTERRUPTED" && error?.noAutomaticRetry === true
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("topic generation allows five minutes for a long reasoning response", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const topicStart = source.indexOf("async generateTopicOptions");
  const scriptStart = source.indexOf("async generateCompleteScript", topicStart);
  const topicSource = source.slice(topicStart, scriptStart);
  assert.match(topicSource, /timeoutMs:\s*300_000/);
});

