'use strict';
// T06 / §13: the single authoritative prompt composition point.
// Every real generation request must be assembled here and only here:
//   baseBoundary (P00) + roleBody + applicable creative policy (deduped by
//   ruleId) + provider contract + output contract.
// User requirements and source facts travel in the user payload — they are
// DATA and are never appended to the system prompt. Rules are deduplicated by
// ruleId: the SAME rule appears once, different rules are never merged.
// User-saved templates are kept verbatim (no regex deletion); a conflict with
// a new policy version is reported, never silently overwritten. Every
// composition returns provenance (per-source id + hash, final systemHash,
// length with a soft warning) so any real prompt can be traced to its origins
// and no policy paragraph is duplicated per stage.
const crypto = require('node:crypto');

const SOFT_LENGTH_LIMIT_CHARS = 24_000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function block(title, body) {
  const text = String(body || '').trim();
  if (!text) return '';
  return title ? `【${title}】\n${text}` : text;
}

/**
 * compose({ stage, roleId, policyVersion, baseBoundary, roleBody, creativePolicy,
 *           providerContract, outputContract, userTemplate })
 *   creativePolicy: [{ ruleId, body }] — deduped by ruleId, order preserved.
 *   userTemplate:   verbatim user-saved template text or null.
 * Returns { system, provenance } — `system` is the one and only system string
 * that may be sent to a model; `provenance` explains where every byte came from.
 */
function compose({
  stage = '',
  roleId = '',
  policyVersion = '',
  baseBoundary = '',
  roleBody = '',
  creativePolicy = [],
  providerContract = '',
  outputContract = '',
  userTemplate = null
} = {}) {
  const sources = [];
  const seenRuleIds = new Set();
  const seenBodies = new Set();
  const policyParts = [];
  for (const entry of (Array.isArray(creativePolicy) ? creativePolicy : [])) {
    const id = String(entry?.ruleId || '');
    const body = String(entry?.body || '').trim();
    if (!body) continue;
    // 去重的是相同规则：同一 ruleId 只出现一次；同一正文换 ID 也只出现一次。
    if (id && seenRuleIds.has(id)) continue;
    if (seenBodies.has(body)) continue;
    if (id) seenRuleIds.add(id);
    seenBodies.add(body);
    policyParts.push(body);
    sources.push({ kind: 'creative-policy', ruleId: id, sha256: sha256(body), chars: body.length });
  }
  const boundaryText = String(baseBoundary || '').trim();
  const roleText = String(roleBody || '').trim();
  const providerText = String(providerContract || '').trim();
  const outputText = String(outputContract || '').trim();
  if (boundaryText) sources.unshift({ kind: 'base-boundary', sha256: sha256(boundaryText), chars: boundaryText.length });
  sources.push({ kind: 'role-body', roleId: String(roleId), sha256: sha256(roleText), chars: roleText.length });
  if (providerText) sources.push({ kind: 'provider-contract', sha256: sha256(providerText), chars: providerText.length });
  if (outputText) sources.push({ kind: 'output-contract', sha256: sha256(outputText), chars: outputText.length });

  const system = [
    block('共同边界', boundaryText),
    roleText,
    policyParts.length ? block('适用创作政策', policyParts.join('\n\n')) : '',
    providerText,
    outputText
  ].filter(Boolean).join('\n\n');

  let userTemplateConflict = null;
  let userTemplateText = '';
  if (userTemplate != null && String(userTemplate).trim()) {
    userTemplateText = String(userTemplate);
    // User template is preserved verbatim elsewhere; if it duplicates policy
    // text the conflict is reported, not silently "optimized" away.
    if (seenBodies.has(userTemplateText.trim())) {
      userTemplateConflict = 'user-template-duplicates-policy-rule';
    }
    sources.push({ kind: 'user-template', sha256: sha256(userTemplateText), chars: userTemplateText.length, preservedVerbatim: true, conflict: userTemplateConflict });
  }

  const provenance = {
    stage: String(stage || ''),
    roleId: String(roleId || ''),
    policyVersion: String(policyVersion || ''),
    sources,
    systemHash: sha256(system),
    systemChars: system.length,
    softLengthExceeded: system.length > SOFT_LENGTH_LIMIT_CHARS,
    userTemplateConflict,
    composedAt: new Date().toISOString()
  };
  return { system, provenance };
}

module.exports = { compose, sha256, SOFT_LENGTH_LIMIT_CHARS };
