"use strict";

// IPC responses are user-facing. Keep the action that a user can take, while
// never reflecting provider URLs, model identifiers, request IDs or raw JSON.
function sanitizePublicMessage(value, code = "", kind = "") {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  const normalizedCode = String(code || "").trim().toUpperCase();
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if(normalizedCode==='AGENT_EVIDENCE_PENDING')return '审核证据尚未齐全，完成内容已保存；需补齐具体证据后继续，不重复消耗相同请求。';
  if(normalizedCode==='PROMPT_CONFIRMATION_REQUIRED')return '提示词已变化，请核对并确认当前版本后继续生成。';
  if(normalizedCode==='PROMPT_TRANSLATION_PENDING')return '中文修改已保存，正在等待对应执行稿完成翻译与审核。';
  if (!raw) return "发生未知错误";
  if (normalizedCode.startsWith("LOCAL_AGENT_")) return raw.slice(0,500);
  if (normalizedCode === "LOCAL_MEDIA_TIMEOUT") return "本地媒体处理超时，原始文件保留；可重试粗剪或直接导出剪映草稿。本地后期没有调用付费生成。";
  if (normalizedCode === "LOCAL_MEDIA_CANCELLED") return "本地后期已取消，原始文件保留；可以重新开始。";
  if (normalizedCode === "VIDEO_METADATA_SANITIZE_TIMEOUT") return "本地元数据清理超时，原始文件保留；可重试或直接导出剪映草稿，未提交上游生成任务。";
  if (/^VIDEO_METADATA_/.test(normalizedCode)) return "本地视频元数据清理未完成，源文件保留；请检查磁盘空间和文件权限后重试，也可直接导出剪映草稿。";
  if (["MEDIA_QUALITY_ANALYSIS_FAILED", "VISUAL_QUALITY_ANALYSIS_FAILED", "FINAL_DURATION_CONTRACT_FAILED", "FINAL_VIDEO_TECHNICAL_INTEGRITY_FAILED"].includes(normalizedCode)) return "本地音画检查未通过，原视频已保留；可查看质检详情、重试粗剪或直接导出剪映草稿。";
  if (normalizedCode === "FFMPEG_NOT_FOUND") return "未找到本地媒体处理组件 FFmpeg；可修复安装后粗剪，也可先直接导出剪映草稿。";
  if (["FFMPEG_FAILED", "EXACT_STITCH_FAILED", "LOCAL_VIDEO_PROBE_FAILED", "FINAL_DURATION_PROBE_FAILED"].includes(normalizedCode)) return "本地视频读取或编码未完成，原视频已保留；请检查分镜文件可播放后重试，也可尝试直接导出剪映草稿。";
  if (/^(?:LICENSE_OFFLINE|LICENSE_OFFLINE_EXPIRED|WEBSITE_AUTH_UNAVAILABLE|ROLE_REVALIDATION_UNAVAILABLE|CONCURRENCY_AUTHORITY_OFFLINE|PUREAM_ACCOUNT_OFFLINE)$/.test(normalizedCode)) {
    return "应用授权服务正在恢复，请保持联网后稍后点击在线激活；无需修改文本模型配置";
  }
  if (/^(?:INVALID_CODE|INVALID_SERVER_CODE)$/.test(normalizedCode)) {
    return "授权码无效，请检查授权码后重新激活";
  }
  if (/^(?:NEED_ACTIVATION|PUREAM_AUTH_REQUIRED)$/.test(normalizedCode)) {
    return "请先输入纯梦授权码并完成在线激活";
  }
  if (/^DEVICE_BOUND$/.test(normalizedCode)) {
    return "该授权码已绑定其他设备，请联系管理员解绑；管理员授权码不会受设备数量限制";
  }
  if (/^USER_DISABLED$/.test(normalizedCode)) {
    return "当前账号已停用，请联系管理员恢复后重试";
  }
  if (/^(?:SUBSCRIPTION_EXPIRED|DRAMA_SUBSCRIPTION_REQUIRED|SUBSCRIPTION_REQUIRED)$/.test(normalizedCode)) {
    return "当前账号的短剧套餐未开通或已到期，请续费后重试";
  }
  if (/^(?:CONCURRENCY_AUTHORITY_INVALID|DRAMA_AUTH_SYNC_FAILED)$/.test(normalizedCode)) {
    return "应用授权资料正在同步，请稍后点击在线激活；无需重复购买套餐";
  }
  if (/DAILY_QUOTA_EXHAUSTED/.test(normalizedCode)) {
    return "模型项目的日配额当前不可用，现有进度已保存；可在配额恢复后继续，或切换有可用额度的模型";
  }
  if (/RATE_LIMIT|TOO_MANY_REQUESTS/.test(normalizedCode)
    || /rate[_ -]?limit|too many requests|quota window|请求过于频繁|限流|\b429\b/.test(lower)) {
    return "上游当前限流，现有进度已保存；软件会按恢复窗口续接同一任务，不会重写已完成内容";
  }
  if (/INSUFFICIENT|BALANCE/.test(normalizedCode)
    || /余额|额度不足|insufficient[_ -]?(?:fund|quota)|quota[^\r\n]{0,40}not enough|balance/.test(lower)) {
    return "当前账户额度不足，请充值或更换有额度的账户后重试";
  }
  const explicitProviderAuthorization = normalizedKind === "provider"
    || /(?:^|_)(?:PROVIDER|MODEL|API_KEY)(?:_|$)/.test(normalizedCode);
  if (explicitProviderAuthorization && (
    /(?:AUTH|UNAUTHORIZED|FORBIDDEN|INVALID_API_KEY|API_KEY_INVALID)/.test(normalizedCode)
    || /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?key|key)|api[_ -]?key|模型鉴权/.test(lower)
  )) {
    return "模型授权无效，请检查授权配置后重试";
  }
  if (/model.*(?:not found|不存在|unavailable)|模型.*(?:不存在|不可用)/.test(lower)) {
    return "当前模型不可用，请在模型列表中选择可用模型";
  }
  if (/timeout|timed out|超时/.test(lower)) return "上游响应暂时超时，现有任务断点已保留；软件会沿用原请求继续恢复";
  if (/network|connect|fetch|socket|连接|网络/.test(lower)
    || /BRIDGE_NETWORK|REFERENCE_MEDIA_UPLOAD/.test(normalizedCode)) {
    return "网络短暂中断，软件会从原任务断点自动恢复，不会重复创建付费任务";
  }
  return raw
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/g, "本地文件")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "官方服务")
    .replace(/\b(?:puream[-_]?hailuo[-_]?h3|minimax[\s_-]*h3|hailuo[-_]?h3)\b/gi, "云端视频服务")
    .replace(/\b(?:request|trace|correlation|task|job)[-_ ]?id\s*[:=]?\s*[A-Za-z0-9._:-]+/gi, "请求编号")
    .replace(/\b(?:model|endpoint|provider|host|url)\s*[:=]\s*[^,;\s}]+/gi, "服务配置")
    .replace(/\b(?:bearer|authorization|api[_ -]?key)\s*[:=]?\s*[^,;\s}]+/gi, "授权信息")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "发生未知错误";
}

