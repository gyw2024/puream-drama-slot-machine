"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

async function main() {
  const root = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const executablePath = process.env.DRAMA_SLOT_INSTALLED_EXE;
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(`installed executable missing: ${executablePath || "DRAMA_SLOT_INSTALLED_EXE"}`);
  }

  const evidenceRoot = path.resolve(
    process.env.DRAMA_SLOT_AUDIT_EVIDENCE_DIR
      || path.join(root, ".codex_tests", process.env.DRAMA_SLOT_AUDIT_TASK_ID || "TASK-DRAMA-LIVE-UPDATE", "release-audit", "live-update")
  );
  const runDir = path.join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "workspace-mode.json"), JSON.stringify({
    version: 1,
    mode: "agent",
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");

  const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE
    || path.join(process.env.APPDATA || "", packageJson.name, "drama-license.json");
  const localStateSource = path.join(path.dirname(licenseSource), "Local State");
  if (fs.existsSync(licenseSource) && fs.existsSync(localStateSource)) {
    fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
    fs.copyFileSync(localStateSource, path.join(userDataDir, "Local State"));
  }

  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: workbenchDir }
  });
  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => typeof window.dramaSlot?.checkUpdate === "function", null, { timeout: 20_000 });
    const update = await page.evaluate(() => window.dramaSlot.checkUpdate());
    assert.equal(update.status, "latest", "installed 0.16.0 must recognize the published 0.16.0 manifest as current");
    assert.equal(update.currentVersion, packageJson.version);
    assert.equal(update.latestVersion, packageJson.version);
    assert.equal(update.manifest?.sha256, "F70E28446CDF799FE81ECF0D1489341F2E6A2C9462C238C20AC589C23FF43C5A");
    assert.equal(update.manifest?.size, 126649520);
    assert.equal(update.manifest?.downloadUrl, "https://puream.cn/api/drama-slot/download");

    const report = { ok: true, executablePath, runDir, update };
    fs.writeFileSync(path.join(runDir, "audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
