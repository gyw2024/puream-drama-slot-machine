"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { generateText, parsePureamSse, parseStructuredJson } = require("../app/ai-provider");
const {
  WorkbenchWorkflow,
  normalizeTopicOptions,
  recoverTopicOptionsFromDiagnostics,
  topicJsonParseOptions
} = require("../app/workbench-workflow");

function validTopicFixture() {
  const relationships = ["母女", "父子", "婆媳", "邻里", "师生", "夫妻", "兄妹", "同事", "医患", "老友"];
  return relationships.map((relationship, index) => ({
    title: `选题${index + 1}`,
    genre: "家庭伦理",
    relationship,
    storyMechanism: ["rescue_repaid", "kindness_misjudged", "sacrifice_repaid", "evidence_reversal"][index % 4],
    logline: `第${index + 1}个故事梗概`,
    hook: `第${index + 1}个危机动作`,
    highlights: [`冲突${index + 1}`, `反转${index + 1}`, `清算${index + 1}`],
    valueStatement: "善意要有证据",
    proofChain: "两条线索互证",
    reversal: "真相公开",
    emotionalPayoff: "误会被行动化解"
  }));
}

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

test("a pre-response transport interruption resumes under one logical request id", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, init = {}) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length === 1) {
      const error = new Error("net::ERR_EMPTY_RESPONSE");
      error.code = "ERR_EMPTY_RESPONSE";
      throw error;
    }
    return new Response([
      'event: delta\ndata: {"text":"recovered"}',
      'event: done\ndata: {"sessionId":"server-session","charge_cents":0,"billing_status":"charged"}',
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const text = await generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.invalid",
      apiKey: "test-only",
      model: "claude-opus-5"
    }, [{ role: "user", content: "test" }], { sessionId: "topic-logical-request" });
    assert.equal(text, "recovered");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.headers["idempotency-key"] === "topic-logical-request"));
    assert.ok(calls.every(call => call.body.clientRequestId === "topic-logical-request"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("user cancellation interrupts text recovery without another provider request", async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
  };
  try {
    const pending = generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.invalid",
      apiKey: "test-only",
      model: "claude-opus-5"
    }, [{ role: "user", content: "test" }], { sessionId: "cancel-logical-request", signal: controller.signal });
    setTimeout(() => controller.abort(Object.assign(new Error("用户已暂停"), { code: "PROVIDER_REQUEST_ABORTED" })), 25);
    await assert.rejects(pending, error => error?.code === "PROVIDER_REQUEST_ABORTED");
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("topic generation has no total deadline", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const topicStart = source.indexOf("async generateTopicOptions");
  const scriptStart = source.indexOf("async generateCompleteScript", topicStart);
  const topicSource = source.slice(topicStart, scriptStart);
  assert.match(topicSource, /this\.productionTextOptions\(projectId, "topics"/);
  assert.doesNotMatch(topicSource, /timeoutMs:\s*(?:45_000|60_000|300_000)/);
});

test("OpenAI-compatible domestic providers retry fetch failures with one logical request id", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, init = {}) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length === 1) throw Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await generateText({
      kind: "kimi-native",
      baseUrl: "https://api.moonshot.invalid/v1",
      apiKey: "test-only",
      model: "kimi-k3"
    }, [{ role: "user", content: "test" }], {
      sessionId: "kimi-logical-request",
      json: true,
      requiredKeys: ["ok"],
      retryBaseDelayMs: 1
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.headers["idempotency-key"] === "kimi-logical-request"));
    assert.ok(calls.every(call => call.headers["x-client-request-id"] === "kimi-logical-request"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("unlimited production reconnect survives beyond the historic retry cap with one idempotency key", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, init = {}) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length <= 6) throw Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
    return new Response([
      'event: delta\ndata: {"text":"recovered after six interruptions"}',
      'event: done\ndata: {"sessionId":"same-request","charge_cents":0,"billing_status":"charged"}',
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const value = await generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.invalid",
      apiKey: "test-only",
      model: "claude-opus-5"
    }, [{ role: "user", content: "test" }], {
      sessionId: "unlimited-logical-request",
      timeoutMs: 0,
      maxReconnectAttempts: 0,
      retryBaseDelayMs: 1
    });
    assert.equal(value, "recovered after six interruptions");
    assert.equal(calls.length, 7);
    assert.ok(calls.every(call => call.headers["idempotency-key"] === "unlimited-logical-request"));
    assert.ok(calls.every(call => call.body.clientRequestId === "unlimited-logical-request"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("topic JSON parser accepts a root array without weakening other schemas", () => {
  const topics = validTopicFixture();
  const parsed = parseStructuredJson(JSON.stringify(topics), topicJsonParseOptions());
  assert.deepEqual(parsed.topics, topics);
  assert.equal(normalizeTopicOptions(parsed).length, 10);
  assert.throws(
    () => parseStructuredJson(JSON.stringify(topics), { requiredKeys: ["shots"] }),
    error => error?.code === "MODEL_JSON_INVALID"
  );
});

test("topic diversity is an optional audit, while the ten-item production shape stays required", () => {
  const topics = validTopicFixture().map((item, index) => ({
    ...item,
    title: index === 0 ? "同一个标题" : "同一个标题",
    relationship: "同一关系"
  }));
  assert.throws(() => normalizeTopicOptions({ topics }), error => error?.code === "TOPIC_DIVERSITY_INVALID");
  const accepted = normalizeTopicOptions({ topics }, { enforceDiversity: false });
  assert.equal(accepted.length, 10);
  assert.equal(new Set(accepted.map(item => item.title)).size, 1);
  assert.throws(
    () => normalizeTopicOptions({ topics: topics.slice(0, 9) }, { enforceDiversity: false }),
    error => error?.code === "TOPIC_DIVERSITY_INVALID"
  );
});

test("video technical audit is controlled by the videos quality module", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const generateStart = source.indexOf("async generateShotVideo");
  const auditStart = source.indexOf("async auditTechnicalShotCandidate", generateStart);
  const generateSource = source.slice(generateStart, auditStart);
  assert.doesNotMatch(generateSource, /else\s+await this\.auditTechnicalShotCandidate/);
  assert.match(generateSource, /options\.audit !== false && this\.qualityGatesEnabled\(settings, "videos"\)/);
});

test("legacy checkpoint reversal review is controlled by the production-structure blueprint", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const scriptStart = source.indexOf("async generateCompleteScript");
  const pipelineStart = source.indexOf("async runIdeaToFullPipeline", scriptStart);
  const scriptSource = source.slice(scriptStart, pipelineStart);
  assert.match(
    scriptSource,
    /if \(productionStructureGateEnabled\(settings, project\)\) \{\s*assertShotPlanCheckpointReversalContract/
  );
});

test("stitching assigns per-shot technical review to videos and final review to delivery", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const stitchStart = source.indexOf("async stitchProject");
  const stitchSource = source.slice(stitchStart);
  const technicalStart = stitchSource.indexOf("const orderedShotsForIntegrity");
  const technicalPrefix = stitchSource.slice(Math.max(0, technicalStart - 240), technicalStart);
  assert.match(technicalPrefix, /if \(this\.qualityGatesEnabled\(settings, "videos"\)\)/);
  assert.doesNotMatch(technicalPrefix, /if \(deliveryQualityEnabled\)/);
  assert.match(stitchSource, /if \(!deliveryQualityEnabled\) \{/);
});

test("topic JSON parser accepts common aliases and deeply wrapped fenced arrays", () => {
  const topics = validTopicFixture();
  const alias = parseStructuredJson(JSON.stringify({ items: topics }), topicJsonParseOptions());
  assert.deepEqual(alias.topics, topics);

  const wrapped = JSON.stringify({
    choices: [{ message: { content: `模型结果如下：\n\`\`\`json\n${JSON.stringify(topics)}\n\`\`\`` } }]
  });
  const deep = parseStructuredJson(wrapped, topicJsonParseOptions());
  assert.deepEqual(deep.topics, topics);
  const proseWrapped = parseStructuredJson(`中转返回如下：${wrapped}\n请查收。`, topicJsonParseOptions());
  assert.deepEqual(proseWrapped.topics, topics);
});

test("a valid saved topic response is recovered locally with no second provider call", async () => {
  const rawText = JSON.stringify(validTopicFixture());
  const sha256 = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");
  let project = {
    id: "project-topic-recovery",
    activity: [],
    ideation: { status: "failed", errorCode: "MODEL_JSON_INVALID", requestSessionId: "topic-session-1" },
    textProviderDiagnostics: {
      failures: [{
        id: "failure-1",
        operation: "topic_ideation",
        code: "MODEL_JSON_INVALID",
        sessionId: "topic-session-1",
        rawText,
        rawTextLength: rawText.length,
        rawTextSha256: sha256,
        rawTextTruncated: false
      }]
    }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {} }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-topic-test", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: "cost-topic-test" }),
    saveProject: next => {
      project = structuredClone(next);
      return structuredClone(project);
    }
  };
  let providerCalls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    textGenerator: async () => {
      providerCalls += 1;
      return { topics: validTopicFixture().map((item, index) => ({ ...item, title: `重新生成${index + 1}` })) };
    }
  });
  const recovered = recoverTopicOptionsFromDiagnostics(project);
  assert.equal(recovered.status, "recovered");
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(providerCalls, 0);
  assert.equal(result.ideation.status, "ready");
  assert.equal(result.ideation.topics.length, 10);
  assert.match(result.ideation.message, /未再次提交上游/);
  const regenerated = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(providerCalls, 1, "a deliberate regeneration after recovery must call the provider once");
  assert.equal(regenerated.ideation.topics[0].title, "重新生成1");
});

test("topic recovery refuses truncated or hash-mismatched diagnostics", () => {
  const rawText = JSON.stringify(validTopicFixture());
  const result = recoverTopicOptionsFromDiagnostics({
    ideation: { requestSessionId: "topic-session-2" },
    textProviderDiagnostics: {
      failures: [{
        operation: "topic_ideation",
        code: "MODEL_JSON_INVALID",
        sessionId: "topic-session-2",
        rawText,
        rawTextLength: rawText.length,
        rawTextSha256: "0".repeat(64),
        rawTextTruncated: false
      }]
    }
  });
  assert.equal(result.status, "invalid");
});
