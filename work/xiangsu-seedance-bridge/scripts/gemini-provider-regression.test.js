"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEXT_PROVIDER_CATALOG,
  GEMINI_MODEL_CAPABILITIES
} = require("../app/text-provider-catalog");
const {
  generateText,
  listTextProviderModels,
  providerModelCapability,
  providerFetch
} = require("../app/ai-provider");

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function sseResponse(frames, onCancel = () => {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
    },
    cancel: onCancel
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function closedSseResponse(frames) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function pacedSseResponse(frames, intervalMs = 12) {
  return new Response(new ReadableStream({
    start(controller) {
      frames.forEach((frame, index) => {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
          if (index === frames.length - 1) controller.close();
        }, intervalMs * (index + 1));
      });
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("Gemini fallback catalog is capability-aware and defaults to 3.7 Flash", async () => {
  assert.equal(TEXT_PROVIDER_CATALOG["gemini-native"].defaultModel, "gemini-3.7-flash");
  assert.ok(GEMINI_MODEL_CAPABILITIES.length >= TEXT_PROVIDER_CATALOG["gemini-native"].models.length);
  assert.equal(new Set(GEMINI_MODEL_CAPABILITIES.map(item => item.id)).size, GEMINI_MODEL_CAPABILITIES.length);
  assert.deepEqual(providerModelCapability("gemini-native", "models/gemini-3.7-flash"), {
    id: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    category: "text",
    textCompatible: true,
    selectable: true,
    lifecycle: "stable",
    supportedGenerationMethods: ["generateContent"]
  });
  assert.equal(providerModelCapability("gemini-native", "gemini-3.1-flash-tts-preview").textCompatible, false);
  assert.equal(providerModelCapability("gemini-native", "gemini-3.1-flash-tts-preview").selectable, false);
  const fallback = await listTextProviderModels({ kind: "gemini-native" });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.models.length, TEXT_PROVIDER_CATALOG["gemini-native"].models.length);
  assert.ok(fallback.models.every(item => item.textCompatible === true && item.selectable === true));
  assert.equal(fallback.models[0].id, "gemini-3.7-flash");
  assert.equal(fallback.models.some(item => item.id === "gemini-3.1-flash-lite-preview"), false);
  assert.equal(fallback.models.some(item => item.id === "gemini-3-pro-preview"), false);
  assert.equal(fallback.models.some(item => item.id === "gemini-omni-flash"), false);
  assert.equal(providerModelCapability("gemini-native", "gemini-omni-flash").selectable, false);
  assert.equal(providerModelCapability("gemini-native", "gemini-omni-flash").inputTokenLimit, 0);
  assert.equal(providerModelCapability("gemini-native", "gemini-omni-flash-preview").selectable, false);
  assert.equal(providerModelCapability("gemini-native", "veo-3.1-fast-generate-preview").selectable, false);
  assert.equal(providerModelCapability("gemini-native", "gemini-embedding-2").lifecycle, "stable");
  assert.equal(fallback.models.some(item => item.id === "gemini-embedding-2-preview"), false);
  for (const id of ["imagen-4.0-generate-001", "imagen-4.0-ultra-generate-001", "imagen-4.0-fast-generate-001"]) {
    assert.equal(providerModelCapability("gemini-native", id).lifecycle, "shutdown");
    assert.equal(providerModelCapability("gemini-native", id).selectable, false);
    assert.equal(fallback.models.some(item => item.id === id), false);
  }
  assert.deepEqual(Object.keys(fallback.models[0]), [
    "id", "displayName", "inputTokenLimit", "outputTokenLimit", "category", "textCompatible", "selectable", "lifecycle", "supportedGenerationMethods"
  ]);
});

test("Gemini model discovery paginates, keeps incompatible categories visible, and never returns credentials", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: options.headers });
    if (requests.length === 1) return jsonResponse({
      models: [
        {
          name: "models/gemini-3.7-flash",
          displayName: "Remote Gemini 3.7 Flash",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent", "countTokens"]
        },
        {
          name: "models/text-embedding-only",
          displayName: "Embedding only",
          inputTokenLimit: 2048,
          outputTokenLimit: 1,
          supportedGenerationMethods: ["embedContent"]
        }
      ],
      nextPageToken: "page two"
    });
    return jsonResponse({
      models: [{
        name: "models/future-text-model",
        displayName: "Future Text Model",
        inputTokenLimit: 500000,
        outputTokenLimit: 50000,
        supportedGenerationMethods: ["generateContent"]
      }]
    });
  };
  try {
    const result = await listTextProviderModels({
      kind: "gemini-native",
      baseUrl: "https://gemini.test/v1beta",
      apiKey: "mock-secret"
    });
    assert.equal(result.source, "remote");
    assert.deepEqual(result.models.map(item => item.id), ["gemini-3.7-flash", "future-text-model", "text-embedding-only"]);
    assert.equal(result.models[1].textCompatible, true);
    assert.equal(result.models[1].selectable, true);
    assert.equal(result.models[1].outputTokenLimit, 50000);
    assert.equal(result.models[2].category, "embedding");
    assert.equal(result.models[2].textCompatible, false);
    assert.equal(result.models[2].selectable, false);
    assert.equal(result.models[2].inputTokenLimit, 2048);
    assert.equal(result.models.some(item => item.id === "gemini-3.6-flash"), false, "remote account inventory is authoritative and is not merged with fallback entries");
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /pageToken=page\+two/);
    assert.equal(requests[0].headers["x-goog-api-key"], "mock-secret");
    assert.doesNotMatch(JSON.stringify(result), /mock-secret|x-goog-api-key|gemini\.test/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini discovery failure is a non-blocking full fallback", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("offline with mock-secret"); };
  try {
    const result = await listTextProviderModels({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "mock-secret", timeoutMs: 20
    });
    assert.equal(result.source, "fallback");
    assert.equal(result.models.length, TEXT_PROVIDER_CATALOG["gemini-native"].models.length);
    assert.ok(result.models.every(item => item.textCompatible === true && item.selectable === true));
    assert.doesNotMatch(JSON.stringify(result), /offline|mock-secret|gemini\.test/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini discovery accepts the documented /models collection URL without duplicating the path", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    return jsonResponse({ models: [] });
  };
  try {
    const result = await listTextProviderModels({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta/models", apiKey: "mock-secret"
    });
    assert.deepEqual(result, { models: [], source: "remote" });
    assert.equal(requests[0], "https://gemini.test/v1beta/models?pageSize=1000");
    assert.doesNotMatch(requests[0], /models\/models/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini generation accepts the documented /models collection URL without duplicating the path", async () => {
  const originalFetch = global.fetch;
  let requestUrl = "";
  global.fetch = async (url) => {
    requestUrl = String(url);
    return sseResponse([{
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }]
    }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native",
      baseUrl: "https://gemini.test/v1beta/models",
      apiKey: "test",
      model: "gemini-3.7-flash"
    }, [{ role: "user", content: "test" }]);
    assert.equal(result, "ok");
    assert.equal(requestUrl, "https://gemini.test/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse");
    assert.doesNotMatch(requestUrl, /models\/models/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("remote shutdown text and dedicated generateContent models stay visible but cannot be selected", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({
    models: [
      {
        name: "models/gemini-3.1-flash-lite-preview",
        displayName: "Retired text",
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ["generateContent"]
      },
      {
        name: "models/gemini-omni-flash-preview",
        displayName: "Gemini Omni Flash",
        inputTokenLimit: 131072,
        outputTokenLimit: 32768,
        supportedGenerationMethods: ["generateContent"]
      }
    ]
  });
  try {
    const result = await listTextProviderModels({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "mock-secret"
    });
    assert.equal(result.source, "remote");
    const retired = result.models.find(item => item.id === "gemini-3.1-flash-lite-preview");
    assert.equal(retired.lifecycle, "shutdown");
    assert.equal(retired.textCompatible, true);
    assert.equal(retired.selectable, false);
    const omni = result.models.find(item => item.id === "gemini-omni-flash-preview");
    assert.equal(omni.category, "video");
    assert.equal(omni.outputTokenLimit, 32768, "remote metadata is retained even though the current text adapter cannot use it");
    assert.equal(omni.textCompatible, false);
    assert.equal(omni.selectable, false);
    assert.doesNotMatch(JSON.stringify(result), /mock-secret|gemini\.test|x-goog-api-key/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a successful empty account inventory remains authoritative instead of silently exposing fallback models", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ models: [] });
  try {
    const result = await listTextProviderModels({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "mock-secret"
    });
    assert.deepEqual(result, { models: [], source: "remote" });
  } finally {
    global.fetch = originalFetch;
  }
});

test("an authoritative empty Gemini inventory blocks the static default before network use", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("must not reach network"); };
  try {
    const capability = providerModelCapability("gemini-native", "gemini-3.7-flash", { modelCapabilities: [] });
    assert.equal(capability.selectable, false);
    await assert.rejects(
      () => generateText({
        kind: "gemini-native",
        baseUrl: "https://gemini.test/v1beta",
        apiKey: "test",
        model: "gemini-3.7-flash",
        modelCapabilities: []
      }, [{ role: "user", content: "Return JSON" }]),
      error => error?.code === "PROVIDER_MODEL_INCOMPATIBLE"
    );
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini generation rejects unknown, shutdown, and dedicated endpoints before any upstream request", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("must not reach network"); };
  try {
    for (const model of ["unknown-gemini-model", "gemini-3.1-flash-lite-preview", "gemini-omni-flash-preview"]) {
      await assert.rejects(
        () => generateText({
          kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model
        }, [{ role: "user", content: "test" }]),
        error => error?.code === "PROVIDER_MODEL_INCOMPATIBLE" && error?.model === model
      );
    }
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini 3.x streams JSON with responseFormat, omits legacy fields and sampling, and reports real usage", async () => {
  const originalFetch = global.fetch;
  let request;
  let cancelled = false;
  global.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return sseResponse([
      { candidates: [{ content: { parts: [{ text: '{"ok":' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: "true}" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 101,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 7,
          totalTokenCount: 113,
          cachedContentTokenCount: 11
        },
        responseId: "response-1",
        modelVersion: "gemini-3.7-flash-001"
      }
    ], () => { cancelled = true; });
  };
  const deltas = [];
  const usages = [];
  const responseJsonSchema = {
    type: "object",
    required: ["ok"],
    properties: { ok: { type: "boolean" } }
  };
  try {
    const result = await generateText({
      kind: "gemini-native",
      baseUrl: "https://gemini.test/v1beta",
      apiKey: "test",
      model: "gemini-3.7-flash",
      temperature: 0.2,
      maxTokens: 100000
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      responseJsonSchema,
      maxTokens: 8192,
      reasoningEffort: "low",
      onDelta: value => deltas.push(value),
      onUsage: value => usages.push(value)
    });
    assert.deepEqual(result, { ok: true });
    assert.match(request.url, /gemini-3\.7-flash:streamGenerateContent\?alt=sse$/);
    assert.equal(request.body.generationConfig.maxOutputTokens, 65536);
    assert.deepEqual(request.body.generationConfig.responseFormat, {
      text: { mimeType: "APPLICATION_JSON", schema: responseJsonSchema }
    });
    assert.equal(Object.hasOwn(request.body.generationConfig, "responseMimeType"), false);
    assert.equal(Object.hasOwn(request.body.generationConfig, "responseJsonSchema"), false);
    assert.equal(Object.hasOwn(request.body.generationConfig, "temperature"), false);
    assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingLevel: "low" });
    assert.deepEqual(deltas, ['{"ok":', '{"ok":true}']);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].inputTokens, 101);
    assert.equal(usages[0].candidateTokens, 5);
    assert.equal(usages[0].reasoningTokens, 7);
    assert.equal(usages[0].outputTokens, 12);
    assert.equal(usages[0].totalTokens, 113);
    assert.equal(usages[0].requestId, "response-1");
    assert.equal(cancelled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini accepts complete structured JSON at EOF even when finishReason is absent", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const usages = [];
  global.fetch = async () => {
    calls += 1;
    return closedSseResponse([{
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
      responseId: "complete-without-finish"
    }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      onUsage: usage => usages.push(usage)
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].requestId, "complete-without-finish");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini continues a receipted partial JSON prefix instead of replaying the whole request", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  const usages = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return closedSseResponse([{
        candidates: [{ content: { parts: [{ text: '{"ok":' }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
        responseId: "paid-prefix-receipt"
      }]);
    }
    return sseResponse([{
      candidates: [{ content: { parts: [{ text: "true}" }] }, finishReason: "STOP" }],
      responseId: "continuation-receipt"
    }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      maxJsonResetAttempts: 2,
      onUsage: usage => usages.push(usage)
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 2, "the paid prefix is continued once, never reset and replayed");
    assert.equal(Object.hasOwn(requests[1].generationConfig, "responseFormat"), false, "continuation requests only ask for the missing suffix");
    assert.equal(requests[1].contents.some(item => item.role === "model"), false, "Gemini continuation never fabricates an unsigned model turn");
    const continuationContext = requests[1].contents.map(item => item.parts?.map(part => part.text || "").join("") || "").join("\n");
    assert.match(continuationContext, /\{"ok":/);
    assert.match(continuationContext, /只输出紧接该前缀之后的剩余 JSON 字符/);
    assert.doesNotMatch(continuationContext, /结构化重试轮次/);
    assert.equal(usages.length, 1, "the interrupted paid prefix keeps its usage receipt");
    assert.equal(usages[0].inputTokens, 8);
    assert.equal(usages[0].candidateTokens, 2);
    assert.equal(usages[0].requestId, "paid-prefix-receipt");
    assert.match(usages[0].sessionId, /json-continue|gemini-/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini usage or responseId receipt blocks an empty whole-request replay and exposes count-only diagnostics", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const opaqueResponseId = "opaque-receipt-123";
  global.fetch = async () => {
    calls += 1;
    return closedSseResponse([{
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 0, totalTokenCount: 9 },
      responseId: opaqueResponseId
    }]);
  };
  try {
    await assert.rejects(
      () => generateText({
        kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "top-secret-api-key", model: "gemini-3.7-flash"
      }, [{ role: "user", content: "sensitive prompt body" }], {
        json: true,
        requiredKeys: ["ok"],
        maxJsonResetAttempts: 2
      }),
      error => {
        assert.equal(error?.code, "PROVIDER_STREAM_INCOMPLETE");
        assert.equal(error?.noAutomaticRetry, true);
        assert.deepEqual(error?.upstreamReceipt, {
          receiptCount: 2,
          usageFieldCount: 3,
          responseIdChars: opaqueResponseId.length,
          finishReasonChars: 0,
          blockReasonChars: 0,
          doneFrameCount: 0
        });
        assert.equal(error?.providerDiagnostics?.frameCount, 1);
        assert.equal(error?.providerDiagnostics?.textPartCount, 0);
        assert.equal(error?.providerDiagnostics?.textChars, 0);
        assert.equal(error?.providerDiagnostics?.receiptCount, 2);
        assert.ok(error?.providerDiagnostics?.rawChars > 0);
        const serializedDiagnostics = JSON.stringify({
          receipt: error?.upstreamReceipt,
          diagnostics: error?.providerDiagnostics
        });
        assert.doesNotMatch(serializedDiagnostics, /top-secret-api-key|sensitive prompt body|opaque-receipt-123/);
        return true;
      }
    );
    assert.equal(calls, 1, "a receipted response is never replayed as a fresh JSON request");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini finishReason on malformed JSON is propagated as a receipt and repaired only by suffix continuation", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return sseResponse([{
        candidates: [{ content: { parts: [{ text: '{"ok":' }] }, finishReason: "MAX_TOKENS" }]
      }]);
    }
    return sseResponse([{
      candidates: [{ content: { parts: [{ text: "true}" }] }, finishReason: "STOP" }]
    }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      maxJsonResetAttempts: 2
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 2);
    const continuationContext = requests[1].contents.map(item => item.parts?.map(part => part.text || "").join("") || "").join("\n");
    assert.match(continuationContext, /\{"ok":/);
    assert.doesNotMatch(continuationContext, /结构化重试轮次/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini 2.5 keeps the legacy JSON schema fields without responseFormat", async () => {
  const originalFetch = global.fetch;
  let request;
  const responseJsonSchema = {
    type: "object",
    required: ["topics"],
    properties: { topics: { type: "array", items: { type: "string" } } }
  };
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return sseResponse([{ candidates: [{ content: { parts: [{ text: '{"topics":[]}' }] }, finishReason: "STOP" }] }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native",
      baseUrl: "https://gemini.test/v1beta",
      apiKey: "test",
      model: "gemini-2.5-flash",
      temperature: 0.2
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["topics"],
      responseJsonSchema,
      thinkingBudget: 512
    });
    assert.deepEqual(result, { topics: [] });
    assert.deepEqual(request.generationConfig, {
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
      responseJsonSchema,
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: 512 }
    });
    assert.equal(Object.hasOwn(request.generationConfig, "responseFormat"), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini renews its idle watchdog on stream progress instead of enforcing a total stage deadline", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => pacedSseResponse([
    { candidates: [{ content: { parts: [{ text: '{"ok":' }] } }] },
    { candidates: [{ content: { parts: [{ text: "true" }] } }] },
    { candidates: [{ content: { parts: [{ text: "}" }] }, finishReason: "STOP" }] }
  ], 12);
  try {
    const startedAt = Date.now();
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["ok"],
      __testOnlyTimeoutMs: 20
    });
    assert.deepEqual(result, { ok: true });
    assert.ok(Date.now() - startedAt > 20, "total generation may exceed one idle interval while each frame still makes progress");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini request construction uses the selected models.list limits instead of guessed static limits", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }]
    });
  };
  try {
    await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test",
      model: "gemini-3.7-flash", maxTokens: 100000
    }, [{ role: "user", content: "test" }]);
    await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test",
      model: "future-text-model", maxTokens: 100000, temperature: 0.4,
      modelInputTokenLimit: 500000,
      modelOutputTokenLimit: 50000,
      modelCategory: "text",
      modelLifecycle: "available",
      modelTextCompatible: true,
      modelSelectable: true,
      modelSupportedGenerationMethods: ["generateContent"]
    }, [{ role: "user", content: "test" }]);
    await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test",
      model: "gemma-4-26b-a4b-it", maxTokens: 100000, temperature: 0.4
    }, [{ role: "user", content: "test" }], { reasoningEffort: "low" });
    assert.equal(requests[0].generationConfig.maxOutputTokens, 65536);
    assert.equal(Object.hasOwn(requests[0].generationConfig, "temperature"), false);
    assert.equal(requests[1].generationConfig.maxOutputTokens, 50000);
    assert.equal(requests[1].generationConfig.temperature, 0.4);
    assert.equal(requests[2].generationConfig.maxOutputTokens, 32768);
    assert.equal(requests[2].generationConfig.temperature, 0.4);
    assert.deepEqual(requests[2].generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini JSON continuation carries the paid prefix as user text, never an unsigned model prefill", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"{\\"ok\\":"}]}}]}\n\n', {
        status: 200, headers: { "content-type": "text/event-stream" }
      });
    }
    return sseResponse([{ candidates: [{ content: { parts: [{ text: "true}" }] }, finishReason: "STOP" }] }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true, requiredKeys: ["ok"], maxJsonResetAttempts: 0
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].contents.some(item => item.role === "model"), false);
    assert.match(requests[1].contents.map(item => item.parts?.[0]?.text || "").join("\n"), /\{"ok":/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini content blocks are terminal and never become paid JSON retries", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ promptFeedback: { blockReason: "SAFETY" } });
  };
  try {
    await assert.rejects(
      () => generateText({
        kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
      }, [{ role: "user", content: "Return JSON" }], { json: true, requiredKeys: ["ok"] }),
      error => error?.code === "PROVIDER_CONTENT_BLOCKED" && error?.blockReason === "SAFETY"
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini retries only an explicit empty high-demand admission response and keeps one session", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const failures = [];
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        error: {
          code: 503,
          status: "UNAVAILABLE",
          message: "This model is currently experiencing high demand. Please try again later."
        }
      }, 503, { "retry-after": "0" });
    }
    return sseResponse([{
      candidates: [{ content: { parts: [{ text: '{"topics":[]}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      responseId: "gemini-recovered"
    }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["topics"],
      sessionId: "stable-topic-session",
      geminiAdmissionAttempts: 3,
      geminiAdmissionRetryBaseDelayMs: 1,
      onAttemptFailure: item => failures.push(item)
    });
    assert.deepEqual(result, { topics: [] });
    assert.equal(calls, 2);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].retrying, true);
    assert.equal(failures[0].sessionId, "stable-topic-session");
    assert.equal(failures[0].status, 503);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini default admission recovery crosses a five-request quota window without replaying provider output", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const failures = [];
  global.fetch = async () => {
    calls += 1;
    if (calls <= 5) {
      return jsonResponse({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota window closed. Please retry in 0s."
        }
      }, 429, { "retry-after": "0" });
    }
    return sseResponse([{
      candidates: [{ content: { parts: [{ text: '{"topics":[]}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      responseId: "gemini-after-quota-window"
    }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["topics"],
      sessionId: "quota-window-session",
      geminiAdmissionRetryBaseDelayMs: 1,
      onAttemptFailure: item => failures.push(item)
    });
    assert.deepEqual(result, { topics: [] });
    assert.equal(calls, 6);
    assert.equal(failures.length, 5);
    assert.equal(failures.every(item => item.retrying && item.sessionId === "quota-window-session"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini honours one finite daily-labelled RetryInfo probe, then pauses a real daily quota", async () => {
  const originalFetch = global.fetch;
  try {
    let calls = 0;
    const failures = [];
    const waits = [];
    global.fetch = async () => {
      calls += 1;
      if (calls > 1) {
        return sseResponse([{
          candidates: [{ content: { parts: [{ text: '{"topics":[]}' }] }, finishReason: "STOP" }],
          responseId: "daily-label-boundary-recovered"
        }]);
      }
      return jsonResponse({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "You exceeded your current quota. Please retry in 13.688357343s.",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{
                quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
              }]
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "13.688357343s" }
          ]
        }
      }, 429);
    };
    const recovered = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["topics"],
      sessionId: "daily-labelled-stable-session",
      __testOnlyGeminiAdmissionSleep: async delay => { waits.push(delay); },
      onAttemptFailure: item => failures.push(item)
    });
    assert.deepEqual(recovered, { topics: [] });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [14438]);
    assert.equal(failures[0].retrying, true);
    assert.equal(failures[0].sessionId, "daily-labelled-stable-session");
    assert.equal(failures[0].quotaWindow, "hard");
    assert.ok(failures[0].quotaIds.includes("GenerateRequestsPerDayPerProjectPerModel-FreeTier"));

    calls = 0;
    failures.length = 0;
    global.fetch = async () => {
      calls += 1;
      return jsonResponse({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Free tier request quota exhausted.",
          details: [{
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{
              quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
              quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
            }]
          }]
        }
      }, 429);
    };
    await assert.rejects(
      () => generateText({
        kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
      }, [{ role: "user", content: "Return JSON" }], {
        json: true,
        requiredKeys: ["topics"],
        onAttemptFailure: item => failures.push(item)
      }),
      error => error?.code === "PROVIDER_DAILY_QUOTA_EXHAUSTED"
        && error?.quotaWindow === "hard"
        && error?.retryable === true
        && error?.retryRequiresExplicitResume === true
        && error?.noAutomaticRetry === true
        && error?.quotaIds?.includes("GenerateRequestsPerDayPerProjectPerModel-FreeTier")
    );
    assert.equal(calls, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].retrying, false);
    assert.equal(failures[0].quotaWindow, "hard");

    calls = 0;
    failures.length = 0;
    global.fetch = async () => {
      calls += 1;
      return jsonResponse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Transient quota window" } }, 429, { "retry-after": "2" });
    };
    await assert.rejects(
      () => generateText({
        kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
      }, [{ role: "user", content: "Return JSON" }], {
        json: true,
        requiredKeys: ["topics"],
        __testOnlyGeminiMaximumAutomaticAdmissionTotalWaitMs: 1000,
        onAttemptFailure: item => failures.push(item)
      }),
      error => error?.code === "PROVIDER_RATE_LIMITED"
    );
    assert.equal(calls, 1, "a single Retry-After cannot exceed the whole-stage wait budget");
    assert.equal(failures[0].retrying, false);
    assert.equal(failures[0].maximumRetryDelayMs, 1000);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini transient admission recovery is governed by total wait budget, not the former twelve-attempt ceiling", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const failures = [];
  global.fetch = async () => {
    calls += 1;
    if (calls <= 13) {
      return jsonResponse({
        error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Transient quota window. Please retry in 0s." }
      }, 429, { "retry-after": "0" });
    }
    return sseResponse([{ candidates: [{ content: { parts: [{ text: '{"topics":[]}' }] }, finishReason: "STOP" }] }]);
  };
  try {
    const result = await generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["topics"],
      geminiAdmissionRetryBaseDelayMs: 1,
      __testOnlyGeminiMaximumAutomaticAdmissionWaitMs: 2_000,
      __testOnlyGeminiMaximumAutomaticAdmissionTotalWaitMs: 2_000,
      __testOnlyGeminiAdmissionSleep: async () => {},
      onAttemptFailure: item => failures.push(item)
    });
    assert.deepEqual(result, { topics: [] });
    assert.equal(calls, 14);
    assert.equal(failures.length, 13);
    assert.equal(failures.every(item => item.retrying), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("direct provider HTTP errors distinguish invalid limits, region, model, and rate quota", async () => {
  const originalFetch = global.fetch;
  const cases = [
    {
      response: () => jsonResponse({ error: { status: "INVALID_ARGUMENT", message: "maxOutputTokens exceeds token limit" } }, 400),
      code: "PROVIDER_MODEL_LIMIT_INVALID"
    },
    {
      response: () => jsonResponse({ error: { status: "PERMISSION_DENIED", message: "User location is not supported for the API use." } }, 403),
      code: "PROVIDER_REGION_UNSUPPORTED"
    },
    {
      response: () => jsonResponse({ error: { status: "NOT_FOUND", message: "model does not exist" } }, 404),
      code: "PROVIDER_MODEL_UNAVAILABLE"
    },
    {
      response: () => jsonResponse({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, 429, { "retry-after": "2" }),
      code: "PROVIDER_RATE_LIMITED",
      retryAfterMs: 2000
    },
    {
      response: () => jsonResponse({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded. Please retry in 44.757070551s." } }, 429),
      code: "PROVIDER_RATE_LIMITED",
      retryAfterMs: 44757
    }
  ];
  try {
    for (const item of cases) {
      global.fetch = async () => item.response();
      await assert.rejects(
        () => providerFetch("https://provider.test/request", { method: "POST" }, 1000),
        error => error?.code === item.code
          && (item.retryAfterMs === undefined || error.retryAfterMs === item.retryAfterMs)
          && error?.code !== "PROVIDER_BALANCE_REQUIRED"
      );
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini never truncates the provider Retry-After quota window to the old 15-second cap", async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  const failures = [];
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Please retry in 16s."
      }
    }, 429);
  };
  try {
    await assert.rejects(() => generateText({
      kind: "gemini-native", baseUrl: "https://gemini.test/v1beta", apiKey: "test", model: "gemini-3.7-flash"
    }, [{ role: "user", content: "Return JSON" }], {
      json: true,
      requiredKeys: ["topics"],
      signal: controller.signal,
      geminiAdmissionAttempts: 3,
      onAttemptFailure: item => {
        failures.push(item);
        controller.abort();
      }
    }));
    assert.equal(calls, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].retryAfterMs, 16000);
    assert.equal(failures[0].retryDelayMs, 16750);
  } finally {
    global.fetch = originalFetch;
  }
});
