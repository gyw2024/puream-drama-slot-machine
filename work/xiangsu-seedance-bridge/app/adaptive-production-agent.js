"use strict";

function normalizeCommerceShotCount(value, fallback = 3) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return Math.max(1, Math.round(Number(fallback) || 3));
  return Math.min(999, parsed);
}

function resolveCommercePlan(totalShots, requestedCount = 3, hasProduct = true) {
  const total = Math.max(0, Math.round(Number(totalShots) || 0));
  if (!hasProduct || !total) return { requestedCount: 0, count: 0, startNumber: 0, endNumber: total, shots: [] };
  const requested = normalizeCommerceShotCount(requestedCount);
  // “后半段带货” is an invariant. Excess input is safely clamped to the
  // available latter half instead of rejecting the project.
  const latterHalfCapacity = Math.max(1, total - Math.floor(total / 2));
  const count = Math.min(requested, latterHalfCapacity);
  const startNumber = total - count + 1;
  const shots = Array.from({ length: count }, (_item, index) => {
    const number = startNumber + index;
    const progress = count <= 1 ? 1 : index / (count - 1);
    const role = index === 0
      ? "need_and_entry"
      : index === count - 1
        ? "decision_and_close"
        : progress < 0.45
          ? "detail_and_use"
          : progress < 0.8
            ? "proof_and_objection"
            : "result_and_reaction";
    return { number, role, richness: Number((0.55 + progress * 0.45).toFixed(2)) };
  });
  return { requestedCount: requested, count, startNumber, endNumber: total, shots };
}

function commercePlanDirective(totalShots, requestedCount, productName = "") {
  const plan = resolveCommercePlan(totalShots, requestedCount, Boolean(String(productName || "").trim()));
  if (!plan.count) return "本项目没有已绑定商品，不得虚构或硬塞商品镜头。";
  const assignments = plan.shots.map(item => `S${String(item.number).padStart(2, "0")}=${item.role}`).join("；");
  return `用户指定后半段带货讲解镜头=${plan.requestedCount}；当前总镜数可用${plan.count}镜，严格分配S${String(plan.startNumber).padStart(2, "0")}-S${String(plan.endNumber).padStart(2, "0")}。${assignments}。镜头数越高，信息应递进增加商品细节、真实使用、客观证据、异议回应和人物决定，禁止复制同一句口播或改变主线故事。商品只能取用户上传的“${productName}”信息与图片。`;
}

function candidateIsHumanAccepted(candidate) {
  return candidate?.manualSelectionOverride === true
    || candidate?.qualityAudit?.accepted === true
    || candidate?.qualityAudit?.overridden === true
    || ["manual", "human_override", "advisory_continue"].includes(String(candidate?.qualityAudit?.mode || ""));
}

function nextProductionStage(project = {}) {
  if (!String(project?.script?.raw || "").trim() || !(project?.shots || []).length) return "script";
  const activeRevision = String(project.productionRevision || "");
  const selected = (project.candidates || []).filter(item => item.filePath && (item.productionRevision || "") === activeRevision && (item.selected || candidateIsHumanAccepted(item)));
  const has = (entityType, entityId, stage) => selected.some(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage);
  if ((project.characters || []).some(item => !has("character", item.id, "character_sheet") && !has("character", item.id, "character_three_view"))) return "assets";
  if ((project.scenes || []).some(item => !has("scene", item.id, "scene_asset"))) return "assets";
  if ((project.shots || []).some(item => !["storyboard_start", "storyboard_end", "storyboard_sheet"].some(stage => has("shot", item.id, stage)))) return "shots";
  if ((project.shots || []).some(item => !has("shot", item.id, "shot_video"))) return "videos";
  return "final";
}

class AdaptiveProductionAgent {
  constructor() {
    this.adapters = new Map();
    this.skills = new Map();
  }

