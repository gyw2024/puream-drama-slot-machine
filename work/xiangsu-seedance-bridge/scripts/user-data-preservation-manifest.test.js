"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  compareManifests,
  createManifest,
  writeJsonOutsideUserData
} = require("./audit-user-data-preservation");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function treeAuthority(rootDir) {
  const entries = [];
  const visit = current => {
    for (const child of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) {
        entries.push({ path: path.relative(rootDir, childPath), type: "directory" });
        visit(childPath);
      } else if (child.isFile()) {
        const bytes = fs.readFileSync(childPath);
        const stat = fs.statSync(childPath);
        entries.push({
          path: path.relative(rootDir, childPath),
          type: "file",
          size: bytes.length,
          mtimeMs: stat.mtimeMs,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        });
      }
    }
  };
  visit(rootDir);
  return entries;
}

test("read-only manifests resolve custom storage, preserve bytes, validate SQLite and compare changes", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-data-manifest-"));
  try {
    const userDataRoot = path.join(testRoot, "用户配置");
    const workbenchRoot = path.join(testRoot, "自定义工作台");
    const evidenceRoot = path.join(testRoot, "evidence");
    writeJson(path.join(userDataRoot, "storage-location.json"), { version: 1, workbenchDataRoot: workbenchRoot });
    writeJson(path.join(userDataRoot, "workspace-mode.json"), { version: 1, mode: "agent" });
    writeJson(path.join(userDataRoot, "Local Storage", "leveldb", "CURRENT"), { current: "fixture" });
    writeJson(path.join(userDataRoot, "simple-workbench", "projects.json"), { projects: ["legacy"] });
    writeJson(path.join(workbenchRoot, "projects.json"), { projects: ["P-1"] });
    writeJson(path.join(workbenchRoot, "projects", "P-1", "project.json"), { id: "P-1", title: "清单测试" });
    writeJson(path.join(workbenchRoot, "settings.json"), { provider: "fixture" });
    fs.mkdirSync(path.join(workbenchRoot, "reusable-asset-library"), { recursive: true });
    fs.writeFileSync(path.join(workbenchRoot, "reusable-asset-library", "asset.bin"), Buffer.from([0, 1, 2, 3]));
    const databasePath = path.join(workbenchRoot, "foundry-v2.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE project_state(project_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL); INSERT INTO project_state VALUES ('P-1', '{}');");
    database.close();
    const historicalDatabasePath = path.join(workbenchRoot, "prechange-backups", "older-release", "foundry-v2.sqlite");
    fs.mkdirSync(path.dirname(historicalDatabasePath), { recursive: true });
    fs.copyFileSync(databasePath, historicalDatabasePath);

    const authorityBefore = treeAuthority(userDataRoot).concat(treeAuthority(workbenchRoot));
    const before = createManifest({ userDataRoot, label: "before" });
    const authorityAfter = treeAuthority(userDataRoot).concat(treeAuthority(workbenchRoot));
    assert.deepEqual(authorityAfter, authorityBefore, "snapshot must not alter any user-data bytes or mtimes");
    assert.equal(before.ok, true);
    assert.equal(before.workbenchDataRoot, workbenchRoot);
    assert.equal(before.workbenchRootSource, "storage-location.json");
    assert.equal(before.sqlite.length, 1);
    assert.equal(before.sqlite[0].stable, true);
    assert.deepEqual(before.sqlite[0].quickCheck, ["ok"]);
    assert.ok(before.files.some(file => file.relativePath === "prechange-backups/older-release/foundry-v2.sqlite"), "historical database bytes remain covered by the manifest");
    assert.ok(before.files.some(file => file.scope === "workbench" && file.relativePath === "projects/P-1/project.json"));
    assert.ok(before.files.some(file => file.scope === "legacy-simple-workbench" && file.relativePath === "projects.json"));

    const beforePath = path.join(evidenceRoot, "before.json");
    writeJsonOutsideUserData(beforePath, before, [before]);
    assert.ok(fs.existsSync(beforePath));
    assert.throws(
      () => writeJsonOutsideUserData(path.join(workbenchRoot, "forbidden.json"), before, [before]),
      error => error?.code === "EVIDENCE_INSIDE_USER_DATA"
    );

    const same = createManifest({ userDataRoot, label: "after-same" });
    assert.equal(compareManifests(before, same).ok, true);

    fs.writeFileSync(path.join(workbenchRoot, "reusable-asset-library", "asset.bin"), Buffer.from([9, 8, 7]));
    writeJson(path.join(workbenchRoot, "projects", "P-2", "project.json"), { id: "P-2" });
    const changed = createManifest({ userDataRoot, label: "after-change" });
    const comparison = compareManifests(before, changed);
    assert.equal(comparison.ok, false);
    assert.deepEqual(comparison.changed.map(item => item.relativePath), ["reusable-asset-library/asset.bin"]);
    assert.deepEqual(comparison.added.map(item => item.relativePath), ["projects/P-2/project.json"]);
    assert.equal(comparison.removed.length, 0);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
