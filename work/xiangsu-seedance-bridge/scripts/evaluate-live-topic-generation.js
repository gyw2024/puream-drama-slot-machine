"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { invokeApp } = require("../app/mcp/control-client");
function arg(name, fallback = "") { const prefix = `--${name}=`; const value = process.argv.find(item => item.startsWith(prefix)); return value ? value.slice(prefix.length) : fallback; }
function tokens(value) { const text = String(value || "").replace(/[\s\p{P}\p{S}]/gu, ""); const out = new Set(); for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2)); return out; }
function similarity(left, right) { const a = tokens(left); const b = tokens(right); if (!a.size || !b.size) return 0; let overlap = 0; for (const token of a) if (b.has(token)) overlap += 1; return overlap / (a.size + b.size - overlap); }
function signature(topic) { return [topic.relationship, topic.storyMechanism, topic.conflictDomain, topic.hookAction || topic.hook, topic.themeObject, topic.reversalSource || topic.proofChain, topic.settlementAction || topic.emotionalPayoff].join("|"); }
const SLOT_RULES = {
  T01: "rescue_repaid", T02: "rescue_repaid", T03: "rescue_repaid",
  T04: "kindness_misjudged", T05: "kindness_misjudged", T06: "kindness_misjudged",
  T07: "sacrifice_repaid", T08: "sacrifice_repaid", T09: "evidence_reversal", T10: "evidence_reversal"
};
function actionLike(topic) { const value = String(topic.hookAction || "").trim(); return value.length >= 2 && value.length <= 8 && !/(故事总结|意义|价值|内核|[，。；])/.test(value); }
function topicFailureReasons(topic, required) {
  const reasons = [];
  const expectedMechanism = SLOT_RULES[topic.slotId];
  if (!expectedMechanism) reasons.push("slot_id_invalid");
  else if (expectedMechanism !== topic.storyMechanism) reasons.push("slot_mechanism_mismatch");
  const missing = required.filter(field => !String(topic[field] || "").trim());
  if (missing.length) reasons.push(`missing:${missing.join(",")}`);
  if (!Array.isArray(topic.highlights) || topic.highlights.length !== 3) reasons.push("highlights_not_three");
  if (!actionLike(topic)) reasons.push("hook_action_not_concrete_2_to_8_chars");

  // Judge causal completeness from dedicated fields, not a fixed Chinese keyword list.
  // Keyword matching falsely rejects original wording and rewards repeated stock phrases.
  const mechanismFields = {
    rescue_repaid: ["protagonist", "returningAgent", "kindnessCost", "reversalSource", "settlementAction"],
    kindness_misjudged: ["protagonist", "antagonist", "kindnessCost", "reversalSource", "settlementAction"],
    sacrifice_repaid: ["protagonist", "kindnessCost", "returningAgent", "reversalSource", "settlementAction"],
    evidence_reversal: ["protagonist", "antagonist", "reversalSource", "reversal", "settlementAction"]
  }[topic.storyMechanism];
  if (!mechanismFields) reasons.push("story_mechanism_invalid");
  else {
    const causalMissing = mechanismFields.filter(field => !String(topic[field] || "").trim());
    if (causalMissing.length) reasons.push(`causal_fields_missing:${causalMissing.join(",")}`);
  }
  return reasons;
}
function analyze(rounds) {
  const flat = rounds.flatMap((round, ri) => round.map((topic, ti) => ({ ...topic, round: ri + 1, position: ti + 1 })));
  const required = ["title", "slotId", "relationship", "storyMechanism", "conflictDomain", "protagonist", "antagonist", "returningAgent", "logline", "hook", "hookAction", "firstDialogue", "kindnessCost", "reversalSource", "reversal", "settlementAction", "emotionalPayoff", "productPlacement"];
  const invalid = flat.map(topic => ({ topic, reasons: topicFailureReasons(topic, required) })).filter(item => item.reasons.length);
  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const domains = rounds[roundIndex].map(item => String(item.conflictDomain || "").trim());
    if (new Set(domains).size !== domains.length) {
      for (const topic of flat.filter(item => item.round === roundIndex + 1)) {
        const existing = invalid.find(item => item.topic === topic);
        if (existing) existing.reasons.push("duplicate_conflict_domain_in_round");
        else invalid.push({ topic, reasons: ["duplicate_conflict_domain_in_round"] });
      }
    }
  }
  const titleGroups = new Map(); for (const topic of flat) { const key = String(topic.title || "").replace(/[\s《》]/g, ""); titleGroups.set(key, [...(titleGroups.get(key) || []), `${topic.round}.${topic.position}`]); }
  const repeatedTitles = [...titleGroups.entries()].filter(([, refs]) => refs.length > 1);
  const semanticPairs = [];
  for (let left = 0; left < flat.length; left += 1) for (let right = left + 1; right < flat.length; right += 1) { if (flat[left].round === flat[right].round) continue; const score = similarity(signature(flat[left]), signature(flat[right])); if (score >= 0.42) semanticPairs.push({ score: Number(score.toFixed(3)), left: `${flat[left].round}.${flat[left].position} ${flat[left].title}`, right: `${flat[right].round}.${flat[right].position} ${flat[right].title}` }); }
  const duplicateRefs = new Set(semanticPairs.flatMap(pair => [pair.left.split(" ")[0], pair.right.split(" ")[0]]));
  const failedRefs = new Set([...invalid.map(item => `${item.topic.round}.${item.topic.position}`), ...duplicateRefs]);
  return { totalTopics: flat.length, successfulRounds: rounds.length, invalidCount: invalid.length, repeatedTitles, semanticDuplicatePairs: semanticPairs.sort((a, b) => b.score - a.score), duplicateTopicCount: duplicateRefs.size, firstPassRate: flat.length ? Number((((flat.length - failedRefs.size) / flat.length) * 100).toFixed(1)) : 0, invalidTopics: invalid.map(({ topic, reasons }) => ({ round: topic.round, position: topic.position, slotId: topic.slotId, title: topic.title, reasons })), roundMetrics: rounds.map((round, index) => ({ round: index + 1, count: round.length, slots: new Set(round.map(item => item.slotId)).size, conflictDomains: new Set(round.map(item => item.conflictDomain)).size, hookActions: new Set(round.map(item => item.hookAction)).size, themeObjects: new Set(round.map(item => item.themeObject)).size, settlementActions: new Set(round.map(item => item.settlementAction)).size })) };
}
async function waitFor(operationId) { const deadline = Date.now() + 12 * 60_000; while (Date.now() < deadline) { const operation = (await invokeApp("get_operation", { operation_id: operationId })).operation; if (operation.status === "completed") return operation; if (operation.status !== "running") throw Object.assign(new Error(operation.message), { code: operation.errorCode }); await new Promise(resolve => setTimeout(resolve, 2000)); } throw new Error("Timed out waiting for live topic generation"); }
async function main() {
  const targetRounds = Math.max(1, Math.min(10, Number(arg("rounds", "5")) || 5)); let projectId = arg("project-id", "");
  if (!projectId) projectId = (await invokeApp("create_project", { title: `选题首轮准确率测试-${new Date().toISOString().slice(0, 19)}`, options: {} })).project.id;
  const outputDir = path.resolve(arg("output", path.join(process.cwd(), "outputs", "topic-evaluation"))); fs.mkdirSync(outputDir, { recursive: true }); const outputPath = path.join(outputDir, `live-evaluation-${projectId}-${Date.now()}.json`);
  const samples = []; const transportFailures = []; const operations = (await invokeApp("list_operations", { project_id: projectId })).operations || [];
  for (const operation of operations.filter(item => item.action === "generate_topics" && item.status === "completed").sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)))) { const topics = operation.result?.ideation?.topics || []; if (topics.length === 10) samples.push(topics); }
  process.stdout.write(`recovered ${samples.length} completed rounds from ${projectId}\n`); let attempts = 0;
  while (samples.length < targetRounds && attempts < targetRounds * 3) { attempts += 1; try { const started = await invokeApp("generate_topics", { project_id: projectId, confirm_billable: true }); const operation = await waitFor(started.operation.operationId); const topics = operation.result?.ideation?.topics || []; if (topics.length === 10) samples.push(topics); process.stdout.write(`round ${samples.length}/${targetRounds}: ${topics.length} topics\n`); } catch (error) { transportFailures.push({ attempt: attempts, code: error.code || "", message: error.message }); process.stdout.write(`attempt ${attempts} failed: ${error.message}\n`); } fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), appProjectId: projectId, targetRounds, attempts, transportFailures, metrics: analyze(samples), rounds: samples }, null, 2), "utf8"); }
  const report = { generatedAt: new Date().toISOString(), appProjectId: projectId, targetRounds, attempts, transportFailures, metrics: analyze(samples), rounds: samples }; fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8"); process.stdout.write(`${outputPath}\n${JSON.stringify({ transportFailures, metrics: report.metrics }, null, 2)}\n`); if (samples.length < targetRounds) process.exitCode = 2;
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
