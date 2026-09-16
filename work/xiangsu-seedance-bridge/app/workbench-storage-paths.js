"use strict";

const fs = require("node:fs");
const path = require("node:path");

function storageError(message, code) {
  return Object.assign(new Error(message), { code });
}

// Existing data always wins over a new-install default. A saved location is
// authoritative: never silently create a second, empty workbench on C: when
// that location becomes unavailable or its config cannot be read.
function defaultWorkbenchRoot(userData, options = {}) {
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const legacy = paths.join(userData, "workbench");
  if (exists(legacy)) return legacy;
  if (platform === "win32" && exists("D:\\")) return paths.join("D:\\", "PUREAM", "纯梦短剧老虎机数据");
  return legacy;
}

function resolveWorkbenchRoot(userData, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const exists = options.exists || fs.existsSync;
  const read = options.read || (file => fs.readFileSync(file, "utf8"));
  const configured = paths.join(userData, "storage-location.json");
  let root = String(env.DRAMA_SLOT_DATA_ROOT || "").trim();
  let explicit = Boolean(root);
  let fromSavedLocation = false;
  if (!root && exists(configured)) {
    let saved;
    try { saved = JSON.parse(read(configured)); }
    catch { throw storageError("无法读取已保存的素材位置，请恢复 storage-location.json 后重试；未创建空项目目录。", "STORAGE_LOCATION_CONFIG_INVALID"); }
    root = String(saved?.workbenchDataRoot || "").trim();
    if (!root) throw storageError("已保存的素材位置为空，原有项目未改动。", "STORAGE_LOCATION_CONFIG_INVALID");
    explicit = true;
    fromSavedLocation = true;
  }
  if (!root) return defaultWorkbenchRoot(userData, options);
  if (!paths.isAbsolute(root) || (platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\)/i.test(root))) {
    throw storageError("素材位置必须是完整的绝对路径，原有项目未改动。", "STORAGE_LOCATION_CONFIG_INVALID");
  }
  const resolved = paths.resolve(root);
  if (explicit && platform === "win32" && !exists(paths.parse(resolved).root)) {
    throw storageError("保存素材的磁盘暂时不可用，请接回该磁盘后重试；未切换到 C 盘。", "STORAGE_LOCATION_UNAVAILABLE");
  }
  if (fromSavedLocation && !exists(resolved)) {
    throw storageError("已保存的素材目录暂时不可用，请恢复该目录后重试；未创建空项目目录。", "STORAGE_LOCATION_UNAVAILABLE");
  }
  return resolved;
}

function stagingRootForWorkbench(rootDir, scope = "workbench") {
  if (!["workbench", "simple"].includes(scope)) throw storageError("未知的素材暂存范围", "STORAGE_SCOPE_INVALID");
  if (!rootDir || !path.isAbsolute(rootDir)) throw storageError("素材根目录尚未确定", "STORAGE_LOCATION_CONFIG_INVALID");
  return path.join(rootDir, ".staging", scope);
}

module.exports = { defaultWorkbenchRoot, resolveWorkbenchRoot, stagingRootForWorkbench };
