"use strict";

const { app, safeStorage } = require("electron");
app.setName("xiangsu-seedance-bridge");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

async function main() {
  await app.whenReady();
  const root = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
  const store = new WorkbenchStore(root, { decode, encode: value => value });
  const settings = store.getSettings();
  const profiles = Object.values(settings.textProviderProfiles || {}).map(profile => ({
    kind: profile.kind,
    model: profile.model,
    baseUrl: profile.baseUrl,
    hasApiKey: Boolean(String(profile.apiKey || "").trim()),
    maxTokens: profile.maxTokens,
    modelOutputTokenLimit: profile.modelOutputTokenLimit
  }));
  process.stdout.write(`${JSON.stringify({ current: settings.textProvider?.kind, profiles }, null, 2)}\n`);
  app.quit();
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
