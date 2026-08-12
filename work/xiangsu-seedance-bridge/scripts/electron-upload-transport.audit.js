"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, net } = require("electron");
const { openImageUploadBody } = require("../app/ai-provider");
const { openUploadBody } = require("../app/puream-video-adapters");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-transport-"));
  const source = path.join(root, "reference.bin");
  const payload = crypto.randomBytes(8 * 1024 * 1024);
  fs.writeFileSync(source, payload);
  const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");
  const received = new Map();
  const server = http.createServer((request, response) => {
    let receivedBytes = 0;
    const receivedHash = crypto.createHash("sha256");
    request.on("data", chunk => {
      receivedBytes += chunk.length;
      receivedHash.update(chunk);
    });
    request.on("end", () => {
      received.set(request.url, { bytes: receivedBytes, sha256: receivedHash.digest("hex") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await app.whenReady();
    const address = server.address();
    for (const [route, opener] of [["/video-reference", () => openUploadBody(fs, source, "application/octet-stream")], ["/image-reference", () => openImageUploadBody(source)]]) {
      const response = await net.fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: await opener(),
        redirect: "error"
      });
      assert.equal(response.ok, true);
      assert.equal(received.get(route)?.bytes, payload.length);
      assert.equal(received.get(route)?.sha256, expectedHash);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, routes: [...received.keys()], bytesPerRoute: payload.length, sha256: expectedHash })}\n`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    app.quit();
  }
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
