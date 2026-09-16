"use strict";

// Non-GUI release gate: inspect actual ASAR bytes, match source hashes and
// physically decode all 150 extraResource audio files. Never launch Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const { auditPostProductionContract } = require("./post-production-build-contract");
const root = path.resolve(__dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ""; }

function main() {
  const currentPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const resources = path.resolve(argument("--resources") || path.join(root, currentPackage.build.directories.output, "win-unpacked", "resources"));
  const asarPath = path.join(resources, "app.asar");
  assert.ok(fs.existsSync(asarPath), `packaged ASAR not found: ${asarPath}`);
  const packedPackage = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  assert.equal(packedPackage.version, currentPackage.version, "packaged application version does not match current release");
  // @electron/asar's directory traversal uses the host path separator.
  const extract = file => asar.extractFile(asarPath, path.join(...file.split("/")));
  const contract = auditPostProductionContract(extract);
  for (const file of contract.files) assert.equal(file.sha256, hash(fs.readFileSync(path.join(root, file.file))), `packaged module is stale: ${file.file}`);
  const entries = asar.listPackage(asarPath).map(file => file.replace(/\\/g, "/"));
  const sourceFiles = [];
  for (const entry of entries) {
    const relative = entry.replace(/^\/+/, "");
    if (!relative.startsWith("app/")) continue;
    const sourcePath = path.join(root, relative);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
    const sourceHash = hash(fs.readFileSync(sourcePath));
    assert.equal(hash(extract(relative)), sourceHash, `packaged application source is stale: ${relative}`);
    sourceFiles.push({ file: relative, sha256: sourceHash });
  }
  assert.ok(!entries.some(file => file.includes("app/assets/builtin-sfx/audio/")), "SFX must be real extraResource files, not trapped in ASAR");
  const library = path.join(resources, "builtin-sfx"), ffmpeg = path.join(resources, "media-tools", "ffmpeg.exe");
  const manifestPath = path.join(library, "catalog.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.count, 150); assert.equal(manifest.effects.length, 150);
  assert.equal(new Set(manifest.effects.map(item => item.id)).size, 150);
  assert.equal(new Set(manifest.effects.map(item => item.fileName)).size, 150);
  assert.equal(hash(fs.readFileSync(manifestPath)), hash(fs.readFileSync(path.join(root, "app", "assets", "builtin-sfx", "catalog.json"))), "packaged SFX manifest differs from source");
  assert.equal(hash(fs.readFileSync(ffmpeg)), hash(fs.readFileSync(path.join(root, "media-tools", "ffmpeg.exe"))), "packaged FFmpeg differs from verified source");
  const effects = [];
  for (const item of manifest.effects) {
    assert.equal(path.basename(item.fileName), item.fileName, "SFX filename must not contain paths");
    const file = path.join(library, "audio", item.fileName), bytes = fs.readFileSync(file);
    assert.equal(bytes.length, item.bytes, `${item.id}: packaged byte count changed`);
    assert.equal(hash(bytes), item.sha256, `${item.id}: packaged audio hash changed`);
    assert.equal(hash(bytes), hash(fs.readFileSync(path.join(root, "app", "assets", "builtin-sfx", "audio", item.fileName))), `${item.id}: packaged audio differs from source`);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "null", "-"], { windowsHide: true, timeout: 15000, stdio: "pipe" });
    effects.push({ id: item.id, sha256: item.sha256, bytes: bytes.length, decoded: true });
  }
  const report = { ok: true, evidenceType: "packaged-bytes-static-contract-and-full-audio-decode", version: packedPackage.version, resources, asarPath, asarSha256: hash(fs.readFileSync(asarPath)), sourceHashParity: true, sourceFiles, nativeWindowLaunched: false, paidRequests: 0, contract, effects };
  const reportPath = path.resolve(argument("--report") || path.join(root, ".codex_tests", "TASK-20260905-DRAMA-JIANYING-DRAFT-001", "release", `packaged-post-production-${packedPackage.version}-${Date.now()}.json`));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, version: packedPackage.version, moduleCount: contract.files.length, allSourceFilesMatched: sourceFiles.length, decodedEffects: effects.length, sourceHashParity: true, nativeWindowLaunched: false, reportPath }, null, 2)}\n`);
  return report;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error); process.exitCode = 1; } }
module.exports = { main };
