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
  assert.doesNotMatch(topicSource, /timeoutMs:\s*300_000/);
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
