"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

/**
 * FFmpeg is a hard runtime dependency for continuity plates, voice extract and stitch.
 * First principle: ship it with this app. Sibling apps / PATH are fallback only.
 */
function locateFfmpeg(options = {}) {
  const explicit = String(options.ffmpegPath || process.env.FFMPEG_PATH || "").trim();
  const candidates = [];
  if (explicit) candidates.push(explicit);

  // Packaged: electron-builder extraResources -> resources/media-tools/ffmpeg.exe
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "media-tools", "ffmpeg.exe"));
  }

  // Source / headless: repo resources next to app/
  candidates.push(path.join(__dirname, "..", "resources", "media-tools", "ffmpeg.exe"));

  // Installed next to the executable (some portable layouts)
  if (typeof process.execPath === "string" && process.execPath) {
    candidates.push(path.join(path.dirname(process.execPath), "resources", "media-tools", "ffmpeg.exe"));
    candidates.push(path.join(path.dirname(process.execPath), "media-tools", "ffmpeg.exe"));
  }

  // Optional sibling installs — never primary
  const localAppData = process.env.LOCALAPPDATA || "";
  if (localAppData) {
    candidates.push(path.join(localAppData, "Programs", "@pureamdesktop", "resources", "media-tools", "ffmpeg.exe"));
    candidates.push(path.join(localAppData, "Programs", "xiangsu-seedance-bridge", "resources", "media-tools", "ffmpeg.exe"));
  }
  for (const dir of [localAppData, process.env.ProgramFiles, "C:\\ffmpeg\\bin"].filter(Boolean)) {
    candidates.push(path.join(dir, "ffmpeg", "bin", "ffmpeg.exe"));
    candidates.push(path.join(dir, "ffmpeg.exe"));
  }

  // Legacy: optional xiangsu/Douyin AR probe provided by caller
  const xiangsu = String(options.xiangsuPath || "").trim();
  if (xiangsu) {
    candidates.push(
      path.join(path.dirname(xiangsu), "Resources", "BuiltinResource", "ffmpeg", "x86_64", "ffmpeg.exe"),
      path.join(path.dirname(xiangsu), "x64", "ffmpeg.exe"),
      path.join(path.dirname(xiangsu), "ffmpeg.exe")
    );
  }

  const found = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (found) return found;

  try {
    const which = String(execSync(process.platform === "win32" ? "where ffmpeg" : "which ffmpeg", {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }) || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    if (which && fs.existsSync(which)) return which;
  } catch {}

  return null;
}

module.exports = { locateFfmpeg };
