"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { listTextProviderEvents, textProviderTracePath } = require("../app/ai-provider");

test("node test workers never default provider telemetry into installed customer data", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "this contract must execute inside the Node test runner");
  if (process.env.PUREAM_DRAMA_USER_DATA_DIR) {
    assert.match(textProviderTracePath(), /text-provider-events\.jsonl$/);
    return;
  }
  assert.equal(textProviderTracePath(), "");
  assert.deepEqual(listTextProviderEvents(10), []);
});

