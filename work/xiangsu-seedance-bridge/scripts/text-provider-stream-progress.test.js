"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {
  MIN_GENERATION_TIMEOUT_MS,
  IMAGE_SUBMIT_TIMEOUT_MS,
  IMAGE_POLL_DEADLINE_MS,
  VIDEO_SUBMIT_TIMEOUT_MS,
  VIDEO_POLL_DEADLINE_MS,
  generateText,
  generationTimeoutMs,
  providerTimeout,
  providerFetchOpenAiStream,
  providerFetchGeminiStream,
  desktopRelayFetch,
  readVolcengineResponsesStream
} = require("../app/ai-provider");

test("PUREAM safe retry can alternate away from a stalled Electron transport", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push({ transport: "node", requestId: options.headers["idempotency-key"] });
    return new Response("replayed", { status: 200 });
  };
  try {
    const response = await desktopRelayFetch("https://relay.test/replay", {
      headers: { "idempotency-key": "stable-logical-request" }
    }, {
      preferNode: true,
      electronNetFetch: async () => {
        calls.push({ transport: "electron" });
        throw new Error("the stalled Electron transport must not be reused");
      }
    });
    assert.equal(await response.text(), "replayed");
    assert.deepEqual(calls, [{ transport: "node", requestId: "stable-logical-request" }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("production generation deadlines clamp stale short stage values to at least twenty minutes", () => {
  assert.equal(MIN_GENERATION_TIMEOUT_MS, 20 * 60_000);
  assert.equal(generationTimeoutMs(35), MIN_GENERATION_TIMEOUT_MS);
  assert.equal(generationTimeoutMs(90_000), MIN_GENERATION_TIMEOUT_MS);
  assert.equal(generationTimeoutMs(30 * 60_000), 30 * 60_000);
  assert.equal(generationTimeoutMs(0), 0, "explicit zero remains no deadline");
  assert.equal(providerTimeout({ timeoutMs: 60_000 }), MIN_GENERATION_TIMEOUT_MS,
    "Volcengine, Gemini and Anthropic generation adapters share the same floor");
  assert.ok(IMAGE_SUBMIT_TIMEOUT_MS >= MIN_GENERATION_TIMEOUT_MS);
  assert.ok(IMAGE_POLL_DEADLINE_MS >= MIN_GENERATION_TIMEOUT_MS);
  assert.ok(VIDEO_SUBMIT_TIMEOUT_MS >= MIN_GENERATION_TIMEOUT_MS);
  assert.ok(VIDEO_POLL_DEADLINE_MS >= MIN_GENERATION_TIMEOUT_MS);
  const providerSource = fs.readFileSync(require.resolve("../app/ai-provider"), "utf8");
  assert.match(providerSource, /endpoint\(config\.baseUrl, "\/images\/edits"\)[\s\S]{0,240}IMAGE_SUBMIT_TIMEOUT_MS/,
    "image edits must have the production submit watchdog");
  assert.match(providerSource, /endpoint\(config\.baseUrl, "\/images\/generations"\)[\s\S]{0,300}IMAGE_SUBMIT_TIMEOUT_MS/,
    "image generations must have the production submit watchdog");
  assert.doesNotMatch(providerSource, /endpoint\(config\.baseUrl, "\/images\/(?:edits|generations)"\)[\s\S]{0,300}\},\s*0\s*\)/,
    "billable image generation must never use an unlimited providerFetch deadline");
});

test("Volcengine unary body watchdog is cleared as soon as the response is consumed", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const activeTimers = new Set();
  global.setTimeout = (_callback, delay) => {
    const timer = { delay };
    activeTimers.add(timer);
    return timer;
  };
  global.clearTimeout = timer => { activeTimers.delete(timer); };
  try {
    const result = await readVolcengineResponsesStream({
      body: null,
      text: async () => JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
      })
    });
    assert.equal(result.text, "done");
    assert.equal(activeTimers.size, 0, "the twenty-minute body watchdog must not retain the process after success");
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("PUREAM relay timeout aborts the transport after the production idle watchdog", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Promise(() => {});
  const started = Date.now();
  try {
    await assert.rejects(
      () => generateText({
        kind: "puream-relay", baseUrl: "https://relay.test", apiKey: "test", model: "relay-test"
       }, [{ role: "user", content: "return promptly" }], {
         timeoutMs: 35,
         __testOnlyTimeoutMs: 35,
         maxReconnectAttempts: 1,
        sessionId: "puream-hard-deadline"
      }),
      error => error?.code === "PROVIDER_TIMEOUT"
    );
    assert.ok(Date.now() - started < 400, "the deterministic test watchdog must abort the stalled transport");
  } finally {
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible stream treats received chunks as progress instead of a hard wall-clock timeout", async () => {
  const originalFetch = global.fetch;
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    start(streamController) {
      const frames = [
        'data: {"choices":[{"delta":{"content":"甲"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"乙"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"丙"}}]}\n\n',
        "data: [DONE]\n\n"
      ];
      let index = 0;
      const pump = () => {
        if (cancelled) return;
        if (index >= frames.length) {
          streamController.close();
          return;
        }
        streamController.enqueue(new TextEncoder().encode(frames[index++]));
        setTimeout(pump, 15);
      };
      pump();
    },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const result = await providerFetchOpenAiStream("https://provider.test/chat/completions", {
      method: "POST",
      body: "{}"
    }, 25, { __testOnlyTimeoutMs: 25 });
    assert.equal(result.text, "甲乙丙");
    assert.equal(result.upstreamDone, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible response-header timeout wraps a read-only AbortError without masking it", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("request aborted before headers", "AbortError"));
    }, { once: true });
  });
  try {
    await assert.rejects(
      () => providerFetchOpenAiStream("https://provider.test/chat/completions", {
        method: "POST",
        body: "{}"
      }, 15, { __testOnlyTimeoutMs: 15 }),
      error => {
        assert.equal(error.code, "PROVIDER_TIMEOUT");
        assert.equal(error.message, "文本模型请求超时");
        assert.equal(error.cause?.name, "AbortError");
        assert.doesNotMatch(error.message, /Cannot set property code/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini accepted stream preserves partial text when a read-only OperationError interrupts it", async () => {
  const originalFetch = global.fetch;
  let pullCount = 0;
  global.fetch = async () => new Response(new ReadableStream({
    pull(streamController) {
      pullCount += 1;
      if (pullCount === 1) {
        streamController.enqueue(new TextEncoder().encode([
          "data: " + JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{\"topics\":[{\"title\":\"已返回选题\"}' }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
            responseId: "response-partial"
          }),
          "",
          ""
        ].join("\n")));
        return;
      }
      streamController.error(new DOMException("stream closed", "OperationError"));
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    await assert.rejects(
      () => providerFetchGeminiStream("https://gemini.test/v1beta/models/test:streamGenerateContent", {
        method: "POST",
        body: "{}"
      }, 500, { model: "gemini-test", sessionId: "gemini-readonly-error", __testOnlyTimeoutMs: 100 }),
      error => {
        assert.equal(error.code, "PROVIDER_STREAM_INTERRUPTED");
        assert.equal(error.cause?.name, "OperationError");
        assert.match(error.partialText, /已返回选题/);
        assert.ok(error.upstreamReceipt?.receiptCount >= 1);
        assert.equal(error.usageMetadata?.candidatesTokenCount, 8);
        assert.doesNotMatch(error.message, /Cannot set property code/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible stream settles at DONE even when the server keeps the socket open", async () => {
  const originalFetch = global.fetch;
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"complete"}}]}\n\n'));
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" result"}}],"usage":{"total_tokens":2}}\n\n'));
      streamController.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      // Deliberately do not close: this mirrors a keep-alive SSE connection.
    },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(new Error("DONE was not settled")), 150);
  try {
    const result = await providerFetchOpenAiStream("https://provider.test/chat/completions", {
      method: "POST",
      body: "{}",
      signal: abortController.signal
    }, 50, { maxTimeoutMs: 1_000 });
    assert.equal(result.text, "complete result");
    assert.equal(result.upstreamDone, true);
    assert.equal(result.usage.total_tokens, 2);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(abortTimer);
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible stream settles on finish_reason even without DONE", async () => {
  const originalFetch = global.fetch;
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n'));
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":2}}\n\n'));
      // Deliberately keep the stream open: a finish_reason is terminal.
    },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const result = await providerFetchOpenAiStream("https://provider.test/chat/completions", {
      method: "POST", body: "{}"
    }, 50, { maxTimeoutMs: 1_000 });
    assert.equal(result.text, "final answer");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.upstreamDone, true);
    assert.equal(cancelled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible stream never treats a socket close before a terminal frame as success", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"u\\":[{"i":1}"}}]}\n\n'));
      streamController.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    await assert.rejects(
      () => providerFetchOpenAiStream("https://provider.test/chat/completions", { method: "POST", body: "{}" }, 50),
      error => error?.code === "PROVIDER_STREAM_INCOMPLETE"
        && error?.upstreamDone === false
        && String(error?.rawResponse || "").includes("data:")
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("Coding Plan structured JSON accepts a non-stream completion", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, false);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await generateText({
      kind: "openai-compatible", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", apiKey: "test", model: "glm-test"
    }, [{ role: "user", content: "return JSON" }], { json: true, requiredKeys: ["ok"], maxReconnectAttempts: 1 });
    assert.deepEqual(result, { ok: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test("Coding Plan uses one non-stream request instead of an SSE request", async () => {
  const originalFetch = global.fetch;
  const bodies = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.stream) return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
      status: 200, headers: { "content-type": "text/event-stream" }
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await generateText({
      kind: "openai-compatible", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", apiKey: "test", model: "glm-test"
    }, [{ role: "user", content: "return JSON" }], { json: true, requiredKeys: ["ok"], maxReconnectAttempts: 1 });
    assert.deepEqual(result, { ok: true });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].stream, false);
    assert.equal(Object.hasOwn(bodies[0], "response_format"), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("structured JSON automatically continues an incomplete compatible stream with prior context", async () => {
  const originalFetch = global.fetch;
  const requestBodies = [];
  let requestCount = 0;
  const responseFor = frames => new Response(new ReadableStream({
    start(streamController) {
      for (const frame of frames) streamController.enqueue(new TextEncoder().encode(frame));
      streamController.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  global.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    requestCount += 1;
    if (requestCount === 1) {
      return responseFor([`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":' } }] })}\n\n`]);
    }
    return responseFor([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "true}" } }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
  };
  try {
    const result = await generateText({
      kind: "openai-compatible",
      baseUrl: "https://compat.test/v1",
      apiKey: "test",
      model: "compatible-test"
    }, [{ role: "user", content: "return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      sessionId: "json-continuation-test",
      maxReconnectAttempts: 1
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(requestCount, 2);
    assert.equal(requestBodies[1].messages.at(-2).role, "assistant");
    assert.equal(requestBodies[1].messages.at(-2).content, '{"ok":');
    assert.match(requestBodies[1].messages.at(-1).content, /从断点继续补齐/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("structured JSON continuation preserves a leading space inside a split string", async () => {
  const originalFetch = global.fetch;
  let requestCount = 0;
  const responseFor = frames => new Response(new ReadableStream({
    start(streamController) {
      for (const frame of frames) streamController.enqueue(new TextEncoder().encode(frame));
      streamController.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  global.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return responseFor([`data: ${JSON.stringify({ choices: [{ delta: { content: '{"message":"hello' } }] })}\n\n`]);
    }
    return responseFor([
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' world"}' } }] })}\n\n`,
      "data: [DONE]\n\n"
    ]);
  };
  try {
    const result = await generateText({
      kind: "openai-compatible", baseUrl: "https://compat.test/v1", apiKey: "test", model: "compatible-test"
    }, [{ role: "user", content: "return JSON" }], {
      json: true, requiredKeys: ["message"], maxReconnectAttempts: 1
    });
    assert.deepEqual(result, { message: "hello world" });
    assert.equal(requestCount, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("structured JSON continuation preserves trailing whitespace from the interrupted fragment", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const continuation = requests.length > 1;
    const payload = continuation
      ? 'data: {"choices":[{"delta":{"content":"world\\\"}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      : 'data: {"choices":[{"delta":{"content":"{\\\"message\\\":\\\"hello "}}]}\n\n';
    return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  try {
    const result = await generateText({
      kind: "openai-compatible",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      timeoutMs: 3_000,
    }, [{ role: "user", content: "return structured JSON" }], { json: true });
    assert.deepEqual(result, { message: "hello world" });
    assert.equal(requests.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("an interrupted JSON suffix preserves non-root progress and continues from that exact point", async () => {
  const originalFetch = global.fetch;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response('data: {"choices":[{"delta":{"content":"{\\"message\\":\\"hello"}}]}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    if (requestCount === 2) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
          setTimeout(() => controller.error(new TypeError("suffix socket interrupted")), 0);
        }
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"\\\"}"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await generateText({
      kind: "openai-compatible", baseUrl: "https://compat.test/v1", apiKey: "test", model: "compatible-test"
    }, [{ role: "user", content: "return JSON" }], {
      json: true,
      requiredKeys: ["message"],
      maxReconnectAttempts: 1,
      maxJsonContinuationAttempts: 2
    });
    assert.deepEqual(result, { message: "hello world" });
    assert.equal(requestCount, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Kimi completed reasoning-only response is never replayed as a fresh paid JSON request", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  const responseFor = frames => new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return responseFor([
        'data: {"choices":[{"delta":{"reasoning_content":"Need inspect the JSON example first."},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n"
      ]);
    }
    return responseFor([
      'data: {"choices":[{"delta":{"content":"{\\"u\\":[{\\"i\\":1}]}"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n"
    ]);
  };
  try {
    await assert.rejects(() => generateText({
        kind: "kimi-native", baseUrl: "https://kimi.test/v1", apiKey: "test", model: "kimi-k3"
      }, [{ role: "user", content: "Return a JSON u array." }], {
        json: true, requiredKeys: ["u"], sessionId: "kimi-reasoning-reset", maxReconnectAttempts: 1
      }), error => error?.code === "TEXT_RESULT_EMPTY"
        && error?.upstreamDone === true
        && error?.noAutomaticRetry === true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning_effort, "low");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini and Anthropic malformed replies normalize saved output without a blind whole-request reset", async () => {
  const originalFetch = global.fetch;
  const providers = [
    {
      config: { kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash" },
      first: { candidates: [{ content: { parts: [{ text: "I should explain first." }] } }] },
      second: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }
    },
    {
      config: { kind: "anthropic-native", baseUrl: "https://anthropic.test/v1", apiKey: "test", model: "claude-test" },
      first: { content: [{ type: "text", text: "Here is an explanation." }] },
      second: { content: [{ type: "text", text: '{"ok":true}' }] }
    }
  ];
  try {
    for (const provider of providers) {
      const requests = [];
      global.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return new Response(JSON.stringify(requests.length === 1 ? provider.first : provider.second), {
          status: 200, headers: { "content-type": "application/json" }
        });
      };
      const result=await generateText(provider.config, [{ role: "user", content: "Return JSON." }], {
        json: true, requiredKeys: ["ok"], sessionId: `${provider.config.kind}-reset`
      });
      assert.deepEqual(result,{ok:true});assert.equal(requests.length,2);
      assert.ok(JSON.stringify(requests[1]).includes('originalSavedResponse'));
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible SSE heartbeats cannot extend the text-stage timeout", async () => {
  const originalFetch = global.fetch;
  let heartbeatTimer = null;
  global.fetch = async (_url, options) => new Response(new ReadableStream({
    start(streamController) {
      const heartbeat = () => {
        streamController.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
        heartbeatTimer = setTimeout(heartbeat, 5);
      };
      options.signal.addEventListener("abort", () => {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        streamController.error(new Error("aborted by timeout"));
      }, { once: true });
      heartbeat();
    },
    cancel() { if (heartbeatTimer) clearTimeout(heartbeatTimer); }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    await assert.rejects(
      () => providerFetchOpenAiStream("https://provider.test/chat/completions", {
        method: "POST", body: "{}"
      }, 30, { __testOnlyTimeoutMs: 30 }),
      error => error?.code === "PROVIDER_TIMEOUT"
    );
  } finally {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    global.fetch = originalFetch;
  }
});

test("Kimi, OpenAI and compatible providers all release a completed keep-alive SSE stream", async () => {
  const originalFetch = global.fetch;
  const providers = [
    { kind: "kimi-native", baseUrl: "https://kimi.test/v1", apiKey: "test", model: "kimi-k3" },
    { kind: "openai-native", baseUrl: "https://openai.test/v1", apiKey: "test", model: "gpt-test" },
    { kind: "openai-compatible", baseUrl: "https://compat.test/v1", apiKey: "test", model: "compatible-test" }
  ];
  let cancels = 0;
  global.fetch = async () => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":""}}],"usage":{"total_tokens":1}}\n\n'));
      streamController.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    },
    cancel() { cancels += 1; }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    for (const provider of providers) {
      const result = await generateText(provider, [{ role: "user", content: "test" }], {
        timeoutMs: 50,
        maxReconnectAttempts: 1
      });
      assert.equal(result, "ok");
    }
    assert.equal(cancels, providers.length);
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM relay also settles its done event without waiting for socket close", async () => {
  const originalFetch = global.fetch;
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"relay complete"}\n\n'));
      streamController.enqueue(new TextEncoder().encode('event: done\ndata: {"outputTokens":2,"billing_status":"charged"}\n\n'));
      // Keep the stream open to prove that the terminal event is sufficient.
    },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const result = await generateText({
      kind: "puream-relay",
      baseUrl: "https://relay.test",
      apiKey: "test",
      model: "relay-model"
    }, [{ role: "user", content: "test" }], {
      timeoutMs: 50,
      maxReconnectAttempts: 1
    });
    assert.equal(result, "relay complete");
    assert.equal(cancelled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM relay valid deltas renew idle time without an equal total deadline", async () => {
  const originalFetch = global.fetch;
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const frames = [
        'event: delta\ndata: {"text":"甲"}\n\n',
        'event: delta\ndata: {"text":"乙"}\n\n',
        'event: delta\ndata: {"text":"丙"}\n\n',
        'event: done\ndata: {"outputTokens":3,"billing_status":"charged"}\n\n'
      ];
      let index = 0;
      const pump = () => {
        if (cancelled) return;
        if (index >= frames.length) return;
        controller.enqueue(new TextEncoder().encode(frames[index++]));
        setTimeout(pump, 15);
      };
      pump();
    },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const result = await generateText({
      kind: "puream-relay", baseUrl: "https://relay.test", apiKey: "test", model: "relay-model"
    }, [{ role: "user", content: "test" }], {
      timeoutMs: 25,
      __testOnlyTimeoutMs: 25,
      maxReconnectAttempts: 1,
      sessionId: "puream-progress-idle"
    });
    assert.equal(result, "甲乙丙");
    assert.equal(cancelled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible pre-header timeout is response-unknown and never blindly reconnects", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("idle", "AbortError")), { once: true });
      });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(() => generateText({
      kind: "openai-compatible", baseUrl: "https://compat.test/v1", apiKey: "test", model: "test"
    }, [{ role: "user", content: "test" }], {
      timeoutMs: 15,
      __testOnlyTimeoutMs: 15,
      maxReconnectAttempts: 2,
      retryBaseDelayMs: 1,
      sessionId: "same-timeout-request"
    }), error => error?.code === "PROVIDER_TIMEOUT"
      && error?.requestDispatchUncertain === true
      && error?.noAutomaticRetry === true
      && error?.retryRequiresExplicitResume === true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["idempotency-key"], "same-timeout-request");
    assert.equal(calls[0].headers["x-client-request-id"], "same-timeout-request");
  } finally {
    global.fetch = originalFetch;
  }
});

test("OpenAI-compatible timeout after partial output never replays the whole request", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"paid prefix"}}]}\n\n'));
        options.signal.addEventListener("abort", () => controller.error(new DOMException("idle", "AbortError")), { once: true });
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(() => generateText({
      kind: "openai-compatible", baseUrl: "https://compat.test/v1", apiKey: "test", model: "test"
    }, [{ role: "user", content: "test" }], {
      timeoutMs: 15,
      __testOnlyTimeoutMs: 15,
      maxReconnectAttempts: 3,
      retryBaseDelayMs: 1,
      sessionId: "partial-timeout-request"
    }), error => error?.code === "PROVIDER_TIMEOUT" && error?.partialText === "paid prefix");
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM relay timeout after a paid prefix preserves evidence and never reconnects", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"官网已付费前缀"}\n\n'));
        options.signal.addEventListener("abort", () => controller.error(new DOMException("idle", "AbortError")), { once: true });
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(() => generateText({
      kind: "puream-relay", baseUrl: "https://relay.test", apiKey: "test", model: "relay"
    }, [{ role: "user", content: "test" }], {
      timeoutMs: 15,
      __testOnlyTimeoutMs: 15,
      maxReconnectAttempts: 3,
      retryBaseDelayMs: 1,
      sessionId: "puream-partial-timeout"
    }), error => error?.code === "PROVIDER_TIMEOUT" && error?.partialText === "官网已付费前缀");
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("PUREAM first-byte timeout stays recoverable and reconnects with one logical request id", async () => {
  const originalFetch = global.fetch;
  const bodies = [];
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) {
      return new Response([
        'event: relay\ndata: {"status":"connecting"}',
        'event: error\ndata: {"code":"CHAT_FIRST_BYTE_TIMEOUT","message":"UPSTREAM_TIMEOUT_RETRY","retryable":true}',
        ''
      ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response([
      'event: delta\ndata: {"text":"{\\"ok\\":true}"}',
      'event: done\ndata: {"inputTokens":10,"outputTokens":5,"billing_status":"charged"}',
      ''
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await generateText({
      kind: "puream-relay", baseUrl: "https://relay.test", apiKey: "test", model: "relay"
    }, [{ role: "user", content: "return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      maxReconnectAttempts: 2,
      retryBaseDelayMs: 1,
      sessionId: "puream-first-byte-same-request"
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].clientRequestId, "puream-first-byte-same-request");
    assert.equal(bodies[1].clientRequestId, "puream-first-byte-same-request");
    assert.equal(bodies[0].sessionId, bodies[1].sessionId);
  } finally {
    global.fetch = originalFetch;
  }
});

test("structured pre-response failure does not manufacture a no-replay receipt", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response([
      'event: relay\ndata: {"status":"connecting"}',
      'event: error\ndata: {"code":"CHAT_FIRST_BYTE_TIMEOUT","message":"UPSTREAM_TIMEOUT_RETRY","retryable":true}',
      ''
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(() => generateText({
      kind: "puream-relay", baseUrl: "https://relay.test", apiKey: "test", model: "relay"
    }, [{ role: "user", content: "return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      maxReconnectAttempts: 1,
      sessionId: "puream-first-byte-checkpoint"
    }), error => error?.code === "PUREAM_TEXT_STREAM_ERROR"
      && error?.upstreamCode === "CHAT_FIRST_BYTE_TIMEOUT"
      && error?.noAutomaticRetry === false
      && !String(error?.partialText || "").trim());
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("structured JSON suffix continuation is capped at two paid calls by default", async () => {
  const originalFetch = global.fetch;
  const bodies = [];
  const response = (content, terminal) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
      if (terminal) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return response('{"ok":', false);
    if (bodies.length === 2) return response("true", true);
    return response(',"tail":1', true);
  };
  try {
    await assert.rejects(() => generateText({
      kind: "openai-compatible", baseUrl: "https://compat.test/v1", apiKey: "test", model: "test"
    }, [{ role: "user", content: "return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      maxReconnectAttempts: 1,
      sessionId: "bounded-json-continuation"
      ,autoNormalizeOutput:false // Test the suffix cap independently of normalization.
    }), error => error?.code === "MODEL_JSON_INVALID"
      && error?.noAutomaticRetry === true
      && error?.jsonContinuationAttempts === 2
      && error?.maxJsonContinuationAttempts === 2
      && String(error?.partialText || "").startsWith('{"ok":true'));
    assert.equal(bodies.length, 3, "one initial request plus two suffix continuations");
  } finally {
    global.fetch = originalFetch;
  }
});
