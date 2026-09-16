"use strict";
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { DramaLicenseClient } = require("../app/license-gate");
const { hydratePureamDefaults } = require("../app/puream-auth-config");
const root = process.env.DRAMA_TEST_ROOT; const id = process.env.DRAMA_PROJECT_ID;
app.setPath("userData", path.join(root, "isolated-user-data")); app.commandLine.appendSwitch("disable-gpu");
app.whenReady().then(async () => {
  const decode = value => { if (!String(value || "").startsWith("enc:") || !safeStorage.isEncryptionAvailable()) return value || ""; try { return safeStorage.decryptString(Buffer.from(String(value).slice(4), "base64")); } catch { return ""; } };
  const encode = value => value ? `enc:${safeStorage.encryptString(value).toString("base64")}` : "";
  const wb = path.join(root, "isolated-user-data", "workbench"); const store = new WorkbenchStore(wb, { encode, decode });
  const settings = store.getSettings(); settings.textProvider.maxTokens = 65536; if (settings.textProviderProfiles?.[settings.textProvider.kind]) settings.textProviderProfiles[settings.textProvider.kind].maxTokens = 65536; store.saveSettings(settings);
  const bridge = new BridgeClient(); bridge.configure(store.getSettings().videoProvider); const workflow = new WorkbenchWorkflow({ store, bridge, stagingRoot: path.join(root, "staging"), licenseClient: new DramaLicenseClient() });
  try { const p = await workflow.generateTopicOptions(id, { track: false }); const out = { ok: true, projectId: id, topics: p.ideation?.topics?.length || 0, status: p.ideation?.status, generationSource: p.ideation?.generationSource }; fs.writeFileSync(path.join(root, "resume-report.json"), JSON.stringify(out, null, 2)); console.log(JSON.stringify(out)); }
  catch (e) { const p = store.getProject(id); const out = { ok: false, projectId: id, code: e.code || "", message: e.message, ideation: p.ideation, diagnostics: p.textProviderDiagnostics }; fs.writeFileSync(path.join(root, "resume-report.json"), JSON.stringify(out, null, 2)); console.log(JSON.stringify({ ok: false, projectId: id, code: e.code || "", message: e.message })); process.exitCode = 1; }
  app.quit();
});
