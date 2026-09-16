"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateText } = require("../app/ai-provider");

function quotaResponse(quotaId, retryDelay = "0.05s") {
  return new Response(JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: `Quota exceeded. Please retry in ${retryDelay}.`,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId, quotaMetric: "provider.example/generate_requests" }]
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }
      ]
    }
  }), { status: 429, headers: { "content-type": "application/json" } });
}

function completedSse(text = "ok") {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("all text providers honor a transient 429 window and resume the same logical request", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  const waits = [];
  global.fetch = async (_url, options) => {
    requests.push(options);
    return requests.length === 1
      ? quotaResponse("GenerateRequestsPerMinutePerProjectPerModel")
      : completedSse("recovered");
  };
  try {
    const result = await generateText({
      kind: "openai-compatible",
      baseUrl: "https://provider.test/v1",
      apiKey: "test",
      model: "vendor-model"
    }, [{ role: "user", content: "test" }], {
      sessionId: "stable-rate-limit-request",
      maxReconnectAttempts: 1,
      __testOnlyTextRateLimitMaximumWaitMs: 2_000,
      __testOnlyTextRateLimitSleep: async delay => { waits.push(delay); }
    });
    assert.equal(result, "recovered");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers["idempotency-key"], "stable-rate-limit-request");
    assert.equal(requests[1].headers["idempotency-key"], "stable-rate-limit-request");
    assert.deepEqual(waits, [1000]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("daily RPD exhaustion permits at most one provider-directed boundary probe and never loops", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const waits = [];
  global.fetch = async () => {
    calls += 1;
    return quotaResponse("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
  };
  try {
    await assert.rejects(() => generateText({
      kind: "openai-compatible",
      baseUrl: "https://provider.test/v1",
      apiKey: "test",
      model: "vendor-model"
    }, [{ role: "user", content: "test" }], {
      sessionId: "stable-daily-quota-request",
      maxReconnectAttempts: 1,
      __testOnlyTextRateLimitMaximumWaitMs: 2_000,
      __testOnlyTextRateLimitSleep: async delay => { waits.push(delay); }
    }), error => error?.code === "PROVIDER_DAILY_QUOTA_EXHAUSTED"
      && error?.retryRequiresExplicitResume === true
      && error?.noAutomaticRetry === true);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1000]);
  } finally {
    global.fetch = originalFetch;
  }
});
