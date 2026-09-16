"use strict";

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { BridgeClient } = require("../app/bridge-client");

function decode(value) {
  const raw = String(value || "");
  return raw.startsWith("enc:")
    ? safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"))
    : raw;
}

function encode(value) {
  return value ? `enc:${safeStorage.encryptString(String(value)).toString("base64")}` : "";
}

async function main() {
  await app.whenReady();
  const settingsRoot = path.resolve(process.env.DRAMA_QUERY_SETTINGS_ROOT || "");
  const outputPath = path.resolve(process.env.DRAMA_QUERY_OUTPUT || path.join(process.cwd(), "h3-query-result.json"));
  const taskIds = process.argv.slice(2).map(value => String(value || "").trim()).filter(Boolean);
  if (!settingsRoot || !fs.existsSync(path.join(settingsRoot, "settings.json"))) throw new Error("isolated settings root missing");
  if (!taskIds.length) throw new Error("task ids missing");
  const store = new WorkbenchStore(settingsRoot, { encode, decode, sharedLibraryRoot: settingsRoot });
  const stateRoot = path.join(path.dirname(outputPath), "isolated-h3-state");
  const outputDir = path.join(path.dirname(outputPath), "existing-task-results");
  const bridge = new BridgeClient({
    remoteFetchImpl: (url, init) => net.fetch(url, init),
    tokenPath: path.join(stateRoot, "h3-client-state")
  });
  bridge.configure(store.getSettings().videoProvider);
  const results = [];
  for (const taskId of taskIds) {
    try {
      // Query/download metadata lives only in the evidence directory. This
      // never submits a task and never mutates the customer's live project.
      bridge.saveRemoteTask(taskId, { outputDir, providerKind: "puream-hailuo-h3", requestedMode: "auto", queriedReadOnlyAt: new Date().toISOString() });
      const result = await bridge.query(taskId, { timeoutMs: 120000 });
      results.push({
        taskId,
        ok: true,
        status: result.status || "",
        progress: result.progress ?? null,
        message: result.message || "",
        videoUrlPresent: Boolean(result.videoUrl),
        localPath: result.localPath || "",
        downloaded: result.downloaded === true,
        chargeYuan: result.chargeYuan ?? null,
        settlementStatus: result.settlementStatus || "",
        // Keep the provider's terminal receipt in the evidence file. The
        // desktop UI intentionally presents a short customer-facing message,
        // but root-cause audits must not lose the upstream code/timing fields
        // and then resort to blind paid rerolls.
        raw: result.raw || null
      });
    } catch (error) {
      results.push({ taskId, ok: false, code: error?.code || "", statusCode: error?.status || 0, message: error?.message || String(error) });
    }
  }
  const payload = { checkedAt: new Date().toISOString(), readOnly: true, results };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  await app.quit();
}

main().catch(async error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "", message: error?.message || String(error) })}\n`);
  try { await app.quit(); } catch {}
  process.exitCode = 1;
});