function publicError(error) {
  const allowedKinds = new Set(["provider", "billing", "network", "validation", "authorization", "internal"]);
  const errorKind = allowedKinds.has(String(error?.kind || "").toLowerCase())
    ? String(error.kind).toLowerCase()
    : "";
  return {
    ok: false,
    expectedControl:error?.expectedControl===true,
    recoverable:error?.recoverable===true,
    code: error?.code || "UNEXPECTED_ERROR",
    message: sanitizePublicMessage(error?.message, error?.code, errorKind),
    errorKind,
    retryable: error?.retryable === true,
    userAction: error?.userAction ? sanitizePublicMessage(error.userAction, error?.code, errorKind) : ""
  };
}

// Browser/network APIs may throw DOMException instances whose `code` property
// is exposed through a getter only. Mutating such an error masks the real
// failure with `Cannot set property code ... which has only a getter`. Always
// create a writable Error when adding transport or task context, while keeping
// the original exception available as the cause for internal diagnostics.
function errorWithContext(error, context = {}) {
  const original = error instanceof Error ? error : new Error(String(error || "发生未知错误"));
  const requestedMessage = Object.prototype.hasOwnProperty.call(context, "message")
    ? String(context.message || "")
    : "";
  const wrapped = new Error(requestedMessage || String(original.message || original || "发生未知错误"), {
    cause: original
  });
  wrapped.name = String(context.name || original.name || "Error");

  const transferableKeys = [
    "code", "status", "kind", "expectedControl", "recoverable", "details", "stage", "retryable", "userAction", "requestId",
    "sessionId", "attempt", "partialText", "rawText", "rawTextLength",
    "rawTextSha256", "rawTextTruncated", "reasoningText", "rawResponse",
    "rawResponseLength", "upstreamDone", "upstreamReceipt", "finishReason",
    "noAutomaticRetry", "retryRequiresExplicitResume", "remoteGenerationPending", "remoteSubmissionUnknown",
    "clientRequestId", "idempotencyKey", "taskId", "remoteUrl",
    "noRemoteTaskCreated", "transportCode", "uploadPhase", "mediaType",
    "remoteGenerationCompleted", "chargeYuan", "settlementStatus", "upstream", "upstreamCode", "upstreamStatus",
    "retryAfterMs", "quotaWindow", "quotaIds", "quotaMetrics",
    "maximumRetryDelayMs", "cumulativeRetryDelayMs",
    "timeoutKind", "idleTimeoutMs", "usageMetadata",
    "responseId", "modelVersion", "providerDiagnostics", "blockReason", "providerResponseAccepted", "requestDispatchUncertain",
    "acceptedSemanticUnitCount", "failedSemanticRange"
  ];
  for (const key of transferableKeys) {
    if (Object.prototype.hasOwnProperty.call(context, key)) continue;
    try {
      if (original[key] !== undefined) wrapped[key] = original[key];
    } catch {}
  }
  for (const [key, value] of Object.entries(context || {})) {
    if (["message", "name", "cause"].includes(key) || value === undefined) continue;
    wrapped[key] = value;
  }
  return wrapped;
}

module.exports = { sanitizePublicMessage, publicError, errorWithContext };
