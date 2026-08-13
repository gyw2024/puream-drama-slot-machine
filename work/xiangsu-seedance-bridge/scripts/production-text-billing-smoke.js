"use strict";

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { generateText } = require("../app/ai-provider");
const { DramaLicenseClient } = require("../app/license-gate");

if (process.env.DRAMA_TEST_USER_DATA) app.setPath("userData", process.env.DRAMA_TEST_USER_DATA);

if (process.env.DRAMA_ALLOW_BILLABLE_SMOKE !== "I_UNDERSTAND") {
  throw new Error("This diagnostic can create a billable text request. Set DRAMA_ALLOW_BILLABLE_SMOKE=I_UNDERSTAND only after explicit authorization.");
}

function report(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (process.env.DRAMA_TEST_RESULT) {
    fs.mkdirSync(path.dirname(process.env.DRAMA_TEST_RESULT), { recursive: true });
    fs.writeFileSync(process.env.DRAMA_TEST_RESULT, line, "utf8");
  }
  process.stdout.write(line);
}

app.whenReady().then(async () => {
  try {
    const license = new DramaLicenseClient();
    const activationCode = license.storedActivationCode();
    if (!activationCode) throw Object.assign(new Error("本机没有可用的官网授权登录态"), { code: "PUREAM_AUTH_REQUIRED" });
    let receipt = null;
    const text = await generateText({
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: activationCode,
      model: String(process.env.DRAMA_TEST_TEXT_MODEL || "gpt-5-6-sol"),
      temperature: 0,
      maxTokens: 32
    }, [{ role: "user", content: "只回复四个字：连接成功" }], {
      timeoutMs: Math.max(60_000, Number(process.env.DRAMA_TEST_TEXT_TIMEOUT_MS) || 300_000),
      sessionId: `release-text-smoke-${Date.now()}`,
      maxTokens: 32,
      onUsage: value => { receipt = value; }
    });
    report({
      ok: true,
      returnedText: String(text || "").slice(0, 32),
      receipt: receipt ? {
        inputTokens: Number(receipt.inputTokens ?? receipt.promptTokens ?? 0),
        outputTokens: Number(receipt.outputTokens ?? receipt.completionTokens ?? 0),
        chargeYuan: receipt.chargeYuan ?? null,
        chargeCents: receipt.chargeCents ?? null,
        billingStatus: receipt.billingStatus || receipt.settlementStatus || "",
        receiptSource: receipt.receiptSource || ""
      } : null
    });
    app.exit(0);
  } catch (error) {
    report({ ok: false, code: error?.code || "TEXT_SMOKE_FAILED", message: error?.message || String(error) });
    app.exit(1);
  }
});
