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
    notChargedCount: 0
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
  const status = ["pending", "settled", "estimated", "unpriced", "not_charged"].includes(entry.status)
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
    }
  }
  return summary;
}

function normalizeCostLedger(ledger) {
  const base = defaultCostLedger();
  const entries = Array.isArray(ledger?.entries) ? ledger.entries.map(normalizeCostEntry) : [];
  return {
    ...base,
    ...(ledger || {}),
    version: Number(ledger?.version) || 1,
    currency: ledger?.currency || "CNY",
    entries,
    summary: summarizeCostEntries(entries)
  };
}

function estimateTextTokens(text = "") {
  const value = String(text || "");
  if (!value) return 0;
  // Rough bilingual estimate used when upstream usage is missing.
  const ascii = (value.match(/[\x00-\x7f]/g) || []).length;
  const other = value.length - ascii;
  return Math.max(1, Math.ceil(ascii / 4 + other * 1.1));
}

function estimateTextCost(usage = {}, prices = {}) {
  const inputPrice = Number(prices.inputPricePerMillion);
  const outputPrice = Number(prices.outputPricePerMillion);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  if (inputPrice < 0 || outputPrice < 0) return null;
  if (inputPrice === 0 && outputPrice === 0) return null;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  return money((inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice);
}

function pureamImageCost(referenceCount = 0) {
  return money(0.1 * (1 + Math.max(0, tokenCount(referenceCount))));
}

/** Official PureAM Qingbo (Grok/Gemini) and Seedance cloud rate: ¥0.15 per billed second. */
function pureamVideoCostPerSecond(durationSeconds = 0) {
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  return money(0.15 * seconds);
}

const qingboVideoCost = pureamVideoCostPerSecond;
const seedanceVideoCost = pureamVideoCostPerSecond;

function backfillProjectCosts(project = {}) {
  const ledger = normalizeCostLedger(project.costLedger);
  const byKey = new Map(ledger.entries.map(entry => [entry.sourceKey, entry]));
  const jobs = Array.isArray(project.jobs) ? project.jobs : [];
  for (const job of jobs) {
    if (!["shot_video", "character_video"].includes(job?.type)) continue;
    const sourceKey = `video:${job.taskId || job.id}`;
    if (byKey.has(sourceKey)) continue;
    const providerKind = job.providerKind || "local-xiangsu";
    const duration = Number(job.duration) || 5;
    const estimate = ["puream-grok", "puream-gemini", "puream-seedance"].includes(providerKind)
      ? pureamVideoCostPerSecond(duration)
      : null;
    const entry = normalizeCostEntry({
      sourceKey,
      category: "video",
      operation: `视频生成 · ${job.type}`,
      provider: providerKind,
      model: job.model || providerKind,
      status: providerKind === "local-xiangsu" ? "not_charged" : estimate !== null ? "estimated" : "unpriced",
      amountYuan: providerKind === "local-xiangsu" ? 0 : estimate,
      pricingBasis: providerKind === "local-xiangsu" ? "本地像塑未返回人民币结算" : "历史任务回填估算",
      durationSeconds: duration,
      taskId: job.taskId || "",
      jobId: job.id || "",
      entityType: job.entityType || "",
      entityId: job.entityId || ""
    });
    ledger.entries.push(entry);
    byKey.set(sourceKey, entry);
  }
  return normalizeCostLedger(ledger);
}

module.exports = {
  COST_CATEGORIES,
  backfillProjectCosts,
  defaultCostLedger,
  estimateTextCost,
  estimateTextTokens,
  money,
  normalizeCostEntry,
  normalizeCostLedger,
  pureamImageCost,
  pureamVideoCostPerSecond,
  qingboVideoCost,
  seedanceVideoCost,
  summarizeCostEntries
};
