"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  catalogWithFiles,
  validateBuiltinSfxCatalog
} = require("../app/fixed-sfx-library");
const { auditPostProductionContract } = require("./post-production-build-contract");
const { verifyReleaseVersion } = require("./release-version-contract");

const root = path.resolve(__dirname, "..");
const releaseVersion = verifyReleaseVersion(require(path.join(root,"package.json")),require(path.join(root,"package-lock.json")));
const required = [
  { relativePath: "media-tools/ffmpeg.exe", size: 87_638_016, sha256: "2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3" }
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

const fixedSfxCatalog = catalogWithFiles();
const fixedSfxAudit = validateBuiltinSfxCatalog(fixedSfxCatalog, { requireFiles: true });
if (!fixedSfxAudit.ok) {
  throw Object.assign(new Error(`内置固定音效库校验失败：${fixedSfxAudit.failures.slice(0, 5).join("；")}`), {
    code: "BUILTIN_SFX_LIBRARY_INVALID",
    audit: fixedSfxAudit
  });
}

const postProductionAudit = auditPostProductionContract(file => fs.readFileSync(path.join(root, file)));
const buildPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!(buildPackage.build.files || []).includes("app/**/*")) throw new Error("构建配置没有包含完整应用运行时");
if (!(buildPackage.build.extraResources || []).some(item => item.from === "app/assets/builtin-sfx" && item.to === "builtin-sfx")) throw new Error("构建配置缺少可被剪映读取的实体音效资源目录");
const sfxManifest = JSON.parse(fs.readFileSync(path.join(root, "app", "assets", "builtin-sfx", "catalog.json"), "utf8"));
if (sfxManifest.count !== 150 || sfxManifest.effects?.length !== 150) throw new Error("内置音效清单必须恰好包含150条");
if (new Set(sfxManifest.effects.map(item => item.id)).size !== 150 || new Set(sfxManifest.effects.map(item => item.fileName)).size !== 150) throw new Error("内置音效清单存在重复编号或重复文件");
for (const effect of sfxManifest.effects) {
  const file = path.join(root, "app", "assets", "builtin-sfx", "audio", effect.fileName);
  if (path.basename(effect.fileName) !== effect.fileName || fs.statSync(file).size !== effect.bytes || digest(file).toLowerCase() !== effect.sha256) throw new Error(`内置音效实体校验失败：${effect.id}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, releaseVersion, version, verified, fixedSfxAudit, postProductionAudit }, null, 2)}\n`);
