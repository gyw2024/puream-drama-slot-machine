"use strict";
// T18: 迁移、Windows、打包与恢复。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { classifyLegacyProject, migrateLegacyProject, createMigrationManifest, verifyMigrationManifest } = require("../app/production-v2/legacy-migration");
const { FoundryRuntimeStore } = require("../app/foundry/runtime-store");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "t18-")); }

test("存量库升级：旧 schema 的 foundry 数据库能原地打开且数据不丢", () => {
  const dir = tmp();
  // Simulate a legacy pre-v2 store: project_state WITHOUT contract_fingerprint,
  // no v2 tables at all, one real project row. The store migrates in place on
  // open (constructor calls migrate()).
  const dbPath = path.join(dir, "foundry-v2.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE project_state (
    project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const snapshot = JSON.stringify({ id: "p-legacy", title: "旧项目", shots: [{ id: "s1" }] });
  legacy.prepare("INSERT INTO project_state VALUES (?,?,?,?,?)").run("p-legacy", 3, snapshot, "x".repeat(64), "2026-01-01T00:00:00.000Z");
  legacy.exec("CREATE TABLE foundry_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
  legacy.close();
  const store = new FoundryRuntimeStore(dir);
  const loaded = store.loadProject("p-legacy");
  assert.equal(loaded.title, "旧项目", "存量项目必须原样保留");
  assert.equal(loaded.shots.length, 1);
  const headers = store.listProjectStateHeaders();
  assert.ok(headers.length >= 1, "升级后必须能列出存量项目");
  store.close();
});

test("§14.1 三分类：有真实确认+媒体→legacy_imported；仅媒体→authorized_media；全空→review_ready", () => {
  const confirmed = {
    promptReview: { items: [{ id: "i1", userConfirmed: true }] },
    shots: [{ id: "s1" }],
    candidates: [{ entityType: "shot", entityId: "s1", stage: "shot_video", status: "completed" }]
  };
  assert.equal(classifyLegacyProject(confirmed), "legacy_imported");
  // status=approved 但没有 userConfirmed —— 绝不伪造人工批准。
  const faked = { promptReview: { status: "approved", items: [{ id: "i1", status: "approved" }] }, shots: [{ id: "s1" }], candidates: [{ entityType: "shot", entityId: "s1", stage: "shot_video", status: "completed" }] };
  assert.equal(classifyLegacyProject(faked), "authorized_media");
  assert.equal(classifyLegacyProject({ shots: [] }), "review_ready");
});

test("迁移落地：legacy_imported 导入批准；review_ready 只自动展示一次；幂等重跑只校验", () => {
  const imported = { promptReview: { items: [{ id: "i1", userConfirmed: true }] }, shots: [{ id: "s1" }], candidates: [{ entityType: "shot", entityId: "s1", stage: "shot_video", status: "completed" }] };
  const first = migrateLegacyProject(imported, { sourceRevision: "r1" });
  assert.equal(first.migrated, true);
  assert.equal(first.approvalState, "legacy_imported");
  assert.equal(imported.productionV2.enabled, true);
  assert.equal(imported.promptReview.legacyImported, true);
  // 人工确认的证据保留，不是凭空生成。
  assert.equal(imported.promptReview.items[0].userConfirmed, true);
  const rerun = migrateLegacyProject(imported, { sourceRevision: "r1" });
  assert.equal(rerun.migrated, false);
  assert.equal(rerun.verified, true);

  const empty = { shots: [] };
  const state = migrateLegacyProject(empty, {});
  assert.equal(state.approvalState, "review_ready");
  assert.equal(empty.promptReviewMayAutoOpenOnce, true, "新 gate 只自动展示一次");
});

test("迁移 manifest：备份可校验，重复执行验证而非重新生成", () => {
  const root = tmp();
  const projectsDir = path.join(root, "projects");
  const projectDir = path.join(projectsDir, "p1");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "project.json"), JSON.stringify({ id: "p1", title: "x", candidates: [1, 2] }));
  const store = { rootDir: root, projectsDir };
  const { manifestPath } = createMigrationManifest(store);
  assert.ok(fs.existsSync(manifestPath));
  const first = verifyMigrationManifest(manifestPath);
  assert.equal(first.ok, true);
  assert.equal(first.manifest.projectCount, 1);
  assert.equal(first.manifest.mediaCount, 2);
  // 篡改备份内容 → 校验必须失败。
  const backupFile = first.manifest.files[0].file;
  fs.writeFileSync(backupFile, "tampered");
  assert.equal(verifyMigrationManifest(manifestPath).ok, false, "备份被改动必须检出");
});

test("Windows 打包链路脚本存在且可加载（安装包冒烟的静态前提）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  for (const script of ["build:installer", "verify:build-assets", "audit:packaged", "audit:installed", "audit:live-upgrade"]) {
    assert.ok(pkg.scripts[script], `缺少 ${script} 打包/审计脚本`);
  }
  // 关键审计脚本必须存在且语法完整（audit 脚本有安装路径副作用，只做静态检查）。
  const { execFileSync } = require("node:child_process");
  for (const file of ["scripts/verify-build-assets.js", "scripts/audit-live-upgrade.js", "scripts/audit-packaged.js"]) {
    assert.ok(fs.existsSync(path.join(__dirname, "..", file)), `${file} 缺失`);
    execFileSync(process.execPath, ["--check", path.join(__dirname, "..", file)], { timeout: 30_000 });
  }
});
