'use strict';
// A narrow validator for the schemas this application supplies. Unknown schema
// keywords fail closed: a native acknowledgement alone is never validation.
// T01 (production-v2): canonical JSON comparison for enum/const/uniqueItems,
// validateSchemaSupported() pre-flight and validateSubmittedValue() as the
// single authoritative verdict (conforms decides; inspect only explains).
const SUPPORTED_KEYWORDS = new Set(['type','properties','required','additionalProperties','items','anyOf','enum','const','minLength','maxLength','pattern','minimum','maximum','minItems','maxItems','uniqueItems','description','title','$schema','format']);
// 'format' is accepted as a draft-07 ANNOTATION only (no assertion), matching
// legacy schemas found in real task data; all other unknown keywords stay
// fail-closed and are reported by validateSchemaSupported.
// Canonical JSON text: object keys sorted, so key order never changes semantics.
// Used for enum/const/uniqueItems instead of raw JSON.stringify order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}
function sameJson(a, b) { return stableStringify(a) === stableStringify(b); }
function conforms(value, schema) {
  if (schema === true) return true;
  if (!schema || schema === false || typeof schema !== 'object') return false;
  if (Object.keys(schema).some(key => !SUPPORTED_KEYWORDS.has(key))) return false;
  if (schema.anyOf && !schema.anyOf.some(branch => conforms(value, branch))) return false;
  if (schema.enum && !schema.enum.some(item => sameJson(item, value))) return false;
  if ('const' in schema && !sameJson(schema.const, value)) return false;
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => t === type || t === 'integer' && Number.isInteger(value))) return false;
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (type === 'string') {
    if ([...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern) { try { if (!new RegExp(schema.pattern, 'u').test(value)) return false; } catch { return false; } }
  }
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map(stableStringify)).size !== value.length) return false;
    if (schema.items && value.some(v => !conforms(v, schema.items))) return false;
  }
  if (type === 'object') {
    const properties = schema.properties || {};
    if ((schema.required || []).some(k => !Object.prototype.hasOwnProperty.call(value, k))) return false;
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) { if (!conforms(child, properties[key])) return false; }
      else if (schema.additionalProperties === false || typeof schema.additionalProperties === 'object' && !conforms(child, schema.additionalProperties)) return false;
    }
  }
  return true;
}
// Pre-flight called BEFORE a model request is built: an unsupported schema is a
// program configuration error and must never enter model-driven repair.
// Traversal is schema-aware: keys inside properties/patternProperties/$defs are
// property/definition NAMES (not keywords); enum/const/type values are data.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);
const SCHEMA_VALUE_KEYWORDS = new Set(['additionalProperties', 'items', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']);
function validateSchemaSupported(schema, rootPath = '$') {
  const unsupported = [];
  const walk = (node, at) => {
    if (node === true || node === false || node === null) return;
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${at}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) { unsupported.push({ path: at, keyword: key }); continue; }
      const next = `${at}.${key}`;
      if (SCHEMA_MAP_KEYWORDS.has(key)) {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          for (const [name, sub] of Object.entries(child)) walk(sub, `${next}.${name}`);
        }
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        walk(child, next);
      } else if (key === 'anyOf') {
        if (Array.isArray(child)) child.forEach((sub, i) => walk(sub, `${next}[${i}]`));
      }
      // enum/const/type/required/minLength/... hold plain values — not schemas.
    }
  };
  walk(schema, rootPath);
  return { ok: unsupported.length === 0, unsupported };
}
// Single authoritative submission verdict: conforms() decides validity;
// inspect() only explains the failure and can never override it to valid.
function validateSubmittedValue(value, schema) {
  if (conforms(value, schema)) return { valid: true, findings: [] };
  // Lazy require: agent-output-normalization requires this module at load time.
  const findings = require('./agent-output-normalization').inspect(value, schema);
  return {
    valid: false,
    findings: findings.length ? findings : [{ path: '$', reason: 'Submitted value does not conform to the complete schema' }]
  };
}
function createReceiptTracker(schema, unwrap) {
  const calls = new Map();
  let accepted = null;
  const rejected=[];
  return {
    observe(event) {
      for (const part of event?.message?.content || []) {
        if (event.type === 'assistant' && part.type === 'tool_use' && part.name === 'StructuredOutput' && part.id) calls.set(part.id, part.input);
        if (event.type !== 'user' || part.type !== 'tool_result' || part.is_error) continue;
        const content = typeof part.content === 'string' ? part.content : (part.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
        if(calls.has(part.tool_use_id)&&content.startsWith('Output does not match required schema:'))rejected.push({toolUseId:part.tool_use_id,reason:content});
        if (content.trim() !== 'Structured output captured successfully' || !calls.has(part.tool_use_id)) continue;
        let value;
        try { value = JSON.parse(unwrap(JSON.stringify(calls.get(part.tool_use_id)), schema.required || [])); } catch { continue; }
        const projected=require('./typed-output-projection').project(value,schema);
        if (projected!==undefined) accepted = {toolUseId:part.tool_use_id, value:projected};
      }
    },
    recover(error) {
      // Authentication, quota, cancellation, provider errors and unacknowledged
      // partial tool calls remain failures, even if another item looked valid.
      return error?.code === 'LOCAL_AGENT_EMPTY_RESPONSE' ? accepted : null;
    },
    get accepted() { return accepted; },
    get rejected() { return rejected; }
  };
}
module.exports = {conforms, createReceiptTracker, stableStringify, sameJson, validateSchemaSupported, validateSubmittedValue, SUPPORTED_KEYWORDS};
