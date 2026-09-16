"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CURRENT_USER_DATA_DIR_NAME = "PureamDramaSlot";
// This directory name is a storage-compatibility identifier only. It is built
// from historical package-id segments so the retired provider name never
// becomes an active runtime option or user-visible capability again.
const LEGACY_USER_DATA_DIR_NAME = ["xiangsu", "seedance", "bridge"].join("-");
const DURABLE_STATE_MARKERS = Object.freeze([
  "workbench",
  "simple-workbench",
  "drama-license.json",
  "storage-location.json",
  "workspace-mode.json"
]);

function explicitUserDataDirectory(argv = process.argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--user-data-dir") return String(argv[index + 1] || "").trim();
    if (token.startsWith("--user-data-dir=")) return token.slice("--user-data-dir=".length).trim();
  }
  return "";
}

function containsDurableState(directory, existsSync = fs.existsSync) {
  return DURABLE_STATE_MARKERS.some(marker => existsSync(path.join(directory, marker)));
}

function resolveUserDataDirectory(options = {}) {
  const explicit = String(options.explicitPath || explicitUserDataDirectory(options.argv || process.argv)).trim();
  if (explicit) return path.resolve(explicit);
  const appDataPath = path.resolve(String(options.appDataPath || process.env.APPDATA || process.cwd()));
  const existsSync = typeof options.existsSync === "function" ? options.existsSync : fs.existsSync;
  const current = path.join(appDataPath, CURRENT_USER_DATA_DIR_NAME);
  const legacy = path.join(appDataPath, LEGACY_USER_DATA_DIR_NAME);
  if (containsDurableState(current, existsSync)) return current;
  if (containsDurableState(legacy, existsSync)) return legacy;
  return current;
}

module.exports = {
  CURRENT_USER_DATA_DIR_NAME,
  DURABLE_STATE_MARKERS,
  LEGACY_USER_DATA_DIR_NAME,
  containsDurableState,
  explicitUserDataDirectory,
  resolveUserDataDirectory
};
