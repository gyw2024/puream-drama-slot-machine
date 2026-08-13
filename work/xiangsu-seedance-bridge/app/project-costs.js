"use strict";

const COST_CATEGORIES = Object.freeze(["text", "image", "video"]);

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 1000) / 1000;
}

function tokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function nowIso() {
  return new Date().toISOString();
}

function makeCostId() {
  return `cost_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function emptyCategorySummary() {
  return {
    count: 0,
    knownYuan: 0,
    estimatedYuan: 0,
    pendingCount: 0,
    unpricedCount: 0,
    settledCount: 0,
    estimatedCount: 0,
    notChargedCount: 0,
    supersededCount: 0
  };
}

function defaultCostLedger() {
  return {
    version: 1,
    currency: "CNY",
    entries: [],
    summary: {
      totalKnownYuan: 0,
      totalEstimatedYuan: 0,
      pendingCount: 0,
      historicalUnknownCount: 0,
      unpricedCount: 0,
      byCategory: {
        text: emptyCategorySummary(),
        image: emptyCategorySummary(),
        video: emptyCategorySummary()
      },
      updatedAt: null
    }
  };
}

function normalizeCostEntry(entry = {}) {
  const category = COST_CATEGORIES.includes(entry.category) ? entry.category : "text";
  const status = ["pending", "settled", "estimated", "unpriced", "not_charged", "superseded"].includes(entry.status)
    ? entry.status
    : "pending";
  const amountYuan = money(entry.amountYuan);
  return {
    id: entry.id || makeCostId(),
    sourceKey: String(entry.sourceKey || entry.id || makeCostId()),
    category,
    operation: String(entry.operation || ""),
    provider: String(entry.provider || ""),
    model: String(entry.model || ""),
    status,
    amountYuan: amountYuan === null ? 0 : amountYuan,
    pricingBasis: String(entry.pricingBasis || ""),
    inputTokens: tokenCount(entry.inputTokens),
    outputTokens: tokenCount(entry.outputTokens),
    referenceCount: tokenCount(entry.referenceCount),
    durationSeconds: Math.max(0, Number(entry.durationSeconds) || 0),
    taskId: String(entry.taskId || ""),
    jobId: String(entry.jobId || ""),
    entityType: String(entry.entityType || ""),
    entityId: String(entry.entityId || ""),
    errorCode: String(entry.errorCode || ""),
    message: String(entry.message || ""),
    createdAt: entry.createdAt || nowIso(),
    updatedAt: entry.updatedAt || nowIso(),
    settledAt: entry.settledAt || null
  };
}

function summarizeCostEntries(entries = []) {
  const summary = {
    totalKnownYuan: 0,
    totalEstimatedYuan: 0,
    pendingCount: 0,
    historicalUnknownCount: 0,
    unpricedCount: 0,
    byCategory: {
      text: emptyCategorySummary(),
      image: emptyCategorySummary(),
      video: emptyCategorySummary()
    },
    updatedAt: nowIso()
  };
  for (const raw of entries) {
    const entry = normalizeCostEntry(raw);
    const bucket = summary.byCategory[entry.category] || summary.byCategory.text;
    bucket.count += 1;
    if (entry.status === "settled") {
      bucket.settledCount += 1;
      bucket.knownYuan = money(bucket.knownYuan + (entry.amountYuan || 0)) || 0;
      summary.totalKnownYuan = money(summary.totalKnownYuan + (entry.amountYuan || 0)) || 0;
    } else if (entry.status === "estimated") {
      bucket.estimatedCount += 1;
      bucket.estimatedYuan = money(bucket.estimatedYuan + (entry.amountYuan || 0)) || 0;
      summary.totalEstimatedYuan = money(summary.totalEstimatedYuan + (entry.amountYuan || 0)) || 0;
    } else if (entry.status === "pending") {
      bucket.pendingCount += 1;
      summary.pendingCount += 1;
      if (entry.amountYuan) {
        bucket.estimatedYuan = money(bucket.estimatedYuan + entry.amountYuan) || 0;
        summary.totalEstimatedYuan = money(summary.totalEstimatedYuan + entry.amountYuan) || 0;
      }
    } else if (entry.status === "unpriced") {
      bucket.unpricedCount += 1;
      summary.unpricedCount += 1;
    } else if (entry.status === "not_charged") {
      bucket.notChargedCount += 1;
    } else if (entry.status === "superseded") {
      bucket.supersededCount += 1;
      summary.historicalUnknownCount += 1;
    }
  }
  return summary;
}

function normalizeCostLedger(ledger) {
  const base = defaultCostLedger();
  const entries = supersedeResolvedUnknownAttempts(dedupeCostEntries(Array.isArray(ledger?.entries) ? ledger.entries : []));
  return {
    ...base,
    ...(ledger || {}),
    version: Number(ledger?.version) || 1,
    currency: ledger?.currency || "CNY",
    entries,
    summary: summarizeCostEntries(entries)
  };
}

/**
 * A POST/transport failure with no remote task id is billing-unknown at that
 * moment.  Once the same logical operation/entity later has an upstream
 * settled receipt, the old zero-yuan attempt is historical evidence, not an
 * active amount still waiting to settle.  Keep the row append-only and visible
 * as superseded; never rewrite it to not_charged and never hide an active taskId.
 */
function supersedeResolvedUnknownAttempts(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeCostEntry);
  const settled = list.filter(entry => entry.status === "settled");
  return list.map(entry => {
    if (entry.status !== "pending" || entry.amountYuan > 0 || entry.taskId) return entry;
    const hasFailureEvidence = Boolean(entry.errorCode || entry.message);
    if (!hasFailureEvidence) return entry;
    const successor = settled.find(item => {
      if (item.category !== entry.category) return false;
      if (String(item.createdAt || "") < String(entry.createdAt || "")) return false;
      if (entry.entityType && entry.entityId) {
        return item.entityType === entry.entityType && item.entityId === entry.entityId;
      }
      return entry.category === "text" && item.operation === entry.operation;
    });
    if (!successor) return entry;
    return normalizeCostEntry({
      ...entry,
      status: "superseded",
      pricingBasis: entry.pricingBasis || "历史响应未知；同一实体已有后续上游实结回执",
      message: [entry.message, `已由后续实结记录 ${successor.id} 覆盖当前显示`].filter(Boolean).join("；")
    });
  });
}

function estimateTextTokens(text = "") {
  const value = String(text || "");
  if (!value) return 0;
  // Rough bilingual estimate used when upstream usage is missing.
  const ascii = (value.match(/[\x00-\x7f]/g) || []).length;
  const other = value.length - ascii;
  return Math.max(1, Math.ceil(ascii / 4 + other * 1.1));
}

/** Built-in text rates when settings leave both unit prices at 0. */
const DEFAULT_TEXT_PRICING_FALLBACK = Object.freeze({
  inputPricePerMillion: 2,
  outputPricePerMillion: 8
});

function resolveTextPricing(prices = {}) {
  const input = Number(prices?.inputPricePerMillion);
  const output = Number(prices?.outputPricePerMillion);
  if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) {
    return {
      inputPricePerMillion: input,
      outputPricePerMillion: output,
      source: "settings"
    };
  }
  return {
    inputPricePerMillion: DEFAULT_TEXT_PRICING_FALLBACK.inputPricePerMillion,
    outputPricePerMillion: DEFAULT_TEXT_PRICING_FALLBACK.outputPricePerMillion,
    source: "builtin-fallback"
  };
}

function estimateTextCost(usage = {}, prices = {}) {
  const resolved = resolveTextPricing(prices);
  const inputPrice = Number(resolved.inputPricePerMillion);
  const outputPrice = Number(resolved.outputPricePerMillion);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  if (inputPrice < 0 || outputPrice < 0) return null;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  if (!inputTokens && !outputTokens) return null;
  return money((inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice);
}

function textPricingBasis(inputTokens, outputTokens, prices = {}) {
  const resolved = resolveTextPricing(prices);
  if (resolved.source === "settings") {
    return `按设置单价估算：输入 ${inputTokens} + 输出 ${outputTokens} tokens`;
  }
  return `按内置参考单价 ¥${resolved.inputPricePerMillion}/M 入 + ¥${resolved.outputPricePerMillion}/M 出估算（设置未填单价）：输入 ${inputTokens} + 输出 ${outputTokens} tokens`;
}

function pureamImageCost(referenceCount = 0) {
  return money(0.1 * (1 + Math.max(0, tokenCount(referenceCount))));
}

/** Official PureAM Qingbo (Grok/Gemini) and Seedance cloud rate: ¥0.15 per billed second. */
function pureamVideoCostPerSecond(durationSeconds = 0) {
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  return money(0.15 * seconds);
}

/** MiniMax Hailuo H3 public 2K list price ≈ ¥0.80 / second (estimate until upstream settles). */
function hailuoVideoCost(durationSeconds = 0) {
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  return money(0.8 * seconds);
}

const qingboVideoCost = pureamVideoCostPerSecond;
const seedanceVideoCost = pureamVideoCostPerSecond;

function inferVideoProviderKind(entry = {}, fallback = "") {
  const provider = String(entry.provider || fallback || "");
  const model = String(entry.model || "");
  const blob = `${provider} ${model}`;
  if (["puream-hailuo-h3", "puream-seedance", "puream-grok", "puream-gemini", "local-xiangsu"].includes(provider)) {
    return provider;
  }
  if (/hailuo|海螺/i.test(blob)) return "puream-hailuo-h3";
  if (/seedance/i.test(blob)) return "puream-seedance";
  if (/gemini/i.test(blob)) return "puream-gemini";
  if (/grok|清波/i.test(blob)) return "puream-grok";
  if (/xiangsu|像塑/i.test(blob)) return "local-xiangsu";
  return provider || fallback || "";
}

function estimateVideoCost(providerKind = "", durationSeconds = 0) {
  const kind = String(providerKind || "");
  if (kind === "local-xiangsu") {
    return { amountYuan: 0, status: "not_charged", basis: "本地像塑登录态未返回人民币结算" };
  }
  if (["puream-grok", "puream-gemini"].includes(kind)) {
    return {
      amountYuan: qingboVideoCost(durationSeconds),
      status: "estimated",
      basis: `纯梦清波按官网 ¥0.15/秒预估 ${Number(durationSeconds) || 0} 秒`
    };
  }
  if (kind === "puream-seedance") {
    return {
      amountYuan: seedanceVideoCost(durationSeconds),
      status: "estimated",
      basis: `PUREAM Seedance 暂按 ¥0.15/秒预估 ${Number(durationSeconds) || 0} 秒`
    };
  }
  if (kind === "puream-hailuo-h3") {
    return {
      amountYuan: hailuoVideoCost(durationSeconds),
      status: "estimated",
      basis: `纯梦云端算力按公开价 ¥0.80/秒预估 ${Number(durationSeconds) || 0} 秒（上游未结算时）`
    };
  }
  return { amountYuan: null, status: "unpriced", basis: "未知视频供应商，无法估算" };
}

function repriceCostEntries(entries = [], options = {}) {
  const textPricing = options.textPricing || {};
  return (Array.isArray(entries) ? entries : []).map(raw => {
    const entry = normalizeCostEntry(raw);
    if (entry.status === "settled" || entry.status === "not_charged") return entry;
    // Video never uses local rate estimates — only upstream charge_yuan / not_charged.
    if (entry.category === "video") return entry;

    if (entry.category === "text" && ["unpriced", "pending"].includes(entry.status)) {
      const amount = estimateTextCost({
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens
      }, textPricing);
      if (amount === null) return entry;
      return normalizeCostEntry({
        ...entry,
        status: entry.status === "pending" ? "pending" : "estimated",
        amountYuan: amount,
        pricingBasis: entry.status === "pending"
          ? `等待文本上游实扣回执；${textPricingBasis(entry.inputTokens, entry.outputTokens, textPricing)}（台账回填）`
          : `${textPricingBasis(entry.inputTokens, entry.outputTokens, textPricing)}（台账回填）`
      });
    }
    return entry;
  });
}

/** Collapse duplicate video rows that share taskId / sourceKey (concurrent save races). */
function dedupeCostEntries(entries = []) {
  const list = Array.isArray(entries) ? entries.map(raw => {
    const entry = normalizeCostEntry(raw);
    // Video money is upstream-only: drop local rate-card estimates.
    if (entry.category === "video" && entry.status === "estimated") {
      return normalizeCostEntry({
        ...entry,
        status: "pending",
        amountYuan: 0,
        pricingBasis: "等待上游返回实际扣费金额"
      });
    }
    return entry;
  }) : [];
  const byKey = new Map();
  for (const entry of list) {
    const key = entry.category === "video"
      ? (entry.taskId ? `video-task:${entry.taskId}` : entry.sourceKey ? `video-source:${entry.sourceKey}` : `id:${entry.id}`)
      : `id:${entry.id}`;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, entry);
      continue;
    }
    const rank = item => ({ settled: 5, not_charged: 4, superseded: 3, pending: 2, estimated: 1, unpriced: 0 })[item.status] || 0;
    const prefer = rank(entry) > rank(previous)
      || (rank(entry) === rank(previous) && String(entry.updatedAt || "") >= String(previous.updatedAt || ""));
    byKey.set(key, prefer ? { ...entry, id: previous.id } : previous);
  }
  return [...byKey.values()];
}

function backfillProjectCosts(project = {}, options = {}) {
  const ledger = normalizeCostLedger(project.costLedger);
  const bySource = new Map(ledger.entries.map(entry => [entry.sourceKey, entry]));
  const byTask = new Map(
    ledger.entries
      .filter(entry => entry.category === "video" && entry.taskId)
      .map(entry => [entry.taskId, entry])
  );
  const jobs = Array.isArray(project.jobs) ? project.jobs : [];
  for (const job of jobs) {
    if (!["shot_video", "character_video"].includes(job?.type)) continue;
    const sourceKey = `video:${job.taskId || job.id}`;
    const providerKind = job.providerKind || "local-xiangsu";
    const duration = Number(job.duration) || 5;
    const rawCharge = job.chargeYuan ?? job.charge_yuan;
    const hasActual = rawCharge !== null && rawCharge !== undefined && rawCharge !== "" && Number.isFinite(Number(rawCharge));
    const settlement = String(job.settlementStatus || job.settlement_status || job.billingStatus || "").toLowerCase();
    const reserved = ["reserved", "pending", "processing", "billing_pending"].includes(settlement);
    const notCharged = ["not_charged", "refunded", "free"].includes(settlement) || providerKind === "local-xiangsu";
    // Never invent local rate estimates for video.
    if (!hasActual && !notCharged) continue;

    const status = notCharged
      ? "not_charged"
      : (reserved ? "pending" : "settled");
    const amountYuan = notCharged ? 0 : Number(rawCharge);
    const pricingBasis = notCharged
      ? "本地像塑或上游标明不计费 · 历史任务回填"
      : "视频上游返回的实际人民币结算 · 历史任务回填";

    const existing = (job.taskId && byTask.get(job.taskId)) || bySource.get(sourceKey) || null;
    if (existing) {
      if (hasActual && ["estimated", "pending", "unpriced"].includes(existing.status) && !notCharged) {
        const upgraded = normalizeCostEntry({
          ...existing,
          status,
          amountYuan,
          pricingBasis,
          sourceKey,
          durationSeconds: duration,
          taskId: job.taskId || existing.taskId || "",
          jobId: job.id || existing.jobId || ""
        });
        const index = ledger.entries.findIndex(item => item.id === existing.id);
        if (index >= 0) ledger.entries[index] = upgraded;
        bySource.set(sourceKey, upgraded);
        if (job.taskId) byTask.set(job.taskId, upgraded);
      }
      continue;
    }

    const entry = normalizeCostEntry({
      sourceKey,
      category: "video",
      operation: `视频生成 · ${job.type}`,
      provider: providerKind,
      model: job.model || providerKind,
      status,
      amountYuan,
      pricingBasis,
      durationSeconds: duration,
      taskId: job.taskId || "",
      jobId: job.id || "",
      entityType: job.entityType || "",
      entityId: job.entityId || ""
    });
    ledger.entries.push(entry);
    bySource.set(sourceKey, entry);
    if (job.taskId) byTask.set(job.taskId, entry);
  }
  ledger.entries = dedupeCostEntries(repriceCostEntries(ledger.entries, { textPricing: options.textPricing || {} }));
  return normalizeCostLedger(ledger);
}

module.exports = {
  COST_CATEGORIES,
  DEFAULT_TEXT_PRICING_FALLBACK,
  backfillProjectCosts,
  defaultCostLedger,
  dedupeCostEntries,
  estimateTextCost,
  estimateTextTokens,
  estimateVideoCost,
  hailuoVideoCost,
  money,
  normalizeCostEntry,
  normalizeCostLedger,
  pureamImageCost,
  pureamVideoCostPerSecond,
  qingboVideoCost,
  repriceCostEntries,
  resolveTextPricing,
  seedanceVideoCost,
  summarizeCostEntries,
  supersedeResolvedUnknownAttempts,
  textPricingBasis
};
