"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { probeVideoMetadata, sanitizeVideoMetadata, FORBIDDEN_METADATA_PATTERN } = require("../app/video-metadata");
const { BridgeClient } = require("../app/bridge-client");

const ffmpeg = path.join(__dirname, "..", "media-tools", "ffmpeg.exe");

function run(args) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true, stdio: "pipe" });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixture(root, name = "upstream.mp4") {
  const filePath = path.join(root, name);
  run([
    "-f", "lavfi", "-i", "testsrc=size=160x288:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=32000",
    "-t", "1.25",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k",
    // `comment` is a portable MP4 tag; its value models the sensitive
    // provider/workflow payload seen in the real Hailuo output.
    "-metadata", "comment=prompt internal workflow comfyui minimax_h3_video_vae_fp16",
    filePath
  ]);
  return filePath;
}

test("metadata sanitizer strips provider workflow tags without re-encoding streams", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fixture(root);
  const before = await probeVideoMetadata(ffmpeg, source);
  assert.equal(before.streams.filter(item => item.codecType === "video").length, 1);
  assert.equal(before.streams.filter(item => item.codecType === "audio").length, 1);
  assert.equal(FORBIDDEN_METADATA_PATTERN.test(fs.readFileSync(source).toString("latin1")), true);
  const derivative = path.join(root, "sanitized.mp4");
  const result = await sanitizeVideoMetadata(ffmpeg, source, { replaceInput: false, outputPath: derivative });
  assert.equal(result.replaced, false);
  assert.equal(result.path, derivative);
  assert.equal(fs.existsSync(source), true, "source must remain untouched for derivative mode");
  assert.equal(fs.existsSync(derivative), true);
  const after = await probeVideoMetadata(ffmpeg, derivative);
  assert.equal(after.streams.map(item => item.codecType).join(","), before.streams.map(item => item.codecType).join(","));
  assert.ok(Math.abs(Number(after.duration) - Number(before.duration)) < 0.1);
  assert.equal(after.hasForbiddenMetadata, false);
  assert.equal(FORBIDDEN_METADATA_PATTERN.test(fs.readFileSync(derivative).toString("latin1")), false);
});

test("in-place sanitization is transactional and leaves a valid playable MP4", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-metadata-replace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fixture(root, "replace.mp4");
  const originalHash = sha256(source);
  const result = await sanitizeVideoMetadata(ffmpeg, source);
  assert.equal(result.replaced, true);
  assert.equal(result.path, source);
  assert.notEqual(sha256(source), originalHash, "container metadata should be removed");
  const metadata = await probeVideoMetadata(ffmpeg, source);
  assert.equal(metadata.hasForbiddenMetadata, false);
  assert.equal(FORBIDDEN_METADATA_PATTERN.test(fs.readFileSync(source).toString("latin1")), false);
  assert.equal(metadata.streams.filter(item => item.codecType === "video").length, 1);
  assert.equal(metadata.streams.filter(item => item.codecType === "audio").length, 1);
});

test("sanitization failure never destroys the source", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-metadata-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.mp4");
  fs.writeFileSync(source, Buffer.from("original-bytes"));
  const original = sha256(source);
  await assert.rejects(
    () => sanitizeVideoMetadata(path.join(root, "missing-ffmpeg.exe"), source),
    error => error.code === "VIDEO_METADATA_SANITIZE_FFMPEG_NOT_FOUND"
  );
  assert.equal(sha256(source), original);
  assert.equal(fs.readFileSync(source, "utf8"), "original-bytes");
});

test("a path containing prompt or workflow is not mistaken for video metadata", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-workflow-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "prompt-workflow-clean.mp4");
  run([
    "-f", "lavfi", "-i", "testsrc=size=160x288:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=32000",
    "-t", "1.25",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k",
    source
  ]);
  const metadata = await probeVideoMetadata(ffmpeg, source);
  assert.equal(metadata.hasForbiddenMetadata, false);
  const sanitized = path.join(root, "prompt-review-sanitized.mp4");
  const result = await sanitizeVideoMetadata(ffmpeg, source, { replaceInput: false, outputPath: sanitized });
  assert.equal(result.path, sanitized);
  assert.equal(fs.existsSync(sanitized), true);
});

test("BridgeClient remote download stores only a sanitized MP4", async t => {
  assert.equal(fs.existsSync(ffmpeg), true, "bundled FFmpeg is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-metadata-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = fixture(root, "upstream-bridge.mp4");
  const bytes = fs.readFileSync(upstream);
  const client = new BridgeClient({
    tokenPath: path.join(root, "bridge-token"),
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(bytes.length) }
    })
  });
  client.configure({ kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", apiKey: "test-only" });
  const outputDir = path.join(root, "project", "videos");
  client.saveRemoteTask("metadata-task", { outputDir, providerKind: "puream-hailuo-h3" });
  const target = await client.downloadRemoteVideo("metadata-task");
  assert.equal(target, path.join(outputDir, "metadata-task.mp4"));
  assert.equal(fs.existsSync(target), true);
  const metadata = await probeVideoMetadata(ffmpeg, target);
  assert.equal(metadata.hasForbiddenMetadata, false);
  assert.equal(FORBIDDEN_METADATA_PATTERN.test(fs.readFileSync(target).toString("latin1")), false);
});
