"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { WorkbenchStore } = require("../app/workbench-store");

async function main() {
  const executablePath = process.env.DRAMA_SLOT_INSTALLED_EXE;
  if (!executablePath || !fs.existsSync(executablePath)) throw new Error("DRAMA_SLOT_INSTALLED_EXE is required");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-installed-asset-count-"));
  const userDataDir = path.join(root, "user-data");
  const workbenchDir = path.join(root, "workbench");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "workspace-mode.json"), JSON.stringify({ version: 1, mode: "agent" }), "utf8");
  for (const name of ["drama-license.json", "Local State"]) {
    fs.copyFileSync(path.join(process.env.APPDATA, "xiangsu-seedance-bridge", name), path.join(userDataDir, name));
  }

  const store = new WorkbenchStore(workbenchDir);
  const created = store.createProject("资产计数安装版审计", { engine: "hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true });
  const characters = ["C01", "C02", "C03"].map((id, index) => ({ id, name: `角色${index + 1}` }));
  const scenes = ["SC01", "SC02", "SC03"].map((id, index) => ({ id, name: `场景${index + 1}` }));
  store.patchProject(created.id, { characters, scenes, generation: { engine: "hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true } });
  const sourceImage = path.join(__dirname, "..", "app", "assets", "drama-slot-mark.png");
  for (const item of [...characters.map(item => ({ ...item, type: "character", stage: "character_sheet" })), ...scenes.map(item => ({ ...item, type: "scene", stage: "scene_asset" }))]) {
    const target = path.join(root, `${item.stage}-${item.id}.png`);
    fs.copyFileSync(sourceImage, target);
    const candidate = store.addCandidate(created.id, { entityType: item.type, entityId: item.id, stage: item.stage, filePath: target, selected: true, qualityAudit: { ok: true } });
    store.confirmCandidate(created.id, candidate.id, false);
  }
  const project = store.getProject(created.id);
  const items = [];
  for (const character of characters) {
    items.push(
      { key: `character_sheet:${character.id}`, kind: "character_sheet", entityId: character.id, label: `${character.name} · 人物四视图`, status: "skipped" },
      { key: `character_video:${character.id}`, kind: "character_video", entityId: character.id, label: `${character.name} · 人物视频`, status: "queued" },
      { key: `character_voice:${character.id}`, kind: "character_voice", entityId: character.id, label: `${character.name} · 人物音色`, status: "queued" }
    );
  }
  for (const scene of scenes) items.push({ key: `scene_asset:${scene.id}`, kind: "scene_asset", entityId: scene.id, label: `${scene.name} · 场景四视图`, status: "skipped" });
  project.automation = {
    status: "paused",
    stage: "assets",
    progress: { kind: "asset_batch", total: 12, completed: 6, queued: 6, failed: 0, running: [], items }
  };
  store.saveProject(project);

  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${userDataDir}`], env: { ...process.env, DRAMA_SLOT_DATA_ROOT: workbenchDir } });
  try {
    const page = await app.firstWindow({ timeout: 20_000 });
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await page.locator('.stage-button[data-stage="assets"]').click();
    await page.evaluate(() => {
      window.__assetConfirmMessage = "";
      window.confirm = message => { window.__assetConfirmMessage = String(message || ""); return false; };
    });
    await page.evaluate(() => {
      const button = document.querySelector("#generateAllAssets");
      button.disabled = false;
      button.click();
    });
    const message = await page.evaluate(() => window.__assetConfirmMessage);
    assert.match(message, /已就绪 6 项会跳过，只补缺失\/失败的 6 项/);
    assert.doesNotMatch(message, /9 项/);
    console.log(JSON.stringify({ ok: true, version: await app.evaluate(({ app }) => app.getVersion()), message }, null, 2));
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
