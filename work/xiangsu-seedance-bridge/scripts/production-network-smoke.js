"use strict";

const { app, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { DramaLicenseClient } = require("../app/license-gate");

if (process.env.DRAMA_TEST_USER_DATA) app.setPath("userData", process.env.DRAMA_TEST_USER_DATA);

function report(value) {
  const target = String(process.env.DRAMA_TEST_RESULT || "").trim();
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`, "utf8");
  }
}

async function probe(label, request) {
  const startedAt = Date.now();
  try {
    const response = await request();
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    return {
      label,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      contractOk: Number.isFinite(Number(payload?.data?.balanceCents))
        && Number.isFinite(Number(payload?.data?.availableCents))
    };
  } catch (error) {
    return {
      label,
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      code: error?.code || error?.name || "NETWORK_ERROR",
      message: error?.message || String(error)
    };
  }
}

app.whenReady().then(async () => {
  try {
    const activationCode = new DramaLicenseClient().storedActivationCode();
    if (!activationCode) throw Object.assign(new Error("本机没有可用的官网授权登录态"), { code: "PUREAM_AUTH_REQUIRED" });
    const url = "https://puream.cn/api/desktop/account/balance";
    const init = {
      method: "GET",
      headers: { authorization: `Bearer puream-desktop:${activationCode}` }
    };
    const chromium = await probe("electron.net.fetch", () => net.fetch(url, init));
    const node = await probe("global.fetch", () => globalThis.fetch(url, init));
    report({ ok: chromium.ok || node.ok, probes: [chromium, node] });
    app.exit(chromium.ok || node.ok ? 0 : 1);
  } catch (error) {
    report({ ok: false, code: error?.code || "NETWORK_SMOKE_FAILED", message: error?.message || String(error) });
    app.exit(1);
  }
});