  registerAdapter(capability, platform, handler) {
    if (typeof handler !== "function") throw new TypeError("adapter handler must be a function");
    const key = `${String(capability || "").trim()}:${String(platform || "default").trim()}`;
    if (!key.split(":")[0]) throw new TypeError("adapter capability is required");
    this.adapters.set(key, handler);
    return this;
  }

  hasAdapter(capability, platform = "default") {
    return this.adapters.has(`${capability}:${platform}`) || this.adapters.has(`${capability}:default`);
  }

  async execute(capability, platform, payload, context = {}) {
    const handler = this.adapters.get(`${capability}:${platform}`) || this.adapters.get(`${capability}:default`);
    if (!handler) throw Object.assign(new Error(`未配置 ${capability}/${platform} 平台适配器`), { code: "AGENT_ADAPTER_NOT_CONFIGURED" });
    return handler(payload, context);
  }

  registerSkill(name, definition) {
    const key = String(name || "").trim();
    if (!key) throw new TypeError("agent skill name is required");
    const source = typeof definition === "function" ? { run: definition } : { ...(definition || {}) };
    if (typeof source.run !== "function" && !String(source.capability || "").trim()) {
      throw new TypeError("agent skill needs run or capability");
    }
    this.skills.set(key, {
      ...source,
      maxAttempts: Math.max(1, Math.min(5, Math.round(Number(source.maxAttempts) || 1)))
    });
    return this;
  }

  hasSkill(name) {
    return this.skills.has(String(name || "").trim());
  }

  async runSkill(name, payload, context = {}) {
    const key = String(name || "").trim();
    const skill = this.skills.get(key);
    if (!skill) throw Object.assign(new Error(`未注册 Agent Skill：${key}`), { code: "AGENT_SKILL_NOT_CONFIGURED", skill: key });
    const trace = [];
    let currentPayload = payload;
    let lastError = null;
    for (let attempt = 1; attempt <= skill.maxAttempts; attempt += 1) {
      try {
        const platform = typeof skill.platform === "function"
          ? skill.platform(currentPayload, context)
          : (skill.platform || currentPayload?.platform || "default");
        const result = typeof skill.run === "function"
          ? await skill.run(currentPayload, { ...context, attempt, skill: key, agent: this })
          : await this.execute(skill.capability, platform, currentPayload, { ...context, attempt, skill: key });
        if (typeof skill.validate === "function") {
          const verdict = await skill.validate(result, currentPayload, { ...context, attempt, skill: key });
          if (verdict !== true && verdict !== undefined) {
            const details = Array.isArray(verdict) ? verdict : [verdict || "skill validation failed"];
            throw Object.assign(new Error(details.map(String).join("; ")), { code: "AGENT_SKILL_VALIDATION_FAILED", details });
          }
        }
        trace.push({ attempt, status: "completed" });
        return result;
      } catch (error) {
        lastError = error;
        trace.push({ attempt, status: "failed", code: String(error?.code || "AGENT_SKILL_ATTEMPT_FAILED"), message: String(error?.message || error) });
        if (attempt >= skill.maxAttempts) break;
        if (typeof skill.repairPayload === "function") {
          currentPayload = await skill.repairPayload(currentPayload, error, { ...context, attempt, skill: key, trace: [...trace] });
        }
      }
    }
    throw Object.assign(new Error(`Agent Skill ${key} 执行失败：${lastError?.message || "unknown error"}`), {
      code: "AGENT_SKILL_FAILED",
      skill: key,
      trace,
      cause: lastError
    });
  }

  plan(project = {}) {
    return {
      nextStage: nextProductionStage(project),
      commerce: resolveCommercePlan(
        (project.shots || []).length,
        project.productionPlan?.commerceShotCount,
        Boolean(String(project.product?.name || "").trim())
      )
    };
  }
}

module.exports = {
  AdaptiveProductionAgent,
  candidateIsHumanAccepted,
  commercePlanDirective,
  nextProductionStage,
  normalizeCommerceShotCount,
  resolveCommercePlan
};
