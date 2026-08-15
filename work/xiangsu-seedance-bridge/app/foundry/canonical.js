"use strict";

const crypto = require("node:crypto");

function canonicalValue(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (seen.has(value)) throw Object.assign(new Error("不能对循环引用数据建立生产指纹"), { code: "FOUNDRY_CYCLIC_VALUE" });
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map(item => canonicalValue(item, seen));
  } else {
    normalized = {};
    for (const key of Object.keys(value).filter(key => key !== "__storeBaseline").sort()) {
      const item = value[key];
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") continue;
      normalized[key] = canonicalValue(item, seen);
    }
  }
  seen.delete(value);
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  return crypto.createHash("sha256").update(input).digest("hex");
}

function fingerprint(value) {
  return sha256(canonicalJson(value));
}

function cloneCanonical(value) {
  return JSON.parse(canonicalJson(value));
}

module.exports = { canonicalJson, canonicalValue, cloneCanonical, fingerprint, sha256 };
