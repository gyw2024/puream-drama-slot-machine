"use strict";

const { app, safeStorage } = require("electron");
app.setName("xiangsu-seedance-bridge");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { testProvider } = require("../app/ai-provider");

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

async function main() {
  await app.whenReady();
  const kind = process.env.DRAMA_E2E_TEXT_PROVIDER || "gemini-native";
  const root = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
  const store = new WorkbenchStore(root, { decode, encode: value => value });
  const profile = store.getSettings().textProviderProfiles?.[kind];
  if (!profile || !String(profile.apiKey || "").trim()) throw new Error(`No saved provider profile: ${kind}`);
  const result = await testProvider("text", profile);
  process.stdout.write(`${JSON.stringify({ kind, result }, null, 2)}\n`);
  app.quit();
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ kind: process.env.DRAMA_E2E_TEXT_PROVIDER || "gemini-native", error: error.message, code: error.code || "" })}\n`);
  app.exit(1);
});
