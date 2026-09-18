'use strict';
const crypto = require('node:crypto');
function fail(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details, noAutomaticRetry: true });
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('UNSAFE_KEY', key);
      if (value[key] === undefined) throw fail('UNDEFINED_VALUE', key);
      out[key] = canonical(value[key]);
    }
    return out;
  }
  throw fail('NON_JSON_VALUE', 'Only finite JSON values are accepted');
}
function hash(v) { return crypto.createHash('sha256').update(JSON.stringify(canonical(v)), 'utf8').digest('hex'); }
function textHash(v) { if (typeof v !== 'string') throw fail('TEXT_REQUIRED', 'Expected text'); return crypto.createHash('sha256').update(v, 'utf8').digest('hex'); }
function stableId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function nonempty(v, name) { if (typeof v !== 'string' || !v.trim()) throw fail('FIELD_REQUIRED', name); return v; }
function integer(v, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw fail('INTEGER_OUT_OF_RANGE', name, { value: v, min, max });
  return v;
}
function unique(rows, field = 'id') {
  if (!Array.isArray(rows)) throw fail('ARRAY_REQUIRED', field);
  const seen = new Set();
  for (const row of rows) {
    const id = row?.[field];
    if (typeof id !== 'string' || !id.trim() || ['__proto__', 'prototype', 'constructor'].includes(id) || seen.has(id)) {
      throw fail('INVALID_OR_DUPLICATE_ID', field, { id });
    }
    seen.add(id);
  }
  return seen;
}
function exactCoverage(expected, delivered) {
  const want = unique(expected.map(id => ({ id }))); const counts = new Map();
  delivered.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
  const missing = [...want].filter(id => !counts.has(id));
  const extra = [...counts.keys()].filter(id => !want.has(id));
  const duplicate = [...counts].filter(([, n]) => n !== 1).map(([id]) => id);
  return { ok: !missing.length && !extra.length && !duplicate.length, missing, extra, duplicate };
}
module.exports = { fail, canonical, hash, textHash, stableId, nonempty, integer, unique, assertUniqueIds: unique, exactCoverage };

