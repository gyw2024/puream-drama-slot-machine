"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BridgeClient } = require("../app/bridge-client");

test("bridge token is created locally and remains stable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seedance-bridge-test-"));
  const client = new BridgeClient();
  client.stateDir = root;
  client.tokenPath = path.join(root, "token");
  const first = client.ensureToken();
  const second = client.ensureToken();
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("xiangsu locator accepts explicit existing executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seedance-locator-test-"));
  const fake = path.join(root, "Douyin AR.exe");
  fs.writeFileSync(fake, "test");
  const previous = process.env.XIANGSU_EXE;
  process.env.XIANGSU_EXE = fake;
  try {
    const client = new BridgeClient();
    assert.equal(client.locateXiangsu(), fake);
  } finally {
    if (previous === undefined) delete process.env.XIANGSU_EXE;
    else process.env.XIANGSU_EXE = previous;
  }
});
