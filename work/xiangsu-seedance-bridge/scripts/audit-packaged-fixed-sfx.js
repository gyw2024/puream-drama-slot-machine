"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, packageJson.build.directories.output, "win-unpacked", "resources");
const libraryRoot = path.join(dist, "builtin-sfx");
const manifestPath = path.join(libraryRoot, "catalog.json");
const ffmpeg = path.join(dist, "media-tools", "ffmpeg.exe");
const asarPath = path.join(dist, "app.asar");

assert.ok(fs.existsSync(manifestPath), `packaged fixed SFX manifest is missing: ${manifestPath}`);
assert.ok(fs.existsSync(ffmpeg), `packaged FFmpeg is missing: ${ffmpeg}`);
assert.ok(fs.existsSync(asarPath), `packaged ASAR is missing: ${asarPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.equal(manifest.count, 150);
assert.equal(manifest.effects.length, 150);
assert.equal(new Set(manifest.effects.map(item => item.id)).size, 150);
assert.equal(new Set(manifest.effects.map(item => item.fileName)).size, 150);

const sink = process.platform === "win32" ? "NUL" : "/dev/null";
for (const item of manifest.effects) {
  const filePath = path.join(libraryRoot, "audio", item.fileName);
  assert.ok(fs.existsSync(filePath), `${item.id} is missing from packaged resources`);
  const bytes = fs.statSync(filePath).size;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  assert.equal(bytes, item.bytes, `${item.id} byte count changed after packaging`);
  assert.equal(sha256, item.sha256, `${item.id} hash changed after packaging`);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", filePath, "-f", "null", sink], {
    windowsHide: true,
    timeout: 15_000,
    stdio: "pipe"
  });
}

const packedPaths = asar.listPackage(asarPath).map(item => item.replace(/\\/g, "/"));
assert.equal(packedPaths.some(item => item.includes("app/assets/builtin-sfx/audio/")), false, "FFmpeg-inaccessible SFX files leaked into app.asar");
const packedPackage = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
assert.equal(packedPackage.version, packageJson.version);

process.stdout.write(`${JSON.stringify({
  ok: true,
  version: packageJson.version,
  count: manifest.effects.length,
  physicalLibraryRoot: libraryRoot,
  asarVirtualAudioLeak: false
}, null, 2)}\n`);
