"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const axeSource = require("axe-core").source;

async function main() {
  const root = path.resolve(__dirname, "..");
  const executablePath = path.join(root, "dist-fixed-0.13.14", "win-unpacked", "纯梦短剧老虎机.exe");
  const evidenceDir = path.resolve(root, "..", "..", "..", ".codex_tests", "TASK-20260812-DRAMA-TOPIC-SSE-050", "packaged-ui");
  const userDataDir = path.join(evidenceDir, "isolated-user-data");
  const workbenchDir = path.join(evidenceDir, "isolated-workbench");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: workbenchDir }
  });

  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(evidenceDir, "main-window-1440x900.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.evaluate(axeSource);
    const axe = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
    }));
    const runtime = await page.evaluate(() => ({
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.trim().length || 0,
      interactiveCount: document.querySelectorAll("button,input,select,textarea,a,[tabindex]").length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      blankImages: [...document.images].filter(img => !img.complete || img.naturalWidth === 0).length
    }));
    const report = {
      executablePath,
      screenshotPath,
      runtime,
      axe: {
        violations: axe.violations.map(item => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.length,
          help: item.help
        })),
        criticalOrSerious: axe.violations.filter(item => ["critical", "serious"].includes(item.impact)).length
      }
    };
    fs.writeFileSync(path.join(evidenceDir, "audit.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
