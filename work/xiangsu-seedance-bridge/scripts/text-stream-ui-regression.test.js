"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateText } = require("../app/ai-provider");

const provider = {
  kind: "kimi-native",
  baseUrl: "https://api.moonshot.test/v1",
  apiKey: "test-key",
  model: "kimi-k3",
  maxTokens: 1024
};

function sseResponse(chunks, headers = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers }
  });
}

test("Kimi compatible transport requests SSE and persists cumulative deltas and usage", async () => {
  const previousFetch = global.fetch;
  const requests = [];
  const deltas = [];
  const receipts = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sseResponse([
      'data: {"id":"req-kimi-1","choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
      'data: {"id":"req-kimi-1","choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"req-kimi-1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
      "data: [DONE]\n\n"
    ], { "x-request-id": "header-kimi-1" });
  };
  try {
    const result = await generateText(provider, [{ role: "user", content: "return json" }], {
      json: true,
      timeoutMs: 2_000,
      maxReconnectAttempts: 1,
      reasoningEffort: "low",
      sessionId: "logical-kimi-1",
      onDelta: value => deltas.push(value),
      onUsage: value => receipts.push(value)
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.equal(requests[0].reasoning_effort, "low");
    assert.deepEqual(deltas, ['{"ok":', '{"ok":true}']);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].total_tokens, 16);
    assert.equal(receipts[0].requestId, "req-kimi-1");
    assert.equal(receipts[0].sessionId, "logical-kimi-1");
  } finally {
    global.fetch = previousFetch;
  }
});

test("reasoning-only compatible streams are never surfaced as deliverable text", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"first "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"second"},"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  try {
    await assert.rejects(
      () => generateText(provider, [{ role: "user", content: "think" }], {
        timeoutMs: 2_000,
        maxReconnectAttempts: 1
      }),
      error => error?.code === "TEXT_RESULT_EMPTY" && error?.reasoningOnly === true
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test("a disconnected stream with partial output is preserved and never replayed", async () => {
  const previousFetch = global.fetch;
  const encoder = new TextEncoder();
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    let sent = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          return;
        }
        controller.error(new Error("socket closed"));
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(
      generateText(provider, [{ role: "user", content: "long answer" }], {
        timeoutMs: 2_000,
        maxReconnectAttempts: 3,
        retryBaseDelayMs: 1
      }),
      error => {
        assert.equal(error.code, "PROVIDER_STREAM_INTERRUPTED");
        assert.equal(error.partialText, "partial");
        return true;
      }
    );
    assert.equal(fetchCount, 1);
  } finally {
    global.fetch = previousFetch;
  }
});

test("an explicit unsupported-stream response falls back once without streaming", async () => {
  const previousFetch = global.fetch;
  const bodies = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.stream === true) {
      return new Response(JSON.stringify({ error: { message: "stream is not supported" } }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "fallback-ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await generateText(provider, [{ role: "user", content: "answer" }], {
      timeoutMs: 2_000,
      maxReconnectAttempts: 1
    });
    assert.equal(result, "fallback-ok");
    assert.deepEqual(bodies.map(item => item.stream), [true, false]);
  } finally {
    global.fetch = previousFetch;
  }
});

test("workbench keeps pause/resume controls on one operation-state source", () => {
  const root = path.join(__dirname, "..");
  const renderer = fs.readFileSync(path.join(root, "app", "renderer", "workbench.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "app", "renderer", "workbench.html"), "utf8");
  const workflow = fs.readFileSync(path.join(root, "app", "workbench-workflow.js"), "utf8");
  assert.match(html, /id="pausePipeline"[^>]*>暂停任务<\/button>/);
  assert.match(renderer, /frontendPipeline\?\.active === true/);
  assert.match(renderer, /pauseButton\.textContent = pending \? "暂停中…" : active \? "暂停任务" : "继续任务"/);
  assert.match(renderer, /runPipelineLong\(message, \(\) => api\.workbench\.runPipelineFromStage/);
  assert.match(renderer, /renderPipelineControls\(project\);[\s\S]{0,180}ensureScriptLivePolling\(\)/);
  assert.match(renderer, /mutatingActionBlockedWhileRunning\(action\)/);
  assert.match(renderer, /当前任务正在运行，请先暂停任务后再修改生产内容/);
  const topicOptions = workflow.slice(workflow.indexOf('costOperation: "topic_ideation"'), workflow.indexOf('costOperation: "topic_ideation"') + 900);
  assert.match(topicOptions, /maxReconnectAttempts: 2/);
  assert.match(topicOptions, /autoContinueJson: false/);
  assert.doesNotMatch(topicOptions, /maxReconnectAttempts: UNLIMITED_ATTEMPTS/);
});
