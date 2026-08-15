"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BILLABLE_ACTIONS = new Set([
  "generate_topics",
  "analyze_script",
  "generate_complete_script",
  "generate_all_assets",
  "generate_all_storyboards",
  "generate_all_videos",
  "run_full_pipeline",
  "run_pipeline_from_stage",
  "repair_media_quality",
  "generate_character_video",
  "generate_shot_video"
]);

function publicLicenseSnapshot(snapshot = {}) {
  return {
    activated: snapshot.activated === true,
    name: String(snapshot.name || ""),
    phone: String(snapshot.phone || ""),
    imageConcurrency: Number(snapshot.imageConcurrency || 0),
    videoConcurrency: Number(snapshot.videoConcurrency || 0),
    concurrencyAuthority: String(snapshot.concurrencyAuthority || ""),
    offlineGrace: snapshot.offlineGrace === true,
    lastHeartbeatOkAt: String(snapshot.lastHeartbeatOkAt || "")
  };
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error(`${label}不能为空`), { code: "MCP_INVALID_ARGUMENT" });
  return text;
}

function requireExistingPath(value, label, expected = "file") {
  const target = path.resolve(requireText(value, label));
  if (!fs.existsSync(target)) throw Object.assign(new Error(`${label}不存在：${target}`), { code: "MCP_PATH_NOT_FOUND" });
  const stat = fs.statSync(target);
  if (expected === "file" && !stat.isFile()) throw Object.assign(new Error(`${label}必须是文件`), { code: "MCP_PATH_TYPE_INVALID" });
  return target;
}

function safeResult(value) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text.length <= 120_000) return JSON.parse(text);
    return { truncated: true, byteLength: Buffer.byteLength(text), preview: text.slice(0, 24_000) };
  } catch {
    return { summary: String(value) };
  }
}

class McpAppController {
  constructor(options = {}) {
    this.appVersion = String(options.appVersion || "");
    this.dataRoot = () => String(options.dataRoot?.() || "");
    this.store = options.store;
    this.workflow = options.workflow;
    this.license = options.license || null;
    this.projectView = typeof options.projectView === "function" ? options.projectView : projectId => this.store.getProject(projectId);
    this.importProductPath = options.importProductPath;
    this.importCandidatePath = options.importCandidatePath;
    this.operations = new Map();
    this.startedAt = new Date().toISOString();
  }

  operationRecord(operationId) {
    const record = this.operations.get(String(operationId || ""));
    if (!record) throw Object.assign(new Error("MCP 后台操作不存在"), { code: "MCP_OPERATION_NOT_FOUND" });
    return { ...record };
  }

