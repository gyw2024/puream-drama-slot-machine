"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { assetUrlForPath, pathFromAssetUrl } = require("../secure-asset-protocol");

function pathInsideRoot(filePath, rootDir) {
  const absoluteFile = path.resolve(String(filePath || ""));
  const absoluteRoot = path.resolve(String(rootDir || ""));
  const relative = path.relative(absoluteRoot, absoluteFile);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function rebaseAbsolutePath(filePath, sourceRoot, targetRoot) {
  const absolute = path.resolve(String(filePath || ""));
  if (!pathInsideRoot(absolute, sourceRoot)) return "";
  const relative = path.relative(path.resolve(sourceRoot), absolute);
  return path.resolve(targetRoot, relative);
}

function rebaseString(value, sourceRoot, targetRoot) {
  const text = String(value || "");
  if (!text) return { value: text, changed: false };
  if (path.isAbsolute(text)) {
    const rebased = rebaseAbsolutePath(text, sourceRoot, targetRoot);
    return rebased ? { value: rebased, changed: rebased !== text } : { value: text, changed: false };
  }
  if (/^file:/i.test(text)) {
    try {
      const rebased = rebaseAbsolutePath(fileURLToPath(text), sourceRoot, targetRoot);
      return rebased ? { value: pathToFileURL(rebased).href, changed: true } : { value: text, changed: false };
    } catch { return { value: text, changed: false }; }
  }
  if (/^puream-asset:/i.test(text)) {
    try {
      const rebased = rebaseAbsolutePath(pathFromAssetUrl(text), sourceRoot, targetRoot);
      return rebased ? { value: assetUrlForPath(rebased), changed: true } : { value: text, changed: false };
    } catch { return { value: text, changed: false }; }
  }
  return { value: text, changed: false };
}

function rebaseValue(value, sourceRoot, targetRoot, seen = new WeakSet()) {
  if (typeof value === "string") {
    const result = rebaseString(value, sourceRoot, targetRoot);
    return { value: result.value, replacements: result.changed ? 1 : 0 };
  }
  if (value == null || typeof value !== "object") return { value, replacements: 0 };
  if (seen.has(value)) throw Object.assign(new Error("保存位置迁移数据包含循环引用"), { code: "STORAGE_RELOCATION_CYCLIC_VALUE" });
  seen.add(value);
  let replacements = 0;
  if (Array.isArray(value)) {
    const output = value.map(item => {
      const result = rebaseValue(item, sourceRoot, targetRoot, seen);
      replacements += result.replacements;
      return result.value;
    });
    seen.delete(value);
    return { value: output, replacements };
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const result = rebaseValue(item, sourceRoot, targetRoot, seen);
    output[key] = result.value;
    replacements += result.replacements;
  }
  seen.delete(value);
  return { value: output, replacements };
}

function walkJsonFiles(rootDir) {
  const files = [];
  const pending = [path.resolve(rootDir)];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(fullPath);
    }
  }
  return files;
}

function criticalDataJson(filePath, rootDir) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath)).replace(/\\/g, "/").toLowerCase();
  return ["projects.json", "settings.json", "account-switch.json", "voice-library/index.json", "reusable-asset-library/index.json"].includes(relative)
    || /^projects\/[^/]+\/project\.json$/.test(relative)
    || /^deleted-projects\/[^/]+\/(?:project|deleted-project)\.json$/.test(relative)
    || /^simple-mode\/(?:projects\.json|settings\.json)$/.test(relative)
    || /^simple-mode\/projects\/[^/]+\/project\.json$/.test(relative);
}

function relocateCopiedWorkbenchData(options = {}) {
  const sourceRoot = path.resolve(String(options.sourceRoot || ""));
  const targetRoot = path.resolve(String(options.targetRoot || ""));
  const kernel = options.kernel;
  const writeJson = options.writeJson;
  if (!sourceRoot || !targetRoot || sourceRoot === targetRoot) throw Object.assign(new Error("新旧保存位置无效"), { code: "STORAGE_RELOCATION_ROOT_INVALID" });
  if (!kernel?.runtime || typeof writeJson !== "function") throw Object.assign(new Error("保存位置迁移器未初始化"), { code: "STORAGE_RELOCATION_NOT_READY" });

  const projects = [];
  for (const row of kernel.runtime.listProjectStates()) {
    const projectDir = path.join(targetRoot, "projects", row.projectId);
    if (!row.projectId || !fs.existsSync(projectDir)) continue;
    const project = kernel.loadProject(row.projectId) || row.project;
    const rebased = rebaseValue(project, sourceRoot, targetRoot);
    if (rebased.replacements) {
      const committed = kernel.commitProject(rebased.value, {
        eventType: "project.storage_relocated",
        actor: "user",
        source: "storage_relocation",
        payload: { sourceRoot, targetRoot, replacements: rebased.replacements }
      });
      writeJson(path.join(projectDir, "project.json"), rebased.value);
      projects.push({ projectId: row.projectId, replacements: rebased.replacements, revision: committed.committed.revision });
    } else {
      projects.push({ projectId: row.projectId, replacements: 0, revision: row.revision });
    }
  }

  const jsonFiles = [];
  const skippedJson = [];
  for (const filePath of walkJsonFiles(targetRoot)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const rebased = rebaseValue(parsed, sourceRoot, targetRoot);
      if (!rebased.replacements) continue;
      writeJson(filePath, rebased.value);
      jsonFiles.push({ filePath, replacements: rebased.replacements });
    } catch (error) {
      skippedJson.push({ filePath, code: String(error?.code || "INVALID_JSON"), message: String(error?.message || error) });
    }
  }
  const prior = kernel.runtime.getMeta("storage-relocations", []);
  const relocation = {
    sourceRoot,
    targetRoot,
    projectCount: projects.length,
    projectReplacements: projects.reduce((sum, item) => sum + item.replacements, 0),
    jsonFileCount: jsonFiles.length,
    jsonReplacements: jsonFiles.reduce((sum, item) => sum + item.replacements, 0),
    skippedJson,
    criticalSkippedJson: skippedJson.filter(item => criticalDataJson(item.filePath, targetRoot)),
    completedAt: new Date().toISOString()
  };
  kernel.runtime.setMeta("storage-relocations", [relocation, ...(Array.isArray(prior) ? prior : [])].slice(0, 20));
  kernel.runtime.checkpoint();
  return { ...relocation, projects, jsonFiles };
}

module.exports = { criticalDataJson, pathInsideRoot, rebaseAbsolutePath, rebaseString, rebaseValue, relocateCopiedWorkbenchData, walkJsonFiles };
