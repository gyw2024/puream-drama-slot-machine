"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const required = [
  { relativePath: "media-tools/ffmpeg.exe", size: 87_638_016, sha256: "2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3" },
  { relativePath: "app/assets/face-grid-processor.exe", size: 11_264, sha256: "AC65468BE5376AEC7276B9D91022DD8EEDDDAAF6467DB5B852DEDBC99F78BBCA" },
  { relativePath: "app/assets/xiangsu-window-hider.exe", size: 7_680, sha256: "5522FEC2BD7F87D491E5A76B4372DF0655D24B8C0E8E0777C30462B8BAE0374E" }
];

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

const verified = required.map(asset => {
  const filePath = path.join(root, ...asset.relativePath.split("/"));
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`缺少构建资产：${asset.relativePath}。请先运行 npm run prepare:build-assets`), { code: "BUILD_ASSET_MISSING" });
  }
  const size = fs.statSync(filePath).size;
  const sha256 = digest(filePath);
  if (size !== asset.size || sha256 !== asset.sha256) {
    throw Object.assign(new Error(`构建资产校验失败：${asset.relativePath}`), { code: "BUILD_ASSET_MISMATCH", expected: asset, actual: { size, sha256 } });
  }
  return { relativePath: asset.relativePath, size, sha256 };
});

const ffmpeg = path.join(root, "media-tools", "ffmpeg.exe");
const version = execFileSync(ffmpeg, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).split(/\r?\n/)[0];
if (!/^ffmpeg version 7\.1-essentials_build-www\.gyan\.dev/i.test(version)) {
  throw Object.assign(new Error(`FFmpeg 版本不匹配：${version}`), { code: "FFMPEG_VERSION_MISMATCH" });
}

process.stdout.write(`${JSON.stringify({ ok: true, version, verified }, null, 2)}\n`);
