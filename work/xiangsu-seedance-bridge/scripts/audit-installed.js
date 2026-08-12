"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

async function main() {
  const executablePath = process.env.DRAMA_SLOT_INSTALLED_EXE
    || path.join(process.env.LOCALAPPDATA || "", "Programs", "xiangsu-seedance-bridge", "纯梦短剧老虎机.exe");
  if (!fs.existsSync(executablePath)) throw new Error(`installed executable missing: ${executablePath}`);
  const electronApp = await electron.launch({ executablePath });
  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 20_000 });
    const [projects, auth, ui] = await Promise.all([
      page.evaluate(() => window.dramaSlot.workbench.listProjects()),
      page.evaluate(() => window.dramaSlot.workbench.authStatus()),
      page.evaluate(() => ({
        title: document.title,
        manualButtons: [
          "#importScriptFile",
          "#importStoryboardBatch",
          "#importShotPromptsBatch",
          "#importShotVideosBatch",
          "#importFinalVideo"
        ].map(selector => ({ selector, present: Boolean(document.querySelector(selector)) })),
        independentLibraryKinds: [...document.querySelectorAll('[data-action="import-reusable-library"]')]
          .map(button => button.dataset.kind),
        pageHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      }))
    ]);
    const result = {
      executablePath,
      projects: { ok: projects.ok === true, count: projects.projects?.length || 0 },
      authorization: { ok: auth.ok === true, configured: auth.configured === true },
      ui
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!projects.ok || !auth.ok || !auth.configured || ui.manualButtons.some(item => !item.present)) process.exitCode = 1;
  } finally {
    await electronApp.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
