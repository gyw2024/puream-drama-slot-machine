"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  CURRENT_USER_DATA_DIR_NAME,
  LEGACY_USER_DATA_DIR_NAME,
  explicitUserDataDirectory,
  resolveUserDataDirectory
} = require("../app/user-data-location");

test("explicit user-data audit sandboxes always win", () => {
  assert.equal(explicitUserDataDirectory(["app", "--user-data-dir=D:\\audit-data"]), "D:\\audit-data");
  assert.equal(resolveUserDataDirectory({
    appDataPath: "D:\\roaming",
    argv: ["app", "--user-data-dir", "D:\\isolated"]
  }), path.resolve("D:\\isolated"));
});

test("existing durable customer data stays authoritative without moving bytes", () => {
  const appDataPath = path.resolve("D:\\roaming");
  const existing = new Set([
    path.join(appDataPath, LEGACY_USER_DATA_DIR_NAME, "workbench")
  ]);
  assert.equal(resolveUserDataDirectory({
    appDataPath,
    argv: ["app"],
    existsSync: candidate => existing.has(candidate)
  }), path.join(appDataPath, LEGACY_USER_DATA_DIR_NAME));
});

test("new installs and completed migrations use the stable PUREAM directory", () => {
  const appDataPath = path.resolve("D:\\roaming");
  assert.equal(resolveUserDataDirectory({ appDataPath, argv: ["app"], existsSync: () => false }), path.join(appDataPath, CURRENT_USER_DATA_DIR_NAME));
  const currentState = new Set([path.join(appDataPath, CURRENT_USER_DATA_DIR_NAME, "drama-license.json")]);
  assert.equal(resolveUserDataDirectory({
    appDataPath,
    argv: ["app"],
    existsSync: candidate => currentState.has(candidate)
  }), path.join(appDataPath, CURRENT_USER_DATA_DIR_NAME));
});
