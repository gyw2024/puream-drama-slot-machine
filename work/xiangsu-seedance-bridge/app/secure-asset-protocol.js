"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ASSET_SCHEME = "puream-asset";

function assetUrlForPath(filePath) {
  const absolute = path.resolve(String(filePath || ""));
  return `${ASSET_SCHEME}://local/${encodeURIComponent(absolute)}`;
}

function pathFromAssetUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== "local" || parsed.search || parsed.hash) {
    throw Object.assign(new Error("资产地址无效"), { code: "ASSET_URL_INVALID" });
  }
  const encoded = parsed.pathname.replace(/^\/+/, "");
  const decoded = decodeURIComponent(encoded);
  if (!path.isAbsolute(decoded)) throw Object.assign(new Error("资产路径必须是绝对路径"), { code: "ASSET_PATH_INVALID" });
  return path.resolve(decoded);
}

function realPathWithinRoot(filePath, rootDir) {
  const absoluteRoot = path.resolve(String(rootDir || ""));
  const absoluteFile = path.resolve(String(filePath || ""));
  const root = fs.realpathSync.native(absoluteRoot);
  const file = fs.realpathSync.native(absoluteFile);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw Object.assign(new Error("资产不在当前工作目录内"), { code: "ASSET_PATH_OUTSIDE_ROOT" });
  }
  if (!fs.statSync(file).isFile()) throw Object.assign(new Error("资产不是文件"), { code: "ASSET_NOT_FILE" });
  return file;
}

function registerAssetScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false
    }
  }]);
}

function installAssetProtocol(protocol, net, rootProvider) {
  protocol.handle(ASSET_SCHEME, async request => {
    try {
      const filePath = realPathWithinRoot(pathFromAssetUrl(request.url), rootProvider());
      return net.fetch(pathToFileURL(filePath).href, {
        method: request.method,
        headers: request.headers
      });
    } catch (error) {
      const status = error?.code === "ENOENT" ? 404 : 403;
      return new Response(status === 404 ? "Asset not found" : "Asset access denied", {
        status,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }
  });
}

module.exports = {
  ASSET_SCHEME,
  assetUrlForPath,
  installAssetProtocol,
  pathFromAssetUrl,
  realPathWithinRoot,
  registerAssetScheme
};
