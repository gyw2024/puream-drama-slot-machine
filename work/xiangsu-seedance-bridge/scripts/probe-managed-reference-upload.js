"use strict";

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  resolvePureamMediaUploadConfig,
  resolveReferenceUrl
} = require("../app/puream-video-adapters");

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function decryptObject(value) {
  if (Array.isArray(value)) return value.map(decryptObject);
  if (!value || typeof value !== "object") return typeof value === "string" ? decode(value) : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decryptObject(item)]));
}

async function main() {
  await app.whenReady();
  const root = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
  const projectPath = path.join(root, "projects", "project_mt9t1sfc_354f37ff", "project.json");
  const settingsPath = path.join(root, "settings.json");
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const settings = decryptObject(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  const config = resolvePureamMediaUploadConfig(settings);
  const filePath = String(project.product?.imagePath || "");
  const requestId = `probe-${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 24)}`;
  const startedAt = Date.now();
  try {
    const url = await resolveReferenceUrl(config, { path: filePath }, (url, init) => net.fetch(url, init), requestId, "image", 0, fs);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      status: 200,
      urlIsHttps: /^https:\/\//i.test(String(url)),
      fileExists: fs.existsSync(filePath),
      bytes: fs.statSync(filePath).size,
      storageMode: config.storageMode || "",
      endpointHost: new URL(config.managedStorageBaseUrl || "https://puream.cn").host,
      secretsExposed: false
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - startedAt,
      code: error?.code || "",
      status: Number(error?.status) || 0,
      retryable: error?.retryable === true,
      retryAfterMs: Number(error?.retryAfterMs) || 0,
      transportCode: String(error?.transportCode || ""),
      causeCode: String(error?.cause?.code || ""),
      causeMessage: String(error?.cause?.message || "").slice(0, 300),
      name: String(error?.name || ""),
      noRemoteTaskCreated: error?.noRemoteTaskCreated === true,
      message: String(error?.message || error).slice(0, 500),
      fileExists: fs.existsSync(filePath),
      bytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
      storageMode: config.storageMode || "",
      endpointHost: new URL(config.managedStorageBaseUrl || "https://puream.cn").host,
      secretsExposed: false
    })}\n`);
    process.exitCode = 1;
  }
}

main().finally(() => app.quit());
