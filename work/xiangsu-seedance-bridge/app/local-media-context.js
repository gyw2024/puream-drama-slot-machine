"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { spawn } = require("node:child_process");

// Scoped cancellation reaches nested legacy FFmpeg/ffprobe helpers without
// a process-global controller that could cancel another project's local job.
const context = new AsyncLocalStorage();
const currentLocalMediaSignal = () => context.getStore()?.signal || null;
const localMediaCancelled = () => Object.assign(new Error("本地后期已取消，原始文件保留"), { code: "LOCAL_MEDIA_CANCELLED" });
function throwIfLocalMediaAborted(signal = currentLocalMediaSignal()) {
  if (signal?.aborted) throw localMediaCancelled();
}
function withLocalMediaSignal(signal, action) {
  return context.run({ signal }, async () => {
    throwIfLocalMediaAborted();
    const result = await action();
    throwIfLocalMediaAborted();
    return result;
  });
}

function runLocalMediaProcess(executable, args, options = {}) {
  const signal = options.signal || currentLocalMediaSignal();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(localMediaCancelled());
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20 * 60_000);
    const maxBytes = Math.max(1, Number(options.maxBytes) || 2_000_000);
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      try { child.kill(); } catch {}
      finish(localMediaCancelled());
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(Object.assign(new Error("本地媒体处理超时，原始文件保留"), { code: "LOCAL_MEDIA_TIMEOUT" }));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => {
      if (bytes >= maxBytes) return;
      const kept = chunk.subarray(0, maxBytes - bytes);
      chunks.push(kept);
      bytes += kept.length;
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-500_000); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(null, { code, stdout: Buffer.concat(chunks), stderr }));
    if (signal?.aborted) abort();
  });
}

module.exports = { currentLocalMediaSignal, localMediaCancelled, throwIfLocalMediaAborted, withLocalMediaSignal, runLocalMediaProcess };
