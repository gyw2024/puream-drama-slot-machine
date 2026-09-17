'use strict';
// production-v2 terminal policy — appendix B reference-code/terminal-policy.cjs.
// Adapter terminal-event classification. Text is accumulated separately; this
// function alone never validates business completeness — use businessComplete()
// with schema/receipt/coverage evidence.
const CUT = new Set(['max_tokens', 'length', 'max_output_tokens', 'max_turns', 'error_max_turns']);
function classifyEvent(agent, event) {
  const reason = String(event.stop_reason || event.finish_reason || event.subtype || '');
  // error_max_turns is a capacity cutoff with saved checkpoints (resumable),
  // so the CUT list intentionally wins over the error_* result envelope.
  if (CUT.has(reason)) return { status: 'incomplete', finishReason: reason };
  if (event.type === 'error' || event.is_error === true) return { status: 'failed', finishReason: reason || 'error' };
  if (agent === 'codex') {
    if (event.type === 'turn.completed') return { status: 'transport_complete', finishReason: 'turn.completed' };
    if (event.type === 'turn.failed') return { status: 'failed', finishReason: 'turn.failed' };
    return { status: 'running', finishReason: '' };
  }
  if (agent === 'claude-code' || agent === 'workbuddy') {
    // WorkBuddy's native CLI speaks the same result-event dialect as
    // claude-code: {"type":"result","subtype":"success"|"error_*"}.
    if (event.type === 'result' && event.subtype === 'success' && event.is_error !== true) return { status: 'transport_complete', finishReason: 'result.success' };
    if (event.type === "result" && /^error_/.test(reason)) return { status: "failed", finishReason: reason };
    return { status: 'running', finishReason: '' };
  }
  if (agent === 'antigravity') {
    // agy CLI streams {"event":"init|update|result|error"} lines.
    if (event.event === 'result') return { status: 'transport_complete', finishReason: 'event.result' };
    if (event.event === 'error') return { status: 'failed', finishReason: 'event.error' };
    return { status: 'running', finishReason: '' };
  }
  if (agent === 'grokbuild') {
    // Grok Build shares the codex turn dialect and also emits result lines.
    if (event.type === 'turn.completed' || event.type === 'result') return { status: 'transport_complete', finishReason: String(event.type) };
    if (event.type === 'turn.failed') return { status: 'failed', finishReason: 'turn.failed' };
    return { status: 'running', finishReason: '' };
  }
  if (agent === 'deepseek-harness') {
    // The Python harness SDK emits {"event":"result"|"error"} envelopes.
    if (event.event === 'result' || event.type === 'result') return { status: 'transport_complete', finishReason: 'event.result' };
    if (event.event === 'error') return { status: 'failed', finishReason: 'event.error' };
    return { status: 'running', finishReason: '' };
  }
  // Unknown agent events require an adapter fixture, never infer completion from arbitrary text.
  return { status: 'running', finishReason: '' };
}
function businessComplete({ transport, validReceipt, validSchema, coverageComplete, sourceCurrent, cancelled }) {
  return !cancelled && sourceCurrent === true && validSchema === true && coverageComplete === true &&
    (validReceipt === true || transport === 'transport_complete');
}
module.exports = { classifyEvent, businessComplete };
