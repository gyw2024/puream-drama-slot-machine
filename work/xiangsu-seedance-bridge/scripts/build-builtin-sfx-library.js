"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { locateFfmpeg } = require("../app/locate-ffmpeg");
const {
  BUILTIN_SFX_CATALOG,
  FIXED_SFX_LIBRARY_VERSION,
  SOURCE_REPOSITORY,
  defaultLibraryRoot,
  validateBuiltinSfxCatalog
} = require("../app/fixed-sfx-library");

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "PUREAM-fixed-sfx-library-builder" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        fetchBuffer(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed ${response.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadWithRetry(url, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await fetchBuffer(url); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

function transcode(ffmpeg, inputPath, outputPath, item) {
  const maxDuration = item.loop ? 20 : 6;
  const commonOutput = ["-ar", "48000", "-ac", "2", "-c:a", "libvorbis", "-q:a", "5", outputPath];
  const args = item.pattern === "double"
    ? [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-filter_complex",
        `[0:a]atrim=0:2.2,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,asplit=2[a][b];[b]adelay=260|260[b2];[a][b2]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-18:LRA=7:TP=-2,atrim=0:${maxDuration}[outa]`,
        "-map", "[outa]", ...commonOutput
      ]
    : [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-af", `atrim=0:${maxDuration},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,loudnorm=I=-18:LRA=7:TP=-2`,
        ...commonOutput
      ];
  const result = spawnSync(ffmpeg, args, { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
    throw new Error(`ffmpeg failed for ${item.id}: ${(result.stderr || result.stdout || "unknown error").slice(-1200)}`);
  }
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function main() {
  const outputRoot = defaultLibraryRoot();
  const audioDir = path.join(outputRoot, "audio");
  // Downloaded source masters are build inputs, not runtime assets. Keep them
  // outside app/** so electron-builder cannot accidentally ship the cache.
  const sourceDir = path.join(__dirname, "..", ".codex_tests", "builtin-sfx-source-cache");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  const ffmpeg = locateFfmpeg({ ffmpegPath: process.env.FFMPEG_PATH });
  if (!ffmpeg) throw new Error("ffmpeg.exe was not found; set FFMPEG_PATH");

  const manifest = [];
  for (let index = 0; index < BUILTIN_SFX_CATALOG.length; index += 1) {
    const item = BUILTIN_SFX_CATALOG[index];
    const sourceExtension = path.extname(item.sourcePath) || ".bin";
    const sourcePath = path.join(sourceDir, `${item.id}${sourceExtension}`);
    const outputPath = path.join(audioDir, item.fileName);
    if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size <= 0) {
      const buffer = await downloadWithRetry(item.sourceUrl);
      fs.writeFileSync(sourcePath, buffer);
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
      transcode(ffmpeg, sourcePath, outputPath, item);
    }
    manifest.push({
      id: item.id,
      category: item.category,
      role: item.role,
      displayName: item.displayName,
      tags: item.tags,
      gainDb: item.gainDb,
      loop: item.loop,
      fileName: item.fileName,
      sha256: sha256(outputPath),
      bytes: fs.statSync(outputPath).size,
      license: item.license,
      sourceRepository: item.sourceRepository,
      sourcePath: item.sourcePath,
      sourceUrl: item.sourceUrl
    });
    process.stdout.write(`\r${index + 1}/${BUILTIN_SFX_CATALOG.length} ${item.id}`);
  }
  process.stdout.write("\n");

  const licenseUrl = "https://raw.githubusercontent.com/lavenderdotpet/CC0-Public-Domain-Sounds/main/LICENSE";
  const licenseBuffer = await downloadWithRetry(licenseUrl);
  fs.writeFileSync(path.join(outputRoot, "CC0-1.0-LICENSE.txt"), licenseBuffer);
  fs.writeFileSync(path.join(outputRoot, "catalog.json"), JSON.stringify({
    version: FIXED_SFX_LIBRARY_VERSION,
    count: manifest.length,
    license: "CC0-1.0",
    sourceRepository: SOURCE_REPOSITORY,
    generatedAt: new Date().toISOString(),
    effects: manifest
  }, null, 2), "utf8");

  const audit = validateBuiltinSfxCatalog(undefined, { requireFiles: true });
  if (!audit.ok) throw new Error(audit.failures.join("; "));
  console.log(JSON.stringify({ ok: true, ffmpeg, outputRoot, count: manifest.length, bytes: manifest.reduce((sum, item) => sum + item.bytes, 0), audit }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
