"use strict";
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { generateText } = require("../app/ai-provider");
const root = process.env.DRAMA_TEST_ROOT;
app.setPath("userData", path.join(root, "isolated-user-data"));
app.whenReady().then(async () => {
  const decode = value => { if (!String(value || "").startsWith("enc:") || !safeStorage.isEncryptionAvailable()) return value || ""; try { return safeStorage.decryptString(Buffer.from(String(value).slice(4), "base64")); } catch { return ""; } };
  const store = new WorkbenchStore(path.join(root, "isolated-user-data", "workbench"), { decode, encode: value => value || "" });
  const settings = store.getSettings();
  const provider = settings.textProvider;
  const started = Date.now();
  try {
    const text = await generateText(provider, [{ role: "user", content: "只回复：连接成功" }], { timeoutMs: 30000, maxTimeoutMs: 45000, maxTokens: 16, sessionId: `probe-${Date.now()}` });
    console.log(JSON.stringify({ ok: true, ms: Date.now() - started, kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, maxTokens: provider.maxTokens, apiKeyPresent: Boolean(provider.apiKey), text: String(text).slice(0, 40) }));
  } catch (e) { console.log(JSON.stringify({ ok: false, ms: Date.now() - started, kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, maxTokens: provider.maxTokens, apiKeyPresent: Boolean(provider.apiKey), code: e.code || "", status: e.status || 0, message: e.message })); }
  app.quit();
});
