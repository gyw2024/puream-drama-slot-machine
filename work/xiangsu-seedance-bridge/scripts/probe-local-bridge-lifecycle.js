"use strict";

const { BridgeClient } = require("../app/bridge-client");

async function main() {
  const seconds = Math.max(5, Math.min(120, Number(process.env.DRAMA_SLOT_BRIDGE_PROBE_SECONDS) || 30));
  const client = new BridgeClient();
  const launch = client.launchXiangsuBridge();
  process.stdout.write(`${JSON.stringify({ event: "launch", at: new Date().toISOString(), ...launch })}\n`);
  const deadline = Date.now() + (seconds * 1_000);
  while (Date.now() < deadline) {
    const health = await client.health();
    process.stdout.write(`${JSON.stringify({
      event: "health",
      at: new Date().toISOString(),
      ok: health.ok === true,
      ready: health.ready === true,
      code: health.code || "",
      version: health.version || health.runningVersion || "",
      message: health.message || ""
    })}\n`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const finalHealth = await client.health();
  if (!(finalHealth.ok && finalHealth.ready)) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