  startOperation(action, projectId, runner, params = {}) {
    if (BILLABLE_ACTIONS.has(action) && params.confirm_billable !== true) {
      throw Object.assign(new Error("该操作可能调用付费模型；请显式传入 confirm_billable=true"), { code: "MCP_BILLABLE_CONFIRMATION_REQUIRED" });
    }
    const operationId = `mcpop_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const record = {
      operationId,
      action,
      projectId: String(projectId || ""),
      status: "running",
      startedAt,
      updatedAt: startedAt,
      completedAt: "",
      errorCode: "",
      message: "操作已由应用接管；MCP 客户端断开不会中止任务",
      result: null
    };
    this.operations.set(operationId, record);
    Promise.resolve()
      .then(runner)
      .then(result => {
        Object.assign(record, {
          status: "completed",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          message: "操作完成",
          result: safeResult(result)
        });
      })
      .catch(error => {
        Object.assign(record, {
          status: ["SCRIPT_GENERATION_PAUSED", "SCRIPT_GENERATION_STOPPED"].includes(String(error?.code || "")) ? "controlled" : "failed",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errorCode: String(error?.code || "OPERATION_FAILED"),
          message: String(error?.message || error || "操作失败"),
          result: null
        });
      });
    return { ...record };
  }

  project(projectId) {
    return this.projectView(requireText(projectId, "project_id"));
  }

  async dispatch(method, params = {}) {
    const input = params && typeof params === "object" ? params : {};
    if (method === "app_status") {
      return {
        ok: true,
        app: "纯梦短剧老虎机",
        version: this.appVersion,
        pid: process.pid,
        startedAt: this.startedAt,
        dataRoot: this.dataRoot(),
        projects: this.store.listProjects().length,
        activeProjects: this.store.listProjects().filter(item => this.workflow.hasActiveOperation(item.id) || this.store.listActiveVideoJobs(item.id).length > 0).length,
        license: publicLicenseSnapshot(this.license?.getSnapshot?.() || {})
      };
    }
    if (method === "list_projects") {
      this.workflow.reconcileDetachedAutomations();
      return { ok: true, projects: this.store.listProjects() };
    }
    if (method === "get_project") return { ok: true, project: this.project(input.project_id) };
    if (method === "get_production_status") {
      const project = this.project(input.project_id);
      return {
        ok: true,
        projectId: project.id,
        title: project.title,
        status: project.status,
        currentStage: project.currentStage,
        automation: project.automation || {},
        activeOperation: this.workflow.hasActiveOperation(project.id),
        activeVideoJobs: this.store.listActiveVideoJobs(project.id),
        finalVideoPath: project.finalVideoPath || "",
        finalVideoStale: project.finalVideoStale === true
      };
    }
    if (method === "get_cost_ledger") {
      const project = this.project(input.project_id);
      return { ok: true, projectId: project.id, costLedger: project.costLedger || { summary: {}, entries: [] } };
    }
    if (method === "list_operations") {
      const projectId = String(input.project_id || "");
      return { ok: true, operations: [...this.operations.values()].filter(item => !projectId || item.projectId === projectId).map(item => ({ ...item })) };
    }
    if (method === "get_operation") return { ok: true, operation: this.operationRecord(input.operation_id) };
    if (method === "list_reusable_assets") return { ok: true, assets: this.store.listReusableAssets(String(input.kind || "")) };
    if (method === "list_archived_projects") return { ok: true, projects: this.store.listDeletedProjects() };

    if (method === "create_project") {
      const project = this.store.createProject(requireText(input.title, "title"), input.options || {});
      return { ok: true, project: this.projectView(project.id) };
    }
    if (method === "update_project") {
      const projectId = requireText(input.project_id, "project_id");
      const requested = input.patch && typeof input.patch === "object" ? input.patch : {};
      const allowed = new Set(["title", "script", "ideation", "product", "generation", "productionPlan", "promptIntake", "characters", "scenes", "shots"]);
      const patch = Object.fromEntries(Object.entries(requested).filter(([key]) => allowed.has(key)));
      if (!Object.keys(patch).length) throw Object.assign(new Error("patch 没有可修改字段"), { code: "MCP_PATCH_EMPTY" });
      this.store.patchProject(projectId, { ...patch, activitySummary: "MCP 更新项目" });
      return { ok: true, project: this.projectView(projectId) };
    }
    if (method === "archive_project") {
      const projectId = requireText(input.project_id, "project_id");
      if (input.confirm_archive !== true) throw Object.assign(new Error("归档项目可恢复，但必须显式传入 confirm_archive=true"), { code: "MCP_ARCHIVE_CONFIRMATION_REQUIRED" });
      if (this.workflow.hasActiveOperation(projectId) || this.store.listActiveVideoJobs(projectId).length) {
        throw Object.assign(new Error("项目仍有任务运行，不能归档"), { code: "PROJECT_DELETE_ACTIVE" });
      }
      return { ok: true, archive: this.store.deleteProject(projectId) };
    }
    if (method === "restore_project") return { ok: true, project: this.store.restoreProject(requireText(input.archive_id, "archive_id")) };
    if (method === "import_script_text") {
      const projectId = requireText(input.project_id, "project_id");
      const text = requireText(input.text, "text");
      if (text.length > 1_500_000) throw Object.assign(new Error("剧本文本超过 150 万字符限制"), { code: "MCP_SCRIPT_TOO_LARGE" });
      const project = this.store.getProject(projectId);
      this.store.patchProject(projectId, {
        script: { ...(project.script || {}), raw: text, source: "mcp", importedAt: new Date().toISOString() },
        activitySummary: "通过 MCP 导入完整剧本"
      });
      return { ok: true, project: this.projectView(projectId) };
    }
    if (method === "import_product_path") {
      const projectId = requireText(input.project_id, "project_id");
      const filePath = requireExistingPath(input.file_path, "file_path");
      return { ok: true, ...(await this.importProductPath(projectId, filePath)), project: this.projectView(projectId) };
    }
    if (method === "import_candidate_path") {
      const projectId = requireText(input.project_id, "project_id");
      const filePath = requireExistingPath(input.file_path, "file_path");
      const imported = await this.importCandidatePath(projectId, requireText(input.entity_type, "entity_type"), requireText(input.entity_id, "entity_id"), requireText(input.stage, "stage"), filePath);
      return { ok: true, ...imported, project: this.projectView(projectId) };
    }
    if (method === "confirm_candidate") {
      return { ok: true, candidate: this.store.confirmCandidate(requireText(input.project_id, "project_id"), requireText(input.candidate_id, "candidate_id"), input.discard_others !== false) };
    }
    if (method === "bind_reusable_asset") {
      return { ok: true, candidate: this.store.bindReusableAsset(requireText(input.project_id, "project_id"), requireText(input.entity_type, "entity_type"), requireText(input.entity_id, "entity_id"), requireText(input.asset_id, "asset_id")) };
    }
    if (method === "pause_pipeline" || method === "stop_pipeline") {
      return { ok: true, automation: this.workflow.pausePipeline(requireText(input.project_id, "project_id"), method === "stop_pipeline" ? "stop" : "pause") };
    }

    const projectId = requireText(input.project_id, "project_id");
    const runners = {
      generate_topics: () => this.workflow.generateTopicOptions(projectId),
      analyze_script: () => this.workflow.analyzeScript(projectId),
      generate_complete_script: () => this.workflow.generateCompleteScript(projectId),
      generate_all_assets: () => this.workflow.generateAllAssets(projectId),
      generate_all_storyboards: () => this.workflow.generateAllStoryboards(projectId),
      generate_all_videos: () => this.workflow.generateAllShotVideos(projectId),
      run_full_pipeline: () => this.workflow.runFullPipeline(projectId),
      run_pipeline_from_stage: () => this.workflow.runPipelineFromStage(projectId, String(input.from_stage || "assets")),
      audit_media_quality: () => this.workflow.auditProjectMediaQuality(projectId),
      repair_media_quality: () => this.workflow.repairFailedMedia(projectId),
      stitch_final_video: () => this.workflow.stitchProject(projectId),
      generate_character_video: () => this.workflow.generateCharacterVideo(projectId, requireText(input.character_id, "character_id"), String(input.prompt || "")),
      generate_shot_video: () => this.workflow.generateShotVideo(projectId, requireText(input.shot_id, "shot_id"), String(input.mode || ""))
    };
    const runner = runners[method];
    if (!runner) throw Object.assign(new Error(`不支持的 MCP 控制方法：${method}`), { code: "MCP_METHOD_NOT_FOUND" });
    return { ok: true, operation: this.startOperation(method, projectId, runner, input) };
  }
}

module.exports = { McpAppController, BILLABLE_ACTIONS, publicLicenseSnapshot };
