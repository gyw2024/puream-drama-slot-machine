"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");

function source(name) {
  return fs.readFileSync(path.join(__dirname, "..", name), "utf8");
}

test("permanent project deletion removes only the selected archived project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-project-purge-"));
  try {
    const store = new WorkbenchStore(root);
    const target = store.createProject("待永久删除");
    const survivor = store.createProject("必须保留");
    fs.writeFileSync(path.join(store.projectDir(target.id), "purge-marker.txt"), "target", "utf8");
    const sharedMarker = path.join(store.reusableAssetLibraryDir, "keep-shared.txt");
    fs.writeFileSync(sharedMarker, "shared", "utf8");

    const result = store.purgeProject(target.id);
    assert.equal(result.purged, true);
    assert.equal(fs.existsSync(store.projectDir(target.id)), false);
    assert.equal(store.listProjects().some(item => item.id === target.id), false);
    assert.equal(store.listProjects().some(item => item.id === survivor.id), true);
    assert.equal(store.listDeletedProjects().some(item => item.projectId === target.id), false);
    assert.equal(fs.existsSync(sharedMarker), true);
    assert.throws(() => store.getProject(target.id), error => error.code === "PROJECT_NOT_FOUND");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renderer and IPC expose guarded permanent deletion separately from recoverable deletion", () => {
  const renderer = source("app/renderer/workbench.js");
  const preload = source("app/preload.js");
  const main = source("app/main.js");
  assert.match(renderer, /data-action="console-delete"/);
  assert.match(renderer, /api\.workbench\.purgeProject\(id\)/);
  assert.match(preload, /purgeProject: projectId => ipcRenderer\.invoke\("workbench:purge-project"/);
  assert.match(main, /ipcMain\.handle\("workbench:purge-project"/);
  assert.match(main, /PROJECT_DELETE_ACTIVE/);
});
