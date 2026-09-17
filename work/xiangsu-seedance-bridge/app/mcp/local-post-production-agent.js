"use strict";

// The desktop button deliberately uses this agent instead of reaching into the
// workflow.  Every read, start, poll and cancellation follows the same MCP
// controller contract exposed to external agents, while execution remains on
// this machine and consumes only the user's already-generated media.
class LocalPostProductionAgent {
  constructor(options = {}) {
    if (!options.controller || typeof options.controller.dispatch !== "function") {
      throw new Error("MCP controller is required for the local post-production agent");
    }
    this.controller = options.controller;
    this.pollIntervalMs = Math.max(0, Number(options.pollIntervalMs ?? 450));
    this.timeoutMs = 0;
  }

  async call(method, params) {
    const result = await this.controller.dispatch(method, params);
    if (!result?.ok) throw Object.assign(new Error(result?.message || `MCP ${method} failed`), { code: result?.code || "MCP_LOCAL_AGENT_FAILED" });
    return result;
  }

  async wait(operationId, projectId) {
    for (;;) {
      const operation = (await this.call("get_operation", { operation_id: operationId })).operation;
      const production = await this.call("get_production_status", { project_id: projectId });
      if (["completed", "cancelled", "controlled", "failed"].includes(String(operation?.status || ""))) {
        if (operation.status !== "completed") {
          throw Object.assign(new Error(operation.message || "本地后期 Agent 未完成"), { code: operation.errorCode || "MCP_LOCAL_AGENT_INCOMPLETE" });
        }
        return { operation, production, result: operation.result || null };
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async runRoughCut(projectId) {
    const input = { project_id: String(projectId || "") };
    // Read through MCP before action. This is both the Agent's project-context
    // boundary and the source of a public failure when a project has vanished.
    await this.call("get_project", input);
    await this.call("get_production_status", input);
    const started = await this.call("stitch_final_video", input);
    const operationId = String(started.operation?.operationId || "");
    if (!operationId) throw Object.assign(new Error("MCP 未返回本地粗剪任务编号"), { code: "MCP_LOCAL_AGENT_NO_OPERATION" });
    return this.wait(operationId, input.project_id);
  }

  // T14: retry only pending sfx batches; videos are never re-cut.
  async runSfxPreviewRetry(projectId) {
    const input = { project_id: String(projectId || "") };
    await this.call("get_project", input);
    await this.call("get_production_status", input);
    const started = await this.call("retry_sfx_preview", input);
    const operationId = String(started.operation?.operationId || "");
    if (!operationId) throw Object.assign(new Error("MCP 未返回音效补配任务编号"), { code: "MCP_LOCAL_AGENT_NO_OPERATION" });
    return this.wait(operationId, input.project_id);
  }

  async cancel(projectId) {
    return this.call("cancel_post_production", { project_id: String(projectId || "") });
  }
}

module.exports = { LocalPostProductionAgent };
