"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");

const root = path.resolve(__dirname, "..");
const patchId = "0.16.89-HF003";
const appVersion = "0.16.89";
const windowsVerified = process.env.HF003_WINDOWS_VERIFIED === "1";
const macosVerified = process.env.HF003_MACOS_VERIFIED === "1";
const baselineDir = path.resolve(process.env.HF003_BASELINE_INSTALL_DIR
  || path.join(root, ".codex_backups", "TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003", "baseline", "installed"));
const targetDir = path.resolve(process.env.HF003_TARGET_BUILD_DIR
  || path.join(root, "dist-fixed-0.16.89", "win-unpacked"));
const outputRoot = path.resolve(process.env.HF003_OUTPUT_DIR
  || path.join(root, "release-patches", patchId));

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function fileSize(file) { return fs.statSync(file).size; }

function findMainExe(directory) {
  const entries = fs.readdirSync(directory).filter(name => /\.exe$/i.test(name) && !/^uninstall/i.test(name));
  if (entries.length !== 1) throw new Error(`Expected one main executable in ${directory}; found ${entries.join(", ")}`);
  return path.join(directory, entries[0]);
}

function exeDelta(baseFile, targetFile) {
  const base = fs.readFileSync(baseFile);
  const target = fs.readFileSync(targetFile);
  if (base.length !== target.length) throw new Error("Executable sizes differ; byte-range patch is unsafe.");
  const ranges = [];
  let start = -1;
  for (let index = 0; index <= base.length; index += 1) {
    const differs = index < base.length && base[index] !== target[index];
    if (differs && start < 0) start = index;
    if (!differs && start >= 0) {
      ranges.push({ offset: start, dataBase64: target.subarray(start, index).toString("base64") });
      start = -1;
    }
  }
  return { baseSize: base.length, targetSize: target.length, changedBytes: ranges.reduce((sum, item) => sum + Buffer.from(item.dataBase64, "base64").length, 0), ranges };
}

function renderTemplate(name, values) {
  let text = fs.readFileSync(path.join(root, "patches", "HF003", name), "utf8");
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`@@${key}@@`, String(value));
  if (/@@[A-Z0-9_]+@@/.test(text)) throw new Error(`Unresolved template token in ${name}`);
  return text;
}

