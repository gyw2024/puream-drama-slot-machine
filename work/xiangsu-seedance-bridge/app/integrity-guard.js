"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const physicalFs = (() => {
  try { return require("original-fs"); }
  catch { return fs; }
})();

function sha256(filePath, fileSystem = fs) {
  return crypto.createHash("sha256").update(fileSystem.readFileSync(filePath)).digest("hex");
}

function createIntegrityGuard({
  app,
  intervalMs = 60_000,
  runtime = process,
  fileSystem = fs,
  physicalFileSystem = physicalFs
} = {}) {
  const state = { checkedAt: "", tampered: false, reasons: [], files: new Map(), metadata: new Map(), fileReasons: new Map(), manualReasons: new Set(), timer: null };
  const isPackagedAsar = root => /app\.asar$/i.test(String(root || ""));
  const isPhysicalFile = filePath => {
    try {
      return Boolean(filePath && physicalFileSystem.existsSync(filePath) && physicalFileSystem.statSync(filePath).isFile());
    } catch {
      return false;
    }
  };
  const paths = () => {
    const root = String(app?.getAppPath?.() || "");
    const candidates = [];
    // Electron patches node:fs so app.asar behaves like a virtual directory. The
    // archive itself must be verified through original-fs, otherwise every valid
    // packaged build is falsely reported as an unsealed application package.
    if (isPackagedAsar(root)) {
      if (isPhysicalFile(root)) candidates.push(root);
    } else if (root && fileSystem.existsSync(root) && fileSystem.statSync(root).isFile()) {
      candidates.push(root);
    }
    if (!isPackagedAsar(root) && root && fileSystem.existsSync(path.join(root, "main.js"))) {
      candidates.push(path.join(root, "main.js"), path.join(root, "license-gate.js"));
    }
    return [...new Set(candidates)];
  };
  const check = () => {
    const current = paths();
    const reasons = [...state.manualReasons];
    for (const filePath of current) {
      try {
        const stat = (isPackagedAsar(filePath) ? physicalFileSystem : fileSystem).statSync(filePath);
        const metadata = `${stat.size}:${stat.mtimeMs}`;
        if (state.files.has(filePath) && state.metadata.get(filePath) === metadata) {
          if (state.fileReasons.has(filePath)) reasons.push(state.fileReasons.get(filePath));
          continue;
        }
        const digest = sha256(filePath, isPackagedAsar(filePath) ? physicalFileSystem : fileSystem);
        const previous = state.files.get(filePath);
        if (previous && previous !== digest) {
          const reason = `core file changed: ${path.basename(filePath)}`;
          state.fileReasons.set(filePath, reason);
          reasons.push(reason);
        }
        if (!previous) state.files.set(filePath, digest);
        state.metadata.set(filePath, metadata);
      } catch { reasons.push(`core file unavailable: ${path.basename(filePath)}`); }
    }
    if (app?.isPackaged) {
      const root = String(app?.getAppPath?.() || "");
      if (!isPackagedAsar(root) || !isPhysicalFile(root)) {
        reasons.push("unsealed application package");
      }
      const flags = [
        ...(Array.isArray(runtime?.argv) ? runtime.argv : []),
        ...(Array.isArray(runtime?.execArgv) ? runtime.execArgv : []),
        String(runtime?.env?.NODE_OPTIONS || ""),
        String(runtime?.env?.ELECTRON_RUN_AS_NODE || "")
      ].join(" ");
      if (/(?:--inspect(?:-brk)?|--remote-debugging-(?:port|pipe)|--js-flags|--require\b)/i.test(flags)) {
        reasons.push("debug runtime flag");
      }
      if (String(runtime?.env?.ELECTRON_RUN_AS_NODE || "") === "1") reasons.push("electron run-as-node flag");
      if (runtime?.env?.DRAMA_LICENSE_BYPASS === "1") reasons.push("packaged bypass flag");
    }
    state.reasons = reasons;
    state.tampered = reasons.length > 0;
    state.checkedAt = new Date().toISOString();
    return snapshot();
  };
  const start = () => {
    check();
    if (!state.timer) {
      state.timer = setInterval(check, intervalMs);
      state.timer.unref?.();
    }
  };
  const stop = () => { if (state.timer) clearInterval(state.timer); state.timer = null; };
  const markRisk = reason => {
    const normalized = String(reason || "runtime integrity risk").slice(0, 160);
    state.manualReasons.add(normalized);
    return check();
  };
  const snapshot = () => ({ checkedAt: state.checkedAt, tampered: state.tampered, reasons: [...state.reasons] });
  return { start, stop, check, markRisk, snapshot, isRisk: () => state.tampered };
}

module.exports = { createIntegrityGuard };
