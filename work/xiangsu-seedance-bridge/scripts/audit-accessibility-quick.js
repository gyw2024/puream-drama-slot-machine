"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const axeSource = require("axe-core").source;

async function main() {
  const root = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const executablePath = path.join(root, packageJson.build.directories.output, "win-unpacked", "纯梦短剧老虎机.exe");
  const licenseSource = process.env.DRAMA_SLOT_AUDIT_LICENSE_SOURCE;
  if (!licenseSource || !fs.existsSync(licenseSource)) throw new Error("DRAMA_SLOT_AUDIT_LICENSE_SOURCE is required");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "drama-a11y-"));
  const userDataDir = path.join(tempRoot, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.copyFileSync(licenseSource, path.join(userDataDir, "drama-license.json"));
  fs.copyFileSync(path.join(path.dirname(licenseSource), "Local State"), path.join(userDataDir, "Local State"));
  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: path.join(tempRoot, "workbench") }
  });
  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await page.evaluate(axeSource);
    await page.evaluate(() => document.querySelector('.stage-button[data-stage="script"]')?.click());
    const result = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
    }));
    process.stdout.write(`${JSON.stringify(result.violations.filter(item => ["critical", "serious"].includes(item.impact)).map(item => ({
      id: item.id,
      impact: item.impact,
      help: item.help,
      nodes: item.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary }))
    })), null, 2)}\n`);
  } finally {
    await electronApp.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