function safePrepareOutput() {
  if (!fs.existsSync(outputRoot)) { fs.mkdirSync(outputRoot, { recursive: true }); return; }
  const stat = fs.statSync(outputRoot);
  if (!stat.isDirectory() || !outputRoot.startsWith(path.join(root, "release-patches") + path.sep)) {
    throw new Error(`Refusing to rotate unexpected output path: ${outputRoot}`);
  }
  const rotated = `${outputRoot}.previous-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.renameSync(outputRoot, rotated);
  fs.mkdirSync(outputRoot, { recursive: true });
}

function writeUtf8(file, text, executable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  if (executable) fs.chmodSync(file, 0o755);
}

function main() {
  const baseExe = findMainExe(baselineDir);
  const targetExe = findMainExe(targetDir);
  const baseAsar = path.join(baselineDir, "resources", "app.asar");
  const targetAsar = path.join(targetDir, "resources", "app.asar");
  for (const file of [baseExe, targetExe, baseAsar, targetAsar]) if (!fs.existsSync(file)) throw new Error(`Missing build input: ${file}`);

  const hashes = {
    baseExe: sha256(baseExe),
    targetExe: sha256(targetExe),
    baseAsar: sha256(baseAsar),
    targetAsar: sha256(targetAsar)
  };
  const baseHeader = asar.getRawHeader(baseAsar);
  const targetHeader = asar.getRawHeader(targetAsar);
  const baseAsarHeaderSha256 = crypto.createHash("sha256").update(baseHeader.headerString).digest("hex");
  const targetAsarHeaderSha256 = crypto.createHash("sha256").update(targetHeader.headerString).digest("hex");
  const delta = { patchId, appVersion, baseSha256: hashes.baseExe, targetSha256: hashes.targetExe, ...exeDelta(baseExe, targetExe) };
  if (delta.changedBytes > 4096) throw new Error(`Executable delta unexpectedly large: ${delta.changedBytes} bytes`);

  safePrepareOutput();
  const payloadDir = path.join(outputRoot, "payload");
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.copyFileSync(targetAsar, path.join(payloadDir, "app.asar"));
  writeUtf8(path.join(payloadDir, "windows-exe-delta.json"), `${JSON.stringify(delta, null, 2)}\n`);

  const values = {
    PATCH_ID: patchId,
    APP_VERSION: appVersion,
    BASE_EXE_SHA256: hashes.baseExe,
    BASE_ASAR_SHA256: hashes.baseAsar,
    TARGET_EXE_SHA256: hashes.targetExe,
    TARGET_ASAR_SHA256: hashes.targetAsar,
    BASE_ASAR_SHA256_LOWER: hashes.baseAsar.toLowerCase(),
    BASE_ASAR_HEADER_SHA256: baseAsarHeaderSha256,
    TARGET_ASAR_SHA256_LOWER: hashes.targetAsar.toLowerCase(),
    TARGET_ASAR_HEADER_SHA256: targetAsarHeaderSha256
  };
  writeUtf8(path.join(outputRoot, "Windows", "install-windows.ps1"), renderTemplate("install-windows.ps1.template", values));
  writeUtf8(path.join(outputRoot, "Windows", "Install-Windows.cmd"), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"\r\nif errorlevel 1 pause\r\n');
  writeUtf8(path.join(outputRoot, "Windows", "Rollback-Windows.cmd"), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" -Rollback\r\nif errorlevel 1 pause\r\n');
  fs.mkdirSync(path.join(outputRoot, "Windows", "payload"), { recursive: true });
  fs.copyFileSync(path.join(payloadDir, "app.asar"), path.join(outputRoot, "Windows", "payload", "app.asar"));
  fs.copyFileSync(path.join(payloadDir, "windows-exe-delta.json"), path.join(outputRoot, "Windows", "payload", "windows-exe-delta.json"));

  writeUtf8(path.join(outputRoot, "macOS", "install-macos.command"), renderTemplate("install-macos.command.template", values), true);
  writeUtf8(path.join(outputRoot, "macOS", "rollback-macos.command"), '#!/bin/bash\nset -e\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\nexec /bin/bash "$SCRIPT_DIR/install-macos.command" --rollback "$@"\n', true);
  fs.mkdirSync(path.join(outputRoot, "macOS", "payload"), { recursive: true });
  fs.copyFileSync(path.join(payloadDir, "app.asar"), path.join(outputRoot, "macOS", "payload", "app.asar"));

  const readme = `纯梦短剧老虎机 ${patchId} 双平台离线补丁\n\n` +
    `修复内容：\n- 上游返回 1-9 个有效选题时直接显示，不再为凑满 10 个自动续写。\n- 0 个有效选题时最多执行 1 次有依据的续补；仍无结果则安全结束，不显示格式报错。\n- 修复 OpenAI 兼容、Gemini 及视频链路对只读 DOMException 写 code 导致的二次 TypeError。\n- 限流与余额不足分别提示，避免误导。\n\n` +
    `Windows：解压后双击 Windows/Install-Windows.cmd。回滚双击 Rollback-Windows.cmd。\n` +
    `macOS：仅用于已经安装并成功打开过的 0.16.89 应用。打开“终端”，执行：bash macOS/install-macos.command\n` +
    `        回滚：bash macOS/rollback-macos.command\n` +
    `        若应用不在 /Applications，可把 .app 路径作为最后一个参数。脚本会严格校验基线与签名、备份整套 .app、更新 ASAR 完整性、先验证候选副本再原子替换。默认仅对已安装本机副本作 ad-hoc 重签；面向客户的 Developer ID/公证版本仍须通过正式 macOS 发布流水线。\n\n` +
    `安全边界：补丁只接受清单登记的 0.16.89 文件；未知版本不会覆盖；重复安装幂等；失败自动回滚。\n` +
    `本补丁不连接更新服务器，也没有修改纯梦官网公开版本。\n`;
  writeUtf8(path.join(outputRoot, "安装与回滚说明.txt"), readme);

  const manifest = {
    patchId,
    appVersion,
    generatedAt: new Date().toISOString(),
    publicWebsiteUpdated: false,
    payload: {
      appAsar: { size: fileSize(targetAsar), sha256: hashes.targetAsar, headerSha256: targetAsarHeaderSha256 }
    },
    windows: {
      baseline: { exeSha256: hashes.baseExe, appAsarSha256: hashes.baseAsar },
      target: { exeSha256: hashes.targetExe, appAsarSha256: hashes.targetAsar },
      executableDelta: { changedBytes: delta.changedBytes, ranges: delta.ranges.length },
      rollback: true,
      testedOnRealWindows: windowsVerified,
      verificationEvidence: windowsVerified ? ".codex_tests/TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003/windows-patch-hardened-final2/result.json" : ""
    },
    macOS: {
      baseline: { appAsarSha256: hashes.baseAsar },
      target: { appAsarSha256: hashes.targetAsar, appAsarHeaderSha256: targetAsarHeaderSha256 },
      baselineAsarHeaderSha256: baseAsarHeaderSha256,
      fullBundleBackup: true,
      resignsInstalledBundle: true,
      defaultSigning: "ad-hoc-local-maintenance",
      developerIdNotarized: false,
      testedOnRealMac: macosVerified,
      gate: macosVerified ? "" : "Real macOS execution and Developer ID notarization are not available in the current Windows workspace."
    }
  };
  writeUtf8(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(outputRoot);
  const sums = files.sort().map(file => `${sha256(file)}  ${path.relative(outputRoot, file).replaceAll("\\", "/")}`).join("\n") + "\n";
  writeUtf8(path.join(outputRoot, "SHA256SUMS.txt"), sums);

  const sevenZip = "C:\\Users\\Administrator\\AppData\\Local\\electron-builder\\Cache\\7zip@1.0.0\\7zip-win-x64-1nrf7\\bin\\7za.exe";
  const archive = `${outputRoot}-dual-platform-offline-patch.zip`;
  if (fs.existsSync(archive)) fs.renameSync(archive, `${archive}.previous-${Date.now()}`);
  const packed = spawnSync(sevenZip, ["a", "-tzip", "-mx=9", archive, path.join(outputRoot, "*")], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`7-Zip failed: ${packed.stdout}\n${packed.stderr}`);
  const result = { patchId, outputRoot, archive, archiveSize: fileSize(archive), archiveSha256: sha256(archive), hashes, baseAsarHeaderSha256, targetAsarHeaderSha256, delta: { changedBytes: delta.changedBytes, ranges: delta.ranges.length } };
  writeUtf8(path.join(outputRoot, "build-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
