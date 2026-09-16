'use strict';
// A narrow validator for the schemas this application supplies. Unknown schema
// keywords fail closed: a native acknowledgement alone is never validation.
function conforms(value, schema) {
  if (schema === true) return true;
  if (!schema || schema === false || typeof schema !== 'object') return false;
  const supported = new Set(['type','properties','required','additionalProperties','items','anyOf','enum','const','minLength','maxLength','pattern','minimum','maximum','minItems','maxItems','uniqueItems','description','title','$schema']);
  if (Object.keys(schema).some(key => !supported.has(key))) return false;
  if (schema.anyOf && !schema.anyOf.some(branch => conforms(value, branch))) return false;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => t === type || t === 'integer' && Number.isInteger(value))) return false;
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (type === 'string') {
    if ([...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern) { try { if (!new RegExp(schema.pattern, 'u').test(value)) return false; } catch { return false; } }
  }
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
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
module.exports = {conforms, createReceiptTracker};
