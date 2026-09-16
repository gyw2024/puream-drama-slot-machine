"use strict";

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { BridgeClient } = require("../app/bridge-client");

const TASK_ID = String(process.env.H3_PROBE_TASK_ID || "").trim();
const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const OUTPUT_PATH = process.env.H3_PROBE_OUTPUT
  || path.resolve(__dirname, "..", ".codex_tests", "TASK-20260826-DRAMA-REMARRIAGE-FULL-VIDEO-003", `h3-probe-${TASK_ID || "missing"}.json`);

function writeResult(value) {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(String(value)).toString("base64")}`;
}

async function main() {
  if (!TASK_ID) throw Object.assign(new Error("H3_PROBE_TASK_ID is required"), { code: "TASK_ID_REQUIRED" });
  await app.whenReady();
  const store = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const settings = store.getSettings();
  const bridge = new BridgeClient({ remoteFetchImpl: (url, init) => net.fetch(url, init) });
  bridge.configure(settings.videoProvider);
  const started = Date.now();
  const result = await bridge.query(TASK_ID, { timeoutMs: 120_000 });
  return {
    taskId: TASK_ID,
    elapsedMs: Date.now() - started,
    providerKind: settings.videoProvider?.kind || "",
    model: settings.videoProvider?.model || "",
    status: result?.status || "",
    progress: result?.progress ?? null,
    videoUrlPresent: Boolean(result?.videoUrl),
    localPath: result?.localPath || "",
    downloaded: result?.downloaded === true,
    chargeYuan: result?.chargeYuan ?? null,
    settlementStatus: result?.settlementStatus || ""
  };
}

main().then(result => {
  writeResult(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(error => {
  const failure = {
    taskId: TASK_ID,
    code: error?.code || "",
    status: Number(error?.status) || 0,
    message: String(error?.message || error),
    retryable: error?.retryable === true,
    transportCode: error?.transportCode || ""
  };
  writeResult(failure);
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  try { await app.quit(); } catch {}
});
