'use strict';
const crypto = require('node:crypto');
const { fail, hash } = require('./contracts');

function sha256(str) {
  return crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex');
}

function compose({
  stage = '',
  roleId = '',
  baseBoundary = '',
  roleBody = '',
  policyVersion = '',
  rules = [],
  creativePolicy = [],
  providerContract = '',
  outputContract = '',
  userTemplate = '',
  userTemplatePlacement = 'user',
  task = {}
} = {}) {
  if (userTemplatePlacement && !['user', 'system'].includes(userTemplatePlacement)) {
    throw fail('TEMPLATE_PLACEMENT_INVALID', 'user/system');
  }

  const blocks = [];
  const sources = [];

  if (baseBoundary) {
    const formattedBoundary = baseBoundary.startsWith('【共同边界】')
      ? baseBoundary
      : `【共同边界】\n${baseBoundary}`;
    blocks.push(formattedBoundary);
    sources.push({
      kind: 'base-boundary',
      sha256: sha256(baseBoundary)
    });
  }

  if (roleBody) {
    blocks.push(roleBody);
    sources.push({
      kind: 'role-body',
      sha256: sha256(roleBody)
    });
  }

  const policyItems = [...(creativePolicy || []), ...(rules || [])];
  const seenRuleIds = new Map();
  const seenBodies = new Set();

  for (const r of policyItems) {
    const rId = String(r.ruleId || r.id || '');
    const rBody = String(r.body || '');
    if (rId) {
      if (seenRuleIds.has(rId)) {
        if (seenRuleIds.get(rId) !== rBody) {
          throw fail('PROMPT_RULE_CONFLICT', rId);
        }
        continue;
      }
      seenRuleIds.set(rId, rBody);
    }

    const trimmed = rBody.trim();
    if (!seenBodies.has(trimmed)) {
      seenBodies.add(trimmed);
      blocks.push(rBody);
    }

    sources.push({
      kind: 'creative-policy',
      ...(rId ? { ruleId: rId, id: rId } : {}),
      sha256: sha256(rBody)
    });
  }

  if (providerContract) blocks.push(providerContract);
  if (outputContract) blocks.push(outputContract);

  let userTemplateConflict = null;
  if (userTemplate) {
    const tTrim = userTemplate.trim();
    const duplicates = policyItems.some(p => {
      const pTrim = String(p.body || '').trim();
      return pTrim && pTrim === tTrim;
    });
    if (duplicates) {
      userTemplateConflict = 'user-template-duplicates-policy-rule';
    }
    if (userTemplatePlacement === 'system') {
      blocks.push(userTemplate);
    }
    sources.push({
      kind: 'user-template',
      sha256: sha256(userTemplate),
      preservedVerbatim: true
    });
  }

  const system = blocks.join('\n\n');
  const userPayload = {
    ...(task && typeof task === 'object' ? task : {}),
    ...(userTemplate && userTemplatePlacement === 'user' ? { userTemplate } : {})
  };
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(userPayload) }
  ];

  const userTemplateActuallySent = !userTemplate || messages.some(m =>
    m.content.includes(userTemplate) || m.content.includes(JSON.stringify(userTemplate).slice(1, -1))
  );

  return {
    messages,
    system,
    provenance: {
      version: 'compose-r2',
      stage,
      roleId,
      policyVersion,
      sources,
      userTemplatePlacement,
      userTemplateHash: userTemplate ? sha256(userTemplate) : null,
      userTemplateConflict,
      systemHash: sha256(system),
      messagesHash: hash(messages),
      systemChars: system.length,
      userTemplateActuallySent
    }
  };
}

module.exports = { compose };
