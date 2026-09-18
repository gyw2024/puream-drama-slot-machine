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
  topicIdeationRuntimePrompt,
  topicSlotMatrix,
  topicJsonParseOptions,
  topicResponseJsonSchema,
  topicResultDiagnostic,
  topicProductReadiness,
  topicProductContext,
  topicProductContextMatches,
  topicProductContextDelta,
  synchronizeTopicProductContextForWriting,
  ideaScriptBootstrapGaps,
  ideaSignature,
  ideaSignatureMatchesProject,
  REFERENCE_STORY_KERNELS
} = require("../app/workbench-workflow");
const { priorTopicPatterns, rememberTopicBatch } = require("../app/foundry/topic-diversity");

function validTopicFixture() {
  const relationships = ["母女", "父子", "婆媳", "邻里", "师生", "夫妻", "兄妹", "同事", "医患", "老友"];
  return relationships.map((relationship, index) => ({
    title: `选题${index + 1}`,
    genre: index % 2 ? "现实情感" : "社会善意",
    relationship,
    referenceKernel: `K${String((index % 15) + 1).padStart(2, "0")}`,
    storyMechanism: ["rescue_repaid", "kindness_misjudged", "sacrifice_repaid", "evidence_reversal"][index % 4],
    logline: `第${index + 1}个故事梗概`,
    hook: `第${index + 1}个危机动作`,
    highlights: [`冲突${index + 1}`, `反转${index + 1}`, `清算${index + 1}`],
    valueStatement: "善意要有证据",
    proofChain: "两条线索互证",
    reversal: "真相公开",
    emotionalPayoff: "误会被行动化解",
    productPlacement: "此前需求→此刻使用→可见结果→关系变化"
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

test("topic generation uses the shared twenty-minute window and one safe recovery", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const topicStart = source.indexOf("async generateTopicOptions");
  const scriptStart = source.indexOf("async generateCompleteScript", topicStart);
  const topicSource = source.slice(topicStart, scriptStart);
  assert.match(topicSource, /this\.productionTextOptions\(projectId, "topics"/);
  assert.match(topicSource, /timeoutMs:\s*TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.doesNotMatch(topicSource, /timeoutMs:\s*90_000/);
  assert.match(topicSource, /maxReconnectAttempts:\s*2/);
  assert.match(topicSource, /autoContinueJson:\s*false/);
});

test("OpenAI-compatible domestic providers checkpoint ambiguous socket failures without replay", async () => {
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
    await assert.rejects(() => generateText({
      kind: "kimi-native",
      baseUrl: "https://api.moonshot.invalid/v1",
      apiKey: "test-only",
      model: "kimi-k3"
    }, [{ role: "user", content: "test" }], {
      sessionId: "kimi-logical-request",
      json: true,
      requiredKeys: ["ok"],
      retryBaseDelayMs: 1
    }), error => error?.code === "UND_ERR_SOCKET"
      && error?.requestDispatchUncertain === true
      && error?.noAutomaticRetry === true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["idempotency-key"], "kimi-logical-request");
    assert.equal(calls[0].headers["x-client-request-id"], "kimi-logical-request");
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

test("topic source prompt opens creative space and only borrows the reference story kernel", () => {
  const prompt = topicIdeationRuntimePrompt({ prompts: {}, promptModes: {} }, { generation: { videoEngine: "hailuo-h3" } });
  // Creative freedom: causal-chain-different stories, no fixed relationship /
  // location / evidence / reversal quota filling.
  assert.match(prompt, /先构思因果链不同的故事/);
  assert.match(prompt, /不按固定关系、地点、证据或反转配额填空/);
  // Commerce handling is explained inline, not as a separate system module, and
  // non-commerce never implants a product.
  assert.match(prompt, /带货模式说明此前可见需求|带货模式说明需求如何从剧情发生/);
  assert.match(prompt, /非带货不植入/);
  // Confirmed/unaffected content is preserved across transport continuation.
  assert.match(prompt, /保留未受影响的内容和用户确认版本/);
  assert.match(prompt, /Preserve completed cards on transport continuation/);
  assert.equal(REFERENCE_STORY_KERNELS.length, 0);
  assert.doesNotMatch(prompt, /K01 带货案例 R01/);
  assert.doesNotMatch(prompt, /K19 带货案例 R25/);
  // The fixed-quota / slot-filling wording is gone; only the task schema is required.
  assert.doesNotMatch(prompt, /机制配额固定|conflictDomain 必须各不相同/);
  assert.match(prompt, /T01–T10/);
});

test("topic schema asks for ten while the runtime transport can close on a non-empty partial result", () => {
  const schema = topicResponseJsonSchema(10);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["topics"]);
  assert.equal(schema.properties.topics.minItems, 10);
  assert.equal(schema.properties.topics.maxItems, 10);
  const card = schema.properties.topics.items;
  assert.ok(card.required.includes("title"));
  assert.ok(card.required.includes("logline"));
  assert.ok(card.required.includes("hook"));
  assert.ok(card.required.includes("reversal"));
  assert.ok(card.required.includes("emotionalPayoff"));
  assert.ok(card.required.includes("productPlacement"));
  assert.ok(!card.required.includes("firstDialogue"));
  const partialSchema = topicResponseJsonSchema(10, { allowPartial: true });
  assert.equal(partialSchema.properties.topics.minItems, 1);
  assert.equal(partialSchema.properties.topics.maxItems, 10);
  assert.equal(card.properties.highlights.minItems, 3);
  assert.equal(card.properties.highlights.maxItems, 3);
  assert.deepEqual(card.properties.storyMechanism.enum, [
    "rescue_repaid", "kindness_misjudged", "sacrifice_repaid", "evidence_reversal"
  ]);
});

test("a product present requires complete product details before topic generation", () => {
  // commerceMode is derived from product presence: a name or image makes the
  // project "natural"; otherwise it is "none" and no product gating applies.
  assert.deepEqual(topicProductReadiness({ product: {} }), {
    commerceMode: "none", required: false, ready: true, missing: []
  });
  const missing = topicProductReadiness({ product: { name: "暖心阅读灯" } });
  assert.equal(missing.commerceMode, "natural");
  assert.equal(missing.required, true);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ["上传商品图"]);
  const readyProject = {
    product: { imagePath: __filename, name: "暖心阅读灯", sellingPoints: "柔和阅读光；旋钮调节", price: "29.9元", offer: "无促销", purchaseInstructions: "点击左下角头像进入橱窗购买" }
  };
  assert.equal(topicProductReadiness(readyProject).commerceMode, "natural");
  assert.equal(topicProductReadiness(readyProject).ready, true);
});

test("commerce mode with incomplete product context stops locally without calling or charging the text model", async () => {
  let project = {
    id: "project-commerce-product-first",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: { imagePath: "", name: "暖心阅读灯", sellingPoints: "" },
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {}, generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    saveProject: next => { project = structuredClone(next); return structuredClone(project); }
  };
  let providerCalls = 0;
  const workflow = new WorkbenchWorkflow({ store, textGenerator: async () => { providerCalls += 1; return { topics: validTopicFixture() }; } });
  const result = await workflow.generateTopicOptions(project.id);
  assert.equal(providerCalls, 0);
  assert.equal(result.ideation.status, "waiting_product");
  assert.equal(result.ideation.errorCode, "");
  assert.match(result.ideation.message, /商品资料锁定后.*生成选题/);
});

test("complete commerce product context is sent upstream and bound to the generated topic batch", async () => {
  let project = {
    id: "project-commerce-context-bound",
    activity: [],
    ideation: { status: "draft", topics: [] },
    productionPlan: { commerceMode: "natural" },
    product: { imagePath: __filename, name: "暖心阅读灯", sellingPoints: "柔和阅读光；旋钮调节；定时关闭", price: "29.9元", offer: "无促销", purchaseInstructions: "点击左下角头像进入橱窗购买" },
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {}, generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-commerce", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: "cost-commerce" }),
    saveProject: next => { project = structuredClone(next); return structuredClone(project); }
  };
  let userPrompt = "";
  const workflow = new WorkbenchWorkflow({
    store,
    textGenerator: async (_config, messages) => {
      userPrompt = messages.filter(item => item.role === "user").map(item => item.content).join("\n");
      return { topics: validTopicFixture() };
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.match(userPrompt, /锁定商品名称：暖心阅读灯/);
  assert.match(userPrompt, /用户确认卖点：柔和阅读光；旋钮调节；定时关闭/);
  assert.match(userPrompt, /此前需求、此刻使用原因、具体使用动作、客观可见结果、关系或决定变化/);
  assert.doesNotMatch(userPrompt, /当前可能带货商品名称/);
  assert.equal(result.ideation.topicProductContext.name, "暖心阅读灯");
  assert.equal(topicProductContextMatches(result), true);
  assert.deepEqual(ideaScriptBootstrapGaps({ ...result, ideation: { ...result.ideation, selectedTopicId: result.ideation.topics[0].id } }), []);
});

test("topic-to-script product context tolerates persistence formatting and image relocation", () => {
  const original = {
    productionPlan: { commerceMode: "natural", scriptFormat: "production" },
    product: { imagePath: __filename, name: "暖心阅读灯", sellingPoints: "柔和阅读光；旋钮调节", price: "29.9元", offer: "无促销", purchaseInstructions: "点击左下角头像进入橱窗购买" },
    ideation: { topics: [{ ...validTopicFixture()[0], id: "topic-1" }], selectedTopicId: "topic-1" }
  };
  original.ideation.topicProductContext = topicProductContext(original);
  const persisted = {
    ...original,
    product: {
      ...original.product,
      imagePath: path.join(__dirname, "..", "package.json"),
      name: "  暖心 阅读灯  ",
      sellingPoints: "柔和阅读光、 旋钮调节。"
    }
  };
  assert.equal(topicProductContextMatches(persisted), true);
  assert.deepEqual(topicProductContextDelta(persisted).changes, ["imagePath"]);
  assert.deepEqual(ideaScriptBootstrapGaps(persisted), []);
});

test("changed product details automatically rebind the selected paid topic instead of blocking writing", () => {
  const project = {
    activity: [],
    productionPlan: { commerceMode: "natural", scriptFormat: "production" },
    product: { imagePath: __filename, name: "护眼台灯", sellingPoints: "柔光；定时关闭", price: "29.9元", offer: "无促销", purchaseInstructions: "点击左下角头像进入橱窗购买" },
    ideation: {
      status: "failed",
      errorCode: "TOPIC_PRODUCT_CONTEXT_STALE",
      selectedTopicId: "topic-1",
      topics: [{ ...validTopicFixture()[0], id: "topic-1", title: "门口那盏灯", productPlacement: "旧商品在结尾出现" }],
      topicProductContext: {
        commerceMode: "natural",
        name: "旧保温杯",
        sellingPoints: "保温",
        imagePath: "D:/old/product.png"
      }
    }
  };
  assert.equal(topicProductContextMatches(project), false);
  assert.deepEqual(ideaScriptBootstrapGaps(project), []);
  const synchronized = synchronizeTopicProductContextForWriting(project, "2026-08-25T00:00:00.000Z");
  assert.equal(synchronized.changed, true);
  assert.equal(synchronized.semanticChanged, true);
  assert.equal(project.ideation.status, "topic_selected");
  assert.equal(project.ideation.errorCode, "");
  assert.equal(project.ideation.topicProductContext.name, "护眼台灯");
  assert.equal(project.ideation.topicProductSynchronization.previousProductPlacement, "旧商品在结尾出现");
  assert.match(project.ideation.topics[0].productPlacement, /当前唯一商品锁：护眼台灯/);
  assert.match(project.ideation.topics[0].productPlacement, /当前唯一卖点锁：柔光;定时关闭/);
  assert.match(project.ideation.message, /无需重新抽题/);
  assert.equal(project.activity[0].type, "topic_product_auto_adapted");
});

test("legacy writing checkpoints migrate across path and harmless formatting changes", () => {
  const project = {
    productionPlan: { commerceMode: "natural", scriptFormat: "production" },
    product: { imagePath: __filename, name: "暖心阅读灯", sellingPoints: "柔和阅读光；旋钮调节" },
    ideation: { selectedTopicId: "topic-1" }
  };
  const legacy = JSON.stringify({
    topicId: "topic-1",
    productName: " 暖心 阅读灯 ",
    sellingPoints: "柔和阅读光、旋钮调节。",
    imagePath: "D:/old/location/product.png",
    scriptFormat: "production"
  });
  assert.equal(ideaSignatureMatchesProject(legacy, project), true);
  assert.equal(ideaSignatureMatchesProject(JSON.stringify({
    topicId: "topic-1",
    productName: "护眼台灯",
    sellingPoints: "柔光",
    imagePath: "D:/old/location/product.png",
    scriptFormat: "production"
  }), project), false);
  assert.match(ideaSignature(project), /\"version\":2/);
  assert.doesNotMatch(ideaSignature(project), /imagePath/);
});

test("commerce mode changes adapt the topic and never resume a script from the wrong mode", () => {
  const project = {
    activity: [],
    productionPlan: { commerceMode: "none", scriptFormat: "production" },
    product: {},
    ideation: {
      selectedTopicId: "topic-1",
      topics: [{ ...validTopicFixture()[0], id: "topic-1", title: "灯亮以后", productPlacement: "暖心阅读灯帮助母女和解" }],
      topicProductContext: {
        commerceMode: "natural",
        name: "暖心阅读灯",
        sellingPoints: "柔和阅读光",
        imagePath: __filename
      }
    }
  };
  const oldCommerceSignature = JSON.stringify({
    version: 2,
    topicId: "topic-1",
    commerceMode: "natural",
    productName: "暖心阅读灯",
    sellingPoints: "柔和阅读光",
    scriptFormat: "production"
  });
  assert.equal(ideaSignatureMatchesProject(oldCommerceSignature, project), false);
  const result = synchronizeTopicProductContextForWriting(project, "2026-08-25T00:00:00.000Z");
  assert.equal(result.semanticChanged, true);
  assert.match(project.ideation.topics[0].productPlacement, /当前唯一创作模式是不带货/);
  assert.equal(project.ideation.topicProductContext.commerceMode, "none");
  assert.deepEqual(ideaScriptBootstrapGaps(project), []);
});

test("one-click pipeline reuses a completed legacy-signature script instead of charging for a rewrite", async () => {
  const legacySignature = JSON.stringify({
    topicId: "topic-1",
    productName: "暖心 阅读灯",
    sellingPoints: "柔和阅读光、旋钮调节。",
    imagePath: "D:/old/location/product.png",
    scriptFormat: "production"
  });
  let project = {
    id: "legacy-complete-script",
    productionPlan: { commerceMode: "natural", scriptFormat: "production" },
    generation: { mode: "storyboard_sheet", modeConfirmed: true },
    product: { imagePath: __filename, name: "暖心阅读灯", sellingPoints: "柔和阅读光；旋钮调节" },
    ideation: { selectedTopicId: "topic-1", topics: [{ id: "topic-1", title: "灯亮以后" }] },
    script: { raw: "已完成制作稿", ideaSignature: legacySignature },
    shots: [{ id: "S01", number: 1, duration: 5 }]
  };
  const store = {
    getProject: () => structuredClone(project),
    saveProject: next => { project = structuredClone(next); return structuredClone(project); }
  };
  const workflow = new WorkbenchWorkflow({ store, textGenerator: async () => { throw new Error("should not call provider"); } });
  let rewrites = 0;
  workflow.generateCompleteScript = async () => { rewrites += 1; };
  workflow.runFullPipeline = async () => ({ ok: true, reused: true });
  const result = await workflow.runIdeaToFullPipeline(project.id, { track: false });
  assert.deepEqual(result, { ok: true, reused: true });
  assert.equal(rewrites, 0);
});

test("topic-to-script entry has no stale-product terminal guard in backend or UI", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const start = workflow.indexOf("async generateCompleteScript");
  const end = workflow.indexOf("async analyzeScript", start);
  const entry = workflow.slice(start, end > start ? end : start + 12000);
  assert.match(entry, /synchronizeTopicProductContextForWriting\(project\)/);
  assert.doesNotMatch(workflow, /TOPIC_PRODUCT_CONTEXT_STALE/);
  assert.doesNotMatch(renderer, /重新生成适配当前商品的选题/);
});

test("script page puts product setup before topic generation and explains the zero-charge prerequisite", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.ok(html.indexOf('id="topicProductSetup"') < html.indexOf('id="generateTopics"'));
  assert.match(html, /带货模式先锁定商品资料/);
  assert.match(renderer, /资料未齐时不会调用文本模型/);
  assert.match(renderer, /本次没有调用模型/);
  assert.match(renderer, /topicProductPrerequisiteGaps/);
});

test("successive topic batches rotate soft inspiration without assigning fixed slots or quotas", () => {
  const first = topicSlotMatrix(1);
  const second = topicSlotMatrix(2);
  assert.notEqual(first, second);
  assert.match(first, /仅用于打开思路，不是槽位命令，也不必逐项采用/);
  assert.match(second, /任何更有趣且生活逻辑成立的新方向优先/);
  assert.doesNotMatch(first, /T01｜|rescue_repaid|kindness_misjudged|sacrifice_repaid|evidence_reversal/);
});

test("topic normalization preserves source causal roles for downstream writing", () => {
  const topics = validTopicFixture().map((topic, index) => ({
    ...topic,
    conflictDomain: `场域${index}`,
    protagonist: `主角${index}`,
    antagonist: `过错方${index}`,
    returningAgent: `回归者${index}`,
    hookAction: `动作${index}`,
    firstDialogue: "你先把人放下",
    kindnessCost: `代价${index}`,
    reversalSource: `来源${index}`,
    settlementAction: `清算${index}`,
    originalityReplacements: ["关系", "场域", "动作", "来源", "结局"]
  }));
  const normalized = normalizeTopicOptions({ topics });
  assert.equal(normalized[4].antagonist, "过错方4");
  assert.equal(normalized[4].reversalSource, "来源4");
  assert.deepEqual(normalized[4].originalityReplacements, ["关系", "场域", "动作", "来源", "结局"]);
});

test("topic normalization retains a completed Chinese-keyed provider payload", () => {
  const topics = validTopicFixture().map((topic, index) => ({
    "标题": `本地化字段选题${index + 1}`,
    "人物关系": `关系${index + 1}`,
    "冲突领域": `领域${index + 1}`,
    "钩子": topic.hook,
    "故事梗概": topic.logline,
    "反转": topic.reversal,
    "亮点": [topic.hook, topic.logline, topic.reversal]
  }));
  const normalized = normalizeTopicOptions({ topics });
  assert.equal(normalized.length, 10);
  assert.equal(normalized[0].title, "本地化字段选题1");
  assert.deepEqual(normalized[0].highlights, topics[0]["亮点"]);
});

test("topic history feeds structural DNA instead of titles alone", () => {
  const project = { ideation: { topicHistory: [] } };
  rememberTopicBatch(project, [{
    title: "门口的旧鞋", relationship: "婆媳", storyMechanism: "kindness_misjudged",
    conflictDomain: "住房", hookAction: "把行李推出门", themeObject: "工鞋",
    logline: "婆婆想保住房子，儿媳因拆迁利益逼她搬走",
    reversalSource: "工人当面回归", reversal: "儿子承认擅自签约",
    settlementAction: "归还钥匙"
  }]);
  const patterns = priorTopicPatterns(project);
  assert.deepEqual(patterns, ["关系=婆媳；场域=住房；开场=把行李推出门；核心因果=婆婆想保住房子，儿媳因拆迁利益逼她搬走；反转来源=工人当面回归；反转结果=儿子承认擅自签约；结局行动=归还钥匙"]);
});

test("topic signature follows the causal story instead of title or prop swaps", () => {
  const first = {
    title: "门口的旧鞋", relationship: "婆媳", conflictDomain: "住房",
    hookAction: "把行李推出门", logline: "婆婆想保住房子，儿媳因拆迁利益逼她搬走",
    reversalSource: "工人当面回归", settlementAction: "归还钥匙", themeObject: "工鞋"
  };
  const renamed = { ...first, title: "雨里的行李", themeObject: "雨伞" };
  assert.equal(require("../app/foundry/topic-diversity").topicSignature(first), require("../app/foundry/topic-diversity").topicSignature(renamed));
});

test("topic diversity is optional and partial mode accepts every non-empty valid count", () => {
  const topics = validTopicFixture().map((item, index) => ({
    ...item,
    title: index === 0 ? "同一个标题" : "同一个标题",
    relationship: "同一关系"
  }));
  assert.throws(() => normalizeTopicOptions({ topics }), error => error?.code === "TOPIC_DIVERSITY_INVALID");
  const accepted = normalizeTopicOptions({ topics }, { enforceDiversity: false });
  assert.equal(accepted.length, 10);
  assert.equal(new Set(accepted.map(item => item.title)).size, 1);
  const partial = normalizeTopicOptions(
    { topics: topics.slice(0, 9) },
    { enforceDiversity: false, allowPartial: true }
  );
  assert.equal(partial.length, 9);
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
  assert.match(stitchSource, /assembledAudioSeconds/);
  assert.match(stitchSource, /FINAL_DURATION_CONTRACT_FAILED/);
  assert.match(stitchSource, /mandatoryFinalVisual/);
  assert.match(stitchSource, /\/\/ Objective delivery gates are opt-in[\s\S]*?if \(deliveryQualityEnabled\) \{/);
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

test("semantic schedule parser accepts an equivalent units array and nested relay envelope", () => {
  const units = [{ i: 1, duration: 10, beat: "开场动作", before: "门外", after: "进门", dialogueLines: [], cutAfter: "动作落点", dialogueContinuesToNext: false }];
  const parsed = parseStructuredJson(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ units }) } }]
  }), {
    requiredKeys: ["u"],
    unwrapKeys: ["u", "units", "shots", "items", "schedule", "segments", "data", "result", "payload", "content", "response", "output", "message", "choices"],
    rootArrayKey: "u",
    rootArrayAliases: ["units", "shots", "items", "schedule", "segments"],
    recursiveUnwrap: true
  });
  assert.deepEqual(parsed.u, units);
});

test("a valid seven-card Agent response is displayed immediately without a paid fill-up request", async () => {
  let project = {
    id: "project-topic-partial-repair",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: { name: "暖腰贴", sellingPoints: "日常保暖支撑", imagePath: __filename },
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {}, generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-topic-partial", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: "cost-topic-partial" }),
    saveProject: next => {
      project = structuredClone(next);
      return structuredClone(project);
    }
  };
  let providerCalls = 0;
  const topics = validTopicFixture();
  const workflow = new WorkbenchWorkflow({
    store,
    textGenerator: async () => {
      providerCalls += 1;
      return { topics: providerCalls === 1 ? topics.slice(0, 7) : topics.slice(7) };
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(providerCalls, 1);
  assert.equal(result.ideation.status, "ready");
  assert.equal(result.ideation.generationSource, "upstream_partial");
  assert.equal(result.ideation.topics.length, 7);
  assert.equal(result.ideation.partialResult, true);
  assert.match(result.ideation.message, /返回 7 个有效选题.*没有为凑满 10 个重复请求/);
});

test("a six-card response does not enter the former multi-round continuation loop", async () => {
  let project = {
    id: "project-topic-multi-round-repair",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: {},
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {}, generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-topic-multi", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: "cost-topic-multi" }),
    saveProject: next => {
      project = structuredClone(next);
      return structuredClone(project);
    }
  };
  const fixture = validTopicFixture();
  const calls = [];
  const workflow = new WorkbenchWorkflow({
    store,
    textGenerator: async (_config, messages, options) => {
      calls.push({ messages: structuredClone(messages), options: { ...options } });
      const result = [fixture.slice(0, 6), fixture.slice(6, 8), fixture.slice(8, 9), fixture.slice(9, 10)][calls.length - 1];
      return { topics: result || [] };
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(calls.length, 1);
  assert.equal(result.ideation.topics.length, 6);
  assert.equal(new Set(result.ideation.topics.map(topic => topic.title)).size, 6);
  assert.deepEqual(
    [...result.ideation.topics].sort((a, b) => a.slotId.localeCompare(b.slotId)).map(topic => `${topic.slotId}:${topic.id}`),
    Array.from({ length: 6 }, (_, index) => {
      const slot = `T${String(index + 1).padStart(2, "0")}`;
      return `${slot}:TOPIC_${String(index + 1).padStart(2, "0")}`;
    })
  );
  assert.ok(calls[0].options.sessionId);
  assert.equal(result.ideation.generationSource, "upstream_partial");
});

test("one valid topic is selectable and never triggers automatic completion rounds", async () => {
  let project = {
    id: "project-topic-repair-limit",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: {},
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {}, generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-topic-limit", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: "cost-topic-limit" }),
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
      return { topics: providerCalls === 1 ? validTopicFixture().slice(0, 1) : [] };
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(providerCalls, 1);
  assert.equal(result.ideation.status, "ready");
  assert.equal(result.ideation.topics.length, 1);
  assert.equal(result.ideation.partialResult, true);
  assert.equal(result.textProviderDiagnostics.topicResults.filter(item => item.stage === "topics_repair").length, 0);
});

test("complete cards inside an unclosed root JSON are returned without a continuation call", async () => {
  let project = {
    id: "project-topic-unclosed-json",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: {},
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {}, generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-topic-unclosed", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: "cost-topic-unclosed" }),
    saveProject: next => {
      project = structuredClone(next);
      return structuredClone(project);
    }
  };
  const cards = validTopicFixture().slice(0, 3);
  const partialText = `{"topics":[${cards.map(card => JSON.stringify(card)).join(",")},`;
  const calls = [];
  const workflow = new WorkbenchWorkflow({
    store,
    textGenerator: async (_config, _messages, options) => {
      calls.push(options);
      throw Object.assign(new Error("truncated JSON"), {
        code: "MODEL_JSON_INVALID",
        rawText: partialText,
        partialText,
        noAutomaticRetry: true
      });
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].autoContinueJson, false);
  assert.equal(calls[0].maxReconnectAttempts, 2);
  assert.equal(calls[0].timeoutMs, 20 * 60_000);
  assert.equal(result.ideation.status, "ready");
  assert.equal(result.ideation.generationSource, "upstream_partial");
  assert.deepEqual(result.ideation.topics.map(item => item.title), cards.map(item => item.title));
  assert.equal(result.ideation.partialResult, true);
});

test("topic acceptance matrix displays exactly 1, 3, 9 or 10 valid cards from one provider call", async t => {
  for (const count of [1, 3, 9, 10]) {
    await t.test(`${count} valid card(s)`, async () => {
      let project = {
        id: `project-topic-count-${count}`,
        activity: [],
        ideation: { status: "draft", topics: [] },
        product: {},
        generation: { engine: "hailuo-h3" },
        textProviderDiagnostics: { failures: [] }
      };
      const store = {
        getProject: () => structuredClone(project),
        getSettings: () => ({
          textProvider: {
            maxTokens: 100000,
            modelOutputTokenLimit: 128000
          },
          generation: { qualityGatesEnabled: false, qualityGateModules: {} }
        }),
        beginCostEntry: (_projectId, entry) => ({ ...entry, id: `cost-count-${count}`, __created: true }),
        updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: _entryId }),
        saveProject: next => {
          project = structuredClone(next);
          return structuredClone(project);
        }
      };
      const calls = [];
      const workflow = new WorkbenchWorkflow({
        store,
        textGenerator: async (_config, _messages, options) => {
          calls.push({
            maxTokens: options.maxTokens,
            responseJsonSchema: structuredClone(options.responseJsonSchema),
            sessionId: options.sessionId,
            timeoutMs: options.timeoutMs,
            maxReconnectAttempts: options.maxReconnectAttempts,
            autoContinueJson: options.autoContinueJson
          });
          return { topics: validTopicFixture().slice(0, count) };
        }
      });
      const result = await workflow.generateTopicOptions(project.id, { track: false });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].maxTokens, 16_384);
      assert.equal(calls[0].timeoutMs, 20 * 60_000);
      assert.equal(calls[0].maxReconnectAttempts, 2);
      assert.equal(calls[0].autoContinueJson, false);
      assert.equal(calls[0].responseJsonSchema.properties.topics.minItems, 1);
      assert.equal(calls[0].responseJsonSchema.properties.topics.maxItems, 10);
      assert.equal(result.ideation.status, "ready");
      assert.equal(result.ideation.topics.length, count);
      assert.equal(result.ideation.partialResult, count < 10);
      assert.equal(result.ideation.errorCode, "");
    });
  }
});

test("zero valid cards use at most one evidence-based continuation and end without a user-facing error", async () => {
  let project = {
    id: "project-topic-zero-final",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: {},
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProvider: {}, generation: { qualityGatesEnabled: false, qualityGateModules: {} } }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-zero-final", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: _entryId }),
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
      return { topics: [] };
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(providerCalls, 2);
  assert.equal(result.ideation.status, "waiting_topics");
  assert.equal(result.ideation.topics.length, 0);
  assert.equal(result.ideation.repairRounds, 1);
  assert.equal(result.ideation.errorCode, "");
  assert.match(result.ideation.message, /不会自动重复提交/);
});

test("a non-empty zero-valid Gemini result gets one bounded AI repair carrying the complete prior result", async () => {
  const privateCreativeMarker = "PRIVATE-CREATIVE-MARKER-DO-NOT-PERSIST";
  const firstResult = {
    topics: [{ slotId: "T01", concept: `${privateCreativeMarker}：老人冒雨护住陌生孩子` }]
  };
  let project = {
    id: "project-topic-zero-valid-repair",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: { name: "暖腰贴", sellingPoints: "日常保暖支撑", imagePath: __filename },
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({
      textProvider: { kind: "gemini-native", model: "gemini-3.7-flash", maxTokens: 65536 },
      generation: { qualityGatesEnabled: false, qualityGateModules: {} }
    }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: `cost-${entry.operation || "topic"}`, __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: _entryId }),
    saveProject: next => {
      project = structuredClone(next);
      return structuredClone(project);
    }
  };
  const calls = [];
  const workflow = new WorkbenchWorkflow({
    store,
    textGenerator: async (_config, messages, options) => {
      calls.push({
        messages: structuredClone(messages),
        options: {
          responseJsonSchema: structuredClone(options.responseJsonSchema),
          sessionId: options.sessionId,
          json: options.json
        }
      });
      return calls.length === 1 ? structuredClone(firstResult) : { topics: validTopicFixture() };
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(calls.length, 2, "only one content-repair turn is allowed after the successful first response");
  assert.equal(calls[0].options.responseJsonSchema.properties.topics.minItems, 1);
  assert.equal(calls[0].options.responseJsonSchema.properties.topics.maxItems, 10);
  assert.equal(calls[1].options.responseJsonSchema.properties.topics.minItems, 1);
  assert.equal(calls[1].options.responseJsonSchema.properties.topics.maxItems, 10);
  assert.match(calls[1].messages.map(item => item.content).join("\n"), new RegExp(privateCreativeMarker));
  assert.equal(result.ideation.status, "ready");
  assert.equal(result.ideation.generationSource, "upstream_repaired");
  assert.equal(result.ideation.topics.length, 10);
  const diagnostics = result.textProviderDiagnostics.topicResults;
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].candidateCount, 1);
  assert.equal(diagnostics[1].validCardCount, 0);
  assert.equal(diagnostics[1].parsedResultSha256, topicResultDiagnostic(firstResult).parsedResultSha256);
  assert.doesNotMatch(JSON.stringify(result.textProviderDiagnostics), new RegExp(privateCreativeMarker));
  assert.doesNotMatch(JSON.stringify(result.textProviderDiagnostics), /apiKey|x-goog-api-key/i);
});

test("provider failures produce an actionable waiting state instead of a red topic-contract error", async () => {
  let project = {
    id: "project-topic-provider-failure",
    activity: [],
    ideation: { status: "draft", topics: [] },
    product: {},
    generation: { engine: "hailuo-h3" },
    textProviderDiagnostics: { failures: [] }
  };
  const store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({
      textProvider: { kind: "gemini-native", model: "gemini-3.7-flash", maxTokens: 65536 },
      generation: { qualityGatesEnabled: false, qualityGateModules: {} }
    }),
    beginCostEntry: (_projectId, entry) => ({ ...entry, id: "cost-provider-failure", __created: true }),
    updateCostEntry: (_projectId, _entryId, entry) => ({ ...entry, id: _entryId }),
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
      throw Object.assign(new Error("quota window is still closed"), { code: "PROVIDER_RATE_LIMITED", retryAfterMs: 42000 });
    }
  });
  const result = await workflow.generateTopicOptions(project.id, { track: false });
  assert.equal(providerCalls, 1);
  assert.equal(result.ideation.status, "waiting_topics");
  assert.equal(result.ideation.errorCode, "");
  assert.equal(result.ideation.lastAttemptCode, "PROVIDER_RATE_LIMITED");
  assert.match(result.ideation.message, /不会自动重复提交/);
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
