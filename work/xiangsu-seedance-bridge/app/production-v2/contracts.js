'use strict';
// production-v2 contracts — transcribed from implementation package appendix B
// (reference-code/contracts.cjs) at T02. Single source of canonical hashing,
// stable IDs, error contract and exact coverage sets.
const crypto = require('node:crypto');
function fail(code, message, details = {}) { return Object.assign(new Error(message), { code, details, noAutomaticRetry: true }); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('UNSAFE_KEY', 'Unsafe property');
      if (value[key] === undefined) throw fail('UNDEFINED_VALUE', 'Normalize undefined before hashing', { key });
      result[key] = canonical(value[key]);
    }
    return result;
  }
  throw fail('NON_JSON_VALUE', 'Only finite JSON values are accepted');
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex'); }
function textHash(value) { if (typeof value !== 'string') throw fail('TEXT_REQUIRED', 'Text must be a string'); return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function assertUniqueIds(rows, key = 'id') {
  if (!Array.isArray(rows)) throw fail('ARRAY_REQUIRED', 'Rows must be an array');
  const seen = new Set();
  for (const row of rows) {
    const id = row?.[key];
    if (typeof id !== 'string' || !id.trim() || ['__proto__', 'constructor', 'prototype'].includes(id) || seen.has(id)) throw fail('INVALID_OR_DUPLICATE_ID', 'Missing or duplicate stable ID', { id });
    seen.add(id);
  }
  return seen;
}
function exactCoverage(expected, delivered) {
  const exp = assertUniqueIds(expected.map(id => ({ id }))); const counts = new Map();
  for (const id of delivered) counts.set(id, (counts.get(id) || 0) + 1);
  const missing = [...exp].filter(id => !counts.has(id));
  const extra = [...counts.keys()].filter(id => !exp.has(id));
  const duplicate = [...counts].filter(([, n]) => n !== 1).map(([id]) => id);
  return { ok: !missing.length && !extra.length && !duplicate.length, missing, extra, duplicate };
}
module.exports = { fail, canonical, hash, textHash, assertUniqueIds, exactCoverage };
