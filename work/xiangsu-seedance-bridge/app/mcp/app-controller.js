"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { generateText, listTextProviderEvents } = require("../ai-provider");
const { AI_GENERATION_TIMEOUT_FLOOR_MS, generationRequestTimeoutMs } = require("../bridge-client");
const { sanitizePublicMessage } = require("../public-error");

const BILLABLE_ACTIONS = new Set([
  "generate_topics",
  "analyze_script",
  "generate_complete_script",
  "adapt_reference_script",
  "prepare_prompt_review",
  "test_text_provider",
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

// T01: large results are persisted COMPLETELY first (temp file + atomic rename
// + hash verification); the returned reference is generated only after the
// artifact is durable on disk. A storage failure can never report
// resultComplete=true, so no caller mistakes a lost result for a saved one.
function writeOperationArtifact(dir, artifactId, text) {
  const artifactDir = path.join(dir, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  const target = path.join(artifactDir, `${artifactId}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, target);
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");
  const verified = crypto.createHash("sha256").update(fs.readFileSync(target, "utf8")).digest("hex");
  if (verified !== sha256) throw Object.assign(new Error("artifact hash verification failed"), { code: "MCP_ARTIFACT_HASH_MISMATCH" });
  return { artifactRef: `operation-result:${artifactId}`, sha256, byteLength: Buffer.byteLength(text) };
}

const SAFE_RESULT_INLINE_LIMIT = 120_000;
const SAFE_RESULT_PREVIEW_BYTES = 24_000;
function safeResult(value, artifactStore = null) {
  if (value === undefined) return null;
  let text;
  try { text = JSON.stringify(value); } catch { return { summary: String(value) }; }
  if (text.length <= SAFE_RESULT_INLINE_LIMIT) {
    try { return JSON.parse(text); } catch { return { summary: String(value) }; }
  }
  const base = {
    truncated: true,
    byteLength: Buffer.byteLength(text),
    preview: text.slice(0, SAFE_RESULT_PREVIEW_BYTES),
    previewTruncated: true
  };
  if (!artifactStore) return { ...base, resultComplete: false };
  try {
    const saved = writeOperationArtifact(artifactStore.dir, artifactStore.id, text);
    return { ...base, resultComplete: true, artifactRef: saved.artifactRef, sha256: saved.sha256, readMethod: "read_operation_result" };
  } catch (error) {
    return { ...base, resultComplete: false, artifactError: String(error?.code || "MCP_ARTIFACT_WRITE_FAILED") };
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
    this.importProductionPackagePath = options.importProductionPackagePath;
    this.textGenerator = typeof options.textGenerator === "function" ? options.textGenerator : generateText;
    this.operations = new Map();
    this.operationOwner = crypto.randomUUID();
    this.operationDirectory = this.store?.rootDir ? path.join(this.store.rootDir, "mcp-operations") : "";
    this.operationRecoveryIssues = [];
    this.restoreOperations();
    this.agentStoreForScope = options.agentStoreForScope || (() => this.store);
    this.startedAt = new Date().toISOString();
  }

  persistOperation(record) {
    if (!this.operationDirectory) return;
    fs.mkdirSync(this.operationDirectory, { recursive: true });
    const target = path.join(this.operationDirectory, `${record.operationId}.json`);
    const temp = `${target}.${this.operationOwner}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), "utf8");
    fs.renameSync(temp, target);
  }

  restoreOperations() {
    if (!this.operationDirectory || !fs.existsSync(this.operationDirectory)) return;
    for (const name of fs.readdirSync(this.operationDirectory)) {
      if (!/^mcpop_[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.operationDirectory, name), "utf8"));
        if (`${record.operationId}.json` !== name) throw new Error("Operation identity mismatch");
        if (["running", "queued", "pending"].includes(record.status)) {
          // A promise owned by the previous controller cannot survive a restart.
          // Keep its identity and checkpoint; never replay billable work here.
          Object.assign(record, { status: "interrupted", errorCode: "MCP_OPERATION_INTERRUPTED", recoverable: true,
            updatedAt: new Date().toISOString(), message: "应用已重启；原任务记录与项目断点已保留，请从项目当前进度继续。" });
        }
        this.operations.set(record.operationId, record);
      } catch (error) {
        this.operationRecoveryIssues.push({ file: name, code: "MCP_OPERATION_RECORD_UNREADABLE" });
      }
    }
  }

  saveOperationOutcome(record) {
    try { this.persistOperation(record); }
    catch (error) {
      // Storage failure must not turn a successfully generated artifact into
      // failed work and cause the caller to regenerate it.
      record.persistenceError = String(error?.code || "MCP_OPERATION_PERSIST_FAILED");
    }
  }

  operationRecord(operationId) {
    const record = this.operations.get(String(operationId || ""));
    if (!record) throw Object.assign(new Error("MCP 后台操作不存在"), { code: "MCP_OPERATION_NOT_FOUND" });
    return { ...record };
  }

  safeOperationResult(record, result) {
    return safeResult(result, this.operationDirectory ? { dir: this.operationDirectory, id: record.operationId } : null);
  }

  // Paginated, hash-verified read of a persisted large operation result. The
  // artifact_ref is opaque and only resolves through the operation registry —
  // caller-supplied file paths are never opened.
  readOperationResult(input) {
    if (!this.operationDirectory) throw Object.assign(new Error("当前工作区不支持结果文件读取"), { code: "MCP_OPERATION_ARTIFACT_UNAVAILABLE" });
    const record = this.operationRecord(requireText(input.operation_id, "operation_id"));
    const artifactRef = requireText(input.artifact_ref, "artifact_ref");
    if (artifactRef !== `operation-result:${record.operationId}`) {
      throw Object.assign(new Error("结果引用与操作不匹配"), { code: "MCP_OPERATION_ARTIFACT_NOT_FOUND" });
    }
    const file = path.join(this.operationDirectory, "artifacts", `${record.operationId}.json`);
    if (!fs.existsSync(file)) throw Object.assign(new Error("结果文件不存在"), { code: "MCP_OPERATION_ARTIFACT_NOT_FOUND" });
    const text = fs.readFileSync(file, "utf8");
    const sha256 = crypto.createHash("sha256").update(text).digest("hex");
    if (record.result?.sha256 && record.result.sha256 !== sha256) {
      throw Object.assign(new Error("结果文件校验失败：内容与登记哈希不一致"), { code: "MCP_ARTIFACT_HASH_MISMATCH" });
    }
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const length = Math.min(24_000, Math.max(1, Math.floor(Number(input.length) || 12_000)));
    const end = Math.min(text.length, offset + length);
    return {
      ok: true,
      artifactRef,
      sha256,
      totalBytes: Buffer.byteLength(text),
      totalCharacters: text.length,
      offset,
      nextOffset: end < text.length ? end : null,
      chunk: text.slice(offset, end)
    };
  }

  startOperation(action, projectId, runner, params = {}) {
    if (BILLABLE_ACTIONS.has(action) && params.confirm_billable !== true) {
      throw Object.assign(new Error("该操作可能调用付费模型；请显式传入 confirm_billable=true"), { code: "MCP_BILLABLE_CONFIRMATION_REQUIRED" });
    }
    const operationId = `mcpop_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const record = {
      operationId,
      owner: this.operationOwner,
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
    // Register durably before starting anything billable.
    this.persistOperation(record);
    this.operations.set(operationId, record);
    Promise.resolve()
      .then(runner)
      .then(result => {
        Object.assign(record, {
          status: "completed",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          message: "操作完成",
          result: this.safeOperationResult(record, result)
        });
        this.saveOperationOutcome(record);
      })
      .catch(error => {
        Object.assign(record, {
          status: error?.code === "LOCAL_MEDIA_CANCELLED" ? "cancelled" : ["SCRIPT_GENERATION_PAUSED", "SCRIPT_GENERATION_STOPPED"].includes(String(error?.code || "")) ? "controlled" : "failed",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errorCode: String(error?.code || "OPERATION_FAILED"),
          message: sanitizePublicMessage(error?.message || String(error) || "操作失败", error?.code),
          result: null
        });
        this.saveOperationOutcome(record);
      });
    return { ...record };
  }

  project(projectId) {
    return this.projectView(requireText(projectId, "project_id"));
  }

  async dispatch(method, params = {}) {
    const input = params && typeof params === "object" ? params : {};
    if (["list_local_agents", "list_agent_jobs", "register_agent_worker", "claim_agent_job", "complete_agent_job", "submit_agent_job_data", "report_agent_progress", "cancel_agent_job"].includes(method)) {
      const { getHub } = require("../local-agent-runtime");
      const store = this.agentStoreForScope(input.scope || "workbench");
      const hub = getHub(path.join(store.rootDir, "agent-jobs"));
      if (method === "list_local_agents") return { ok: true, agents: await hub.discover(store.getSettings().localAgents) };
      if (method === "list_agent_jobs") return { ok: true, jobs: hub.list().filter(job => !input.agentId || job.agentId === input.agentId) };
      if (method === "register_agent_worker") return { ok: true, worker: hub.register(input) };
      if (method === "claim_agent_job") return { ok: true, ...hub.claim(input) };
      if (method === "complete_agent_job" || method === "submit_agent_job_data") return hub.complete(input);
      if (method === "report_agent_progress") return hub.progress(input);
      return hub.cancel(input.jobId);
    }
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
    if (method === "get_project") {
      const project = this.project(input.project_id);
      if (!Array.isArray(input.fields) || !input.fields.length) return { ok: true, project };
      const fields = [...new Set(input.fields.map(String))];
      if (fields.some(key => !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !Object.hasOwn(project,key))) {
        throw Object.assign(new Error("fields 必须是项目现有的顶层字段"),{code:"MCP_PROJECT_FIELD_INVALID"});
      }
      const offset = Math.max(0,Math.floor(Number(input.offset)||0));
      const limit = Math.max(1,Math.min(100,Math.floor(Number(input.limit)||20)));
      const selected = {id:project.id,title:project.title}, pagination={};
      for (const key of fields) {
        const value=project[key];
        selected[key]=Array.isArray(value)?value.slice(offset,offset+limit):value;
        if(Array.isArray(value))pagination[key]={offset,limit,total:value.length,nextOffset:offset+limit<value.length?offset+limit:null};
      }
      return {ok:true,project:selected,selection:{fields,pagination,completeProject:false}};
    }
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
      return { ok: true, operations: [...this.operations.values()].filter(item => !projectId || item.projectId === projectId).map(item => ({ ...item })), recoveryIssues: this.operationRecoveryIssues };
    }
    if (method === "get_text_provider_events") return { ok: true, events: listTextProviderEvents(input.limit) };
    if (method === "get_operation") return { ok: true, operation: this.operationRecord(input.operation_id) };
    if (method === "read_operation_result") return this.readOperationResult(input);
    if (method === "list_reusable_assets") return { ok: true, assets: this.store.listReusableAssets(String(input.kind || "")) };
    if (method === "list_archived_projects") return { ok: true, projects: this.store.listDeletedProjects() };
    if (method === "test_text_provider") {
      const config = this.store.getSettings()?.textProvider || {};
      const requestedTimeoutMs = generationRequestTimeoutMs(input.timeout_ms);
      const reply = await this.textGenerator(config, [{ role: "user", content: "只回复：连接成功" }], {
        timeoutMs: requestedTimeoutMs || AI_GENERATION_TIMEOUT_FLOOR_MS,
        maxTokens: 64,
        // Two total attempts gives one bounded recovery. Provider adapters
        // still refuse replay after partial text, completion or a receipt.
        maxReconnectAttempts: 2,
        forceStream: input.force_stream === true
      });
      return { ok: true, provider: String(config.kind || ""), model: String(config.model || ""), reply: String(reply || "").slice(0, 100) };
    }

    if (method === "create_project") {
      const project = this.store.createProject(requireText(input.title, "title"), input.options || {});
      return { ok: true, project: this.projectView(project.id) };
    }
    if (method === "update_project") {
      const projectId = requireText(input.project_id, "project_id");
      const existing=this.store.getProject(projectId);
      if(input.expected_updated_at&&input.expected_updated_at!==existing.updatedAt)throw Object.assign(new Error('项目已更新，请读取最新项目后合并修改。'),{code:'MCP_PROJECT_REVISION_CONFLICT'});
      if(this.workflow.hasActiveOperation?.(projectId)||this.store.listActiveVideoJobs(projectId).length)throw Object.assign(new Error('项目正在执行；请通过已领取任务回传结果，避免覆盖运行中的数据。'),{code:'MCP_PROJECT_BUSY'});
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
    if(method==='import_production_package_path'){
      const filePath=requireExistingPath(input.file_path,'file_path');
      if(typeof this.importProductionPackagePath!=='function')throw Object.assign(new Error('当前工作区不支持资产包导入'),{code:'MCP_PACKAGE_IMPORT_UNAVAILABLE'});
      // The same complete importer as the UI owns all validation and writes.
      // Return its compact receipt, never a huge project history over stdio.
      return {ok:true,...await this.importProductionPackagePath(filePath)};
    }
    if (method === "confirm_candidate") {
      return { ok: true, candidate: this.store.confirmCandidate(requireText(input.project_id, "project_id"), requireText(input.candidate_id, "candidate_id"), input.discard_others !== false) };
    }
    if (method === "confirm_all_prompt_review") {
      return {
        ok: true,
        project: await this.workflow.confirmAllPromptReview(
          requireText(input.project_id, "project_id"),
          Array.isArray(input.entries) ? input.entries : []
        )
      };
    }
    if (method === "apply_script_adaptation") {
      return { ok: true, project: this.workflow.applyScriptAdaptation(
        requireText(input.project_id, "project_id"), requireText(input.draft_id, "draft_id"), input.accept_warnings === true) };
    }
    if (method === "bind_reusable_asset") {
      return { ok: true, candidate: this.store.bindReusableAsset(requireText(input.project_id, "project_id"), requireText(input.entity_type, "entity_type"), requireText(input.entity_id, "entity_id"), requireText(input.asset_id, "asset_id")) };
    }
    if (method === "pause_pipeline" || method === "stop_pipeline") {
      return { ok: true, automation: this.workflow.pausePipeline(requireText(input.project_id, "project_id"), method === "stop_pipeline" ? "stop" : "pause") };
    }
    if (method === "cancel_post_production") {
      return { ok: true, result: this.workflow.cancelPostProduction(requireText(input.project_id, "project_id")) };
    }

    const projectId = requireText(input.project_id, "project_id");
    const runners = {
      generate_topics: () => this.workflow.generateTopicOptions(projectId),
      analyze_script: () => this.workflow.analyzeScript(projectId),
      generate_complete_script: () => this.workflow.generateCompleteScript(projectId),
      adapt_reference_script: async () => {
        const draft = await this.workflow.adaptReferenceScript(projectId, requireText(input.source_text, "source_text"), String(input.instructions || ""));
        return { draftId: draft.id, audit: draft.audit, warnings: draft.contract?.warnings || [], textLength: String(draft.text || '').length };
      },
      // Compiles the complete asset, storyboard and video prompt bundle only.
      // It never submits image/video generation jobs.
      prepare_prompt_review: () => this.workflow.runTrackedOperation(projectId, 'prepare_prompt_review', '', () => this.workflow.preparePromptReviewBundle(projectId, { autoApprove: false, requireCompleteDelivery:true })),
      // These three methods are the local-control equivalents of the already
      // reviewed UI buttons. Re-running prompt preparation here used to reset a
      // production-package review to pending and made a confirmed package look
      // unapproved. Keep the reviewed bundle immutable at the generation edge.
      generate_all_assets: () => this.workflow.generateAllAssets(projectId, { promptPrepared: true }),
      generate_all_storyboards: () => this.workflow.generateAllStoryboards(projectId, { promptPrepared: true }),
      generate_all_videos: () => this.workflow.generateAllShotVideos(projectId, { promptPrepared: true }),
      run_full_pipeline: () => this.workflow.runFullPipeline(projectId),
      run_pipeline_from_stage: () => this.workflow.runPipelineFromStage(projectId, String(input.from_stage || "assets")),
      audit_media_quality: () => this.workflow.auditProjectMediaQuality(projectId),
      audit_actual_media: () => this.workflow.auditActualMedia(projectId, { shotIds:input.shot_ids,python:input.python_path,model:input.asr_model_path,device:input.asr_device||'cpu',evidencePython:input.evidence_python_path,audioModel:input.audio_model_path,activeSpeakerRepo:input.active_speaker_repo_path }),
      repair_media_quality: () => this.workflow.repairFailedMedia(projectId),
      stitch_final_video: () => this.workflow.stitchProject(projectId, { executionPath: "mcp_local_agent" }),
      export_jianying_draft: () => this.workflow.exportJianyingDraft(projectId, { draftRoot: input.draft_root || "" }),
      generate_character_video: () => this.workflow.generateCharacterVideo(projectId, requireText(input.character_id, "character_id"), String(input.prompt || "")),
      // A single-shot MCP action is the exact equivalent of the reviewed UI
      // draw button. Never rebuild the review bundle here: doing so resets an
      // approved production-package contract to `ready` before the submit.
      generate_shot_video: () => this.workflow.generateShotVideo(
        projectId,
        requireText(input.shot_id, "shot_id"),
        String(input.mode || ""),
        { promptPrepared: true,exactlyOnce:input.single_submission===true,rerollNonce:String(input.reroll_nonce||'') }
      )
    };
    const runner = runners[method];
    if (!runner) throw Object.assign(new Error(`不支持的 MCP 控制方法：${method}`), { code: "MCP_METHOD_NOT_FOUND" });
    return { ok: true, operation: this.startOperation(method, projectId, runner, input) };
  }
}

module.exports = { McpAppController, BILLABLE_ACTIONS, publicLicenseSnapshot, safeResult, writeOperationArtifact, SAFE_RESULT_INLINE_LIMIT };
