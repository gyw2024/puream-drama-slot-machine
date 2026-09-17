"use strict";
// Patch the installed Electron app.asar with a single updated app file.
//   node patch-installed-asar.js <asarPath> <relativeFile> <sourceFile> [--apply]
// Default runs read-only: it reports how the packaged copy differs from source.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/node_modules/@electron/asar");

const ASAR = process.argv[2];
const RELATIVE = process.argv[3];
const SOURCE = process.argv[4];
const APPLY = process.argv.includes("--apply");

const packedText = asar.extractFile(ASAR, RELATIVE).toString("utf8");
const sourceText = fs.readFileSync(SOURCE, "utf8");
console.log("asar        :", ASAR);
console.log("packed file :", RELATIVE, `${packedText.length} chars`);
console.log("source file :", SOURCE, `${sourceText.length} chars`);
console.log("identical   :", packedText === sourceText);
const packedNeeds = /compactFullReferencePrompt\(buildApprovedHailuoPrompt\(/.test(packedText);
const sourceHas = /fitHailuoTransportLimit\(compactFullReferencePrompt\(/.test(sourceText);
console.log("packed has old return:", packedNeeds, "| source has new return:", sourceHas);
if (!APPLY) {
  console.log("DRY RUN - re-run with --apply to repackage");
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/tmp/asar-backups";
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `app-${stamp}.asar`);
fs.copyFileSync(ASAR, backupPath);
console.log("backup      :", backupPath);

const workDir = path.join(backupDir, "..", "asar-unpack");
fs.mkdirSync(workDir, { recursive: true });
asar.extractAll(ASAR, workDir);
const target = path.join(workDir, RELATIVE);
if (!fs.existsSync(target)) throw new Error(`packed file missing after extract: ${RELATIVE}`);
fs.copyFileSync(SOURCE, target);
const staged = path.join(backupDir, `app-${stamp}.asar`);
asar.createPackage(workDir, staged);
// Overwrite in place. Deleting the packaged archive first is not possible in a
// sandboxed session, and a failed delete must never leave the app uninstalled.
fs.copyFileSync(staged, ASAR);
fs.rmSync(staged, { force: true });
fs.rmSync(workDir, { recursive: true, force: true });
console.log("patched     :", ASAR);
console.log("verify      :", asar.extractFile(ASAR, RELATIVE).toString("utf8") === sourceText);
