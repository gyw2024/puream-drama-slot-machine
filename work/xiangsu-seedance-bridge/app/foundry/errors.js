"use strict";

const ERROR_KINDS = Object.freeze({
  CONTROL_SIGNAL: "ControlSignal",
  USER_ACTION_REQUIRED: "UserActionRequired",
  CREATIVE_DEFECT: "CreativeDefect",
  CONTRACT_VIOLATION: "ContractViolation",
  PROVIDER_TRANSIENT: "ProviderTransient",
  PROVIDER_TERMINAL: "ProviderTerminal",
  INTERNAL_INVARIANT: "InternalInvariantViolation"
});

class FoundryError extends Error {
  constructor(message, options = {}) {
    super(String(message || "生产内核异常"), options.cause ? { cause: options.cause } : undefined);
    this.name = options.name || "FoundryError";
    this.code = String(options.code || "FOUNDRY_ERROR");
    this.kind = options.kind || ERROR_KINDS.INTERNAL_INVARIANT;
    this.retryable = options.retryable === true;
    this.userAction = options.userAction || "";
    this.details = options.details && typeof options.details === "object" ? options.details : {};
  }
}

function classifyError(error) {
  if (error instanceof FoundryError) return error;
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "未知异常");
  if (/PAUSED|STOPPED|CANCELLED|ABORT/.test(code)) {
    return new FoundryError(message, { code: code || "CONTROL_SIGNAL", kind: ERROR_KINDS.CONTROL_SIGNAL, details: { originalCode: code } });
  }
  if (/REQUIRED|NOT_CONFIRMED|MISSING|NOT_FOUND|LOGIN|AUTH|QUOTA|ACCOUNT_SWITCH/.test(code)) {
    return new FoundryError(message, { code: code || "USER_ACTION_REQUIRED", kind: ERROR_KINDS.USER_ACTION_REQUIRED, userAction: "review_and_continue", details: { originalCode: code } });
  }
  if (/QUALITY|STORY|DIALOGUE|CONTINUITY|SEMANTIC|BLUEPRINT/.test(code)) {
    return new FoundryError(message, { code: code || "CREATIVE_DEFECT", kind: ERROR_KINDS.CREATIVE_DEFECT, retryable: true, details: { originalCode: code } });
  }
  if (/CONTRACT|PARITY|POLICY|FORBIDDEN|MISMATCH|INVALID_REFERENCE/.test(code)) {
    return new FoundryError(message, { code: code || "CONTRACT_VIOLATION", kind: ERROR_KINDS.CONTRACT_VIOLATION, details: { originalCode: code } });
  }
  if (/TIMEOUT|ECONN|NETWORK|RATE_LIMIT|SERVER_ERROR|ERR_FAILED|UPSTREAM_UNAVAILABLE/.test(`${code} ${message}`.toUpperCase())) {
    return new FoundryError(message, { code: code || "PROVIDER_TRANSIENT", kind: ERROR_KINDS.PROVIDER_TRANSIENT, retryable: true, details: { originalCode: code } });
  }
  if (/PROVIDER|MODEL|CONTENT_POLICY|PROMPT_TOO_LONG|PROMPT_TOO_LONG/.test(code)) {
    return new FoundryError(message, { code: code || "PROVIDER_TERMINAL", kind: ERROR_KINDS.PROVIDER_TERMINAL, details: { originalCode: code } });
  }
  return new FoundryError(message, { code: code || "INTERNAL_INVARIANT_VIOLATION", kind: ERROR_KINDS.INTERNAL_INVARIANT, details: { originalCode: code } });
}

module.exports = { ERROR_KINDS, FoundryError, classifyError };
