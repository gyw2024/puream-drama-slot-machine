"use strict";
const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { BridgeClient } = require("../app/bridge-client");

function decode(value) {
  const raw = String(value || "");
  return raw.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(raw.slice(4), "base64")) : raw;
}
function encode(value) {
  return value ? `enc:${safeStorage.encryptString(String(value)).toString("base64")}` : "";
}

async function main() {
  await app.whenReady();
  const root = process.env.DRAMA_E2E_ROOT || path.resolve(__dirname, "..", ".codex_tests", "TASK-20260824-DRAMA-PROMPT-REVIEW-PUBLISH-E2E-006", "real-product-e2e");
  const taskId = process.argv[2];
  const store = new WorkbenchStore(root, { encode, decode, sharedLibraryRoot: root });
  const settings = store.getSettings();
  const bridge = new BridgeClient({ remoteFetchImpl: net.fetch });
  bridge.configure(settings.videoProvider);
  const result = await bridge.query(taskId, { timeoutMs: 120000 });
  const payload = {
    taskId,
    status: result.status,
    progress: result.progress,
    message: result.message,
    videoUrl: result.videoUrl ? "present" : "",
    localPath: result.localPath || "",
    downloaded: result.downloaded === true,
    chargeYuan: result.chargeYuan ?? null,
    settlementStatus: result.settlementStatus || ""
  };
  fs.writeFileSync(path.join(root, "query-existing-h3-task-result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  await app.quit();
}
main().catch(async error => {
  try {
    const root = process.env.DRAMA_E2E_ROOT || path.resolve(__dirname, "..", ".codex_tests", "TASK-20260824-DRAMA-PROMPT-REVIEW-PUBLISH-E2E-006", "real-product-e2e");
    fs.writeFileSync(path.join(root, "query-existing-h3-task-result.json"), `${JSON.stringify({ code: error.code || "", status: error.status || 0, message: error.message }, null, 2)}\n`, "utf8");
  } catch {}
  console.error(JSON.stringify({ code: error.code || "", status: error.status || 0, message: error.message }));
  try { await app.quit(); } catch {}
  process.exitCode = 1;
});
