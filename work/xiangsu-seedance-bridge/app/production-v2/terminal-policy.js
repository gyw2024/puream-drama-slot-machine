'use strict';
const {fail}=require('./contracts');
const TRUNCATION=new Set(['max_tokens','max_output_tokens','length','max_turns','context_length_exceeded']);
function normalizedTerminal(e){
  // Adapter extracts these fields from its tested native event dialect. This function does not guess dialects.
  if(!e||e.eventKind!=='turn_terminal')return {terminal:false,status:'running'};
  if(e.cancelled===true)return {terminal:true,status:'cancelled',reason:e.reason||'cancelled'};
  if(TRUNCATION.has(e.finishReason)||e.nativeStatus==='incomplete')return {terminal:true,status:'incomplete',reason:e.finishReason||'incomplete'};
  if(e.nativeStatus==='paused'||e.finishReason==='pause_turn'||e.finishReason==='tool_use')return {terminal:true,status:'paused',reason:e.finishReason||'paused'};
  if(e.nativeStatus==='failed'||e.error)return {terminal:true,status:'failed',reason:e.error?.code||e.finishReason||'failed'};
  if(e.nativeStatus==='completed'&&e.naturalEnd===true)return {terminal:true,status:'generation_complete',reason:e.finishReason||'natural_end'};
  return {terminal:true,status:'outcome_unknown',reason:'UNRECOGNIZED_TERMINAL'};
}
function acceptBusinessCompletion({terminal,receipt,inputHash,schemaHash,sourceHash,policyHash,leaseEpoch,cancelled}){
  if(cancelled)throw fail('CANCELLED','Cancelled task cannot become completed');
  if(!receipt||receipt.inputHash!==inputHash||receipt.schemaHash!==schemaHash||receipt.sourceHash!==sourceHash||receipt.policyHash!==policyHash||receipt.leaseEpoch!==leaseEpoch||receipt.validatorVersion!=='delivery-r2'||receipt.coverageComplete!==true||receipt.schemaValid!==true||!receipt.artifactHash)throw fail('DELIVERY_INCOMPLETE','A valid current full receipt is required');
  // A full MCP transaction can finish before its client process exits. Do not wait forever for idle CLI.
  if(terminal?.status==='failed'&&terminal.reason==='CONTENT_REJECTED')throw fail('CONTENT_REJECTED','Do not hide a terminal validation failure');
  return { status: 'completed', artifactHash: receipt.artifactHash };
}

function classifyEvent(agentId, event) {
  if (!event || typeof event !== 'object') return { status: 'running', finishReason: '' };
  if (event.stop_reason === 'max_tokens' || event.stop_reason === 'max_output_tokens' || event.finishReason === 'max_tokens' || event.finish_reason === 'max_tokens' || event.reason === 'max_tokens') {
    return { status: 'incomplete', finishReason: 'max_tokens' };
  }
  if (event.type === 'result' && event.subtype === 'error_max_turns') {
    return { status: 'incomplete', finishReason: 'error_max_turns' };
  }
  if (event.type === 'turn.failed' || event.event === 'error' || (event.type === 'result' && event.subtype === 'error_during_execution') || event.error) {
    return { status: 'failed', finishReason: event.subtype || event.error?.code || event.message || 'failed' };
  }
  if (agentId === 'codex') {
    if (event.type === 'turn.completed') return { status: 'transport_complete', finishReason: 'turn_completed' };
    return { status: 'running', finishReason: '' };
  }
  if (agentId === 'claude-code' || agentId === 'workbuddy') {
    if (event.type === 'result' && event.subtype === 'success') return { status: 'transport_complete', finishReason: 'success' };
    return { status: 'running', finishReason: '' };
  }
  if (agentId === 'antigravity') {
    if (event.event === 'result' && event.result) return { status: 'transport_complete', finishReason: 'result' };
    return { status: 'running', finishReason: '' };
  }
  if (agentId === 'grokbuild') {
    if (event.type === 'turn.completed') return { status: 'transport_complete', finishReason: 'turn_completed' };
    return { status: 'running', finishReason: '' };
  }
  if (agentId === 'deepseek-harness') {
    if (event.event === 'result' && event.result) return { status: 'transport_complete', finishReason: 'result' };
    return { status: 'running', finishReason: '' };
  }
  return { status: 'running', finishReason: '' };
}

function businessComplete(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.cancelled) return false;
  if (e.validSchema !== true || e.coverageComplete !== true || e.sourceCurrent !== true) return false;
  return Boolean(e.validReceipt || e.transport === 'transport_complete');
}

module.exports = { normalizedTerminal, acceptBusinessCompletion, classifyEvent, businessComplete };
