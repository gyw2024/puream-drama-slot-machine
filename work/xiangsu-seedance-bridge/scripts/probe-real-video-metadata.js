"use strict";

const path = require("node:path");
const { sanitizeVideoMetadata, probeVideoMetadata } = require("../app/video-metadata");

async function main() {
  const ffmpeg = path.join(__dirname, "..", "media-tools", "ffmpeg.exe");
  const source = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  const before = await probeVideoMetadata(ffmpeg, source);
  const result = await sanitizeVideoMetadata(ffmpeg, source, { replaceInput: false, outputPath: output });
  process.stdout.write(`${JSON.stringify({ before: { duration: before.duration, streams: before.streams, tags: before.tags, hasForbiddenMetadata: before.hasForbiddenMetadata }, result: { path: result.path, after: result.after } }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ code: error.code || "", message: error.message, cause: error.cause?.message || "" })}\n`);
  process.exit(1);
});
