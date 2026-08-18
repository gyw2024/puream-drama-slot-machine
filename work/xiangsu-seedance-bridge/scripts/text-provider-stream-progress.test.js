"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { providerFetchOpenAiStream } = require("../app/ai-provider");

test("OpenAI-compatible stream treats received chunks as progress instead of a hard wall-clock timeout", async () => {
  const originalFetch = global.fetch;
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
        if (index >= frames.length) {
          streamController.close();
          return;
        }
        streamController.enqueue(new TextEncoder().encode(frames[index++]));
        setTimeout(pump, 15);
      };
      pump();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const result = await providerFetchOpenAiStream("https://provider.test/chat/completions", {
      method: "POST",
      body: "{}"
    }, 25, { maxTimeoutMs: 1_000 });
    assert.equal(result.text, "甲乙丙");
    assert.equal(result.upstreamDone, true);
  } finally {
    global.fetch = originalFetch;
  }
});
