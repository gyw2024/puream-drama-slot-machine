"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SOFTWARE_FALLBACK_MS = 12 * 60 * 60 * 1000;

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "software" || mode === "hardware" ? mode : "";
}

function renderingStatePath(app, env = process.env) {
  const overridden = String(env.DRAMA_SLOT_RENDERER_STATE_PATH || "").trim();
  return overridden || path.join(app.getPath("userData"), "renderer-mode.json");
}

function readRenderingState(statePath, fileSystem = fs) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRenderingState(statePath, value, fileSystem = fs) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fileSystem.mkdirSync(path.dirname(statePath), { recursive: true });
  fileSystem.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fileSystem.renameSync(temporary, statePath);
}

function configureRendererAcceleration(app, options = {}) {
  const env = options.env || process.env;
  const fileSystem = options.fileSystem || fs;
  const now = Number(options.now ?? Date.now());
  const statePath = renderingStatePath(app, env);
  const forcedMode = normalizeMode(env.DRAMA_SLOT_RENDERER_MODE);
  const saved = readRenderingState(statePath, fileSystem);
  const fallbackUntil = Number(saved.softwareFallbackUntil || 0);
  const mode = forcedMode || (fallbackUntil > now ? "software" : "hardware");
  const reason = forcedMode
    ? "environment"
    : mode === "software"
      ? String(saved.reason || "recent-gpu-crash")
      : "automatic-hardware";
  if (mode === "software") app.disableHardwareAcceleration();
  return { mode, reason, forced: Boolean(forcedMode), statePath, fallbackUntil };
}

function recordGpuCrash(selection, details = {}, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const now = Number(options.now ?? Date.now());
  const fallbackMs = Math.max(60_000, Number(options.fallbackMs) || DEFAULT_SOFTWARE_FALLBACK_MS);
  const state = {
    version: 1,
    mode: "software",
    reason: `gpu-${String(details.reason || "crashed")}`,
    exitCode: Number.isFinite(Number(details.exitCode)) ? Number(details.exitCode) : null,
    crashedAt: new Date(now).toISOString(),
    softwareFallbackUntil: now + fallbackMs
  };
  writeRenderingState(selection.statePath, state, fileSystem);
  return state;
}

function clearGpuFallback(selection, options = {}) {
  if (!selection?.statePath || selection.mode !== "hardware" || selection.forced) return false;
  const fileSystem = options.fileSystem || fs;
  try {
    if (fileSystem.existsSync(selection.statePath)) fileSystem.unlinkSync(selection.statePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_SOFTWARE_FALLBACK_MS,
  clearGpuFallback,
  configureRendererAcceleration,
  normalizeMode,
  readRenderingState,
  recordGpuCrash,
  renderingStatePath,
  writeRenderingState
};
