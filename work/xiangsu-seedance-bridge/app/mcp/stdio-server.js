"use strict";

const { McpServer } = require("@modelcontextprotocol/server");
const { serveStdio } = require("@modelcontextprotocol/server/stdio");
const { z } = require("zod");
const { invokeApp } = require("./control-client");

const projectId = z.string().min(1).describe("纯梦短剧项目 ID");
const billableConfirm = z.literal(true).describe("确认本工具可能调用付费模型并产生费用");

function jsonToolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === "object" ? value : { value }
  };
}

function errorToolResult(error) {
  const payload = { ok: false, code: String(error?.code || "MCP_TOOL_FAILED"), message: String(error?.message || error || "工具执行失败") };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function registerAppTool(server, name, config, method = name) {
  server.registerTool(name, config, async input => {
    try { return jsonToolResult(await invokeApp(method, input || {})); }
    catch (error) { return errorToolResult(error); }
  });
}

function readOnlyAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function mutationAnnotations({ destructive = false, idempotent = false, openWorld = false } = {}) {
  return { readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld };
}

function registerTools(server) {
  const agentId = z.enum(["workbuddy", "antigravity", "codex", "deepseek-harness", "grokbuild"]);
  const agentScope = z.enum(["workbench", "simple"]).default("workbench");
  registerAppTool(server,'submit_agent_job_data',{title:'通过 MCP 保存阶段数据',description:'Agent 直接提交已组织的数据，软件保存并返回回执；needs_revision 时在同一任务修正后再次提交，不能把聊天正文作为已保存结果。',inputSchema:z.object({scope:agentScope,jobId:z.string(),workerId:z.string(),claimToken:z.string(),data:z.unknown()}),annotations:mutationAnnotations({idempotent:true})});
  registerAppTool(server, "list_local_agents", { title: "本地 Agent 能力", description: "读取写作/生图工作端状态；已发现不等于已登录或已生图验收。", inputSchema: z.object({ scope: agentScope }), annotations: readOnlyAnnotations() });
  registerAppTool(server, "register_agent_worker", { title: "登记 Agent 工作端及心跳", description: "以当前软件身份登记写作/生图能力；每60秒再次登记保持在线。image=true 必须有真实可调用的生图工具，不能把看图当生图。不得伪造另一个软件身份。", inputSchema: z.object({ scope:agentScope, agentId, workerId:z.string().min(1).max(80), capabilities:z.object({text:z.boolean().default(true),image:z.boolean().default(false),imageTool:z.string().max(100).optional()}) }), annotations: mutationAnnotations({idempotent:true}) });
  registerAppTool(server, "list_agent_jobs", { title: "读取待领取写作或生图任务", description: "只列状态与归属，不启动模型。仅领取用户已在短剧应用授权提交的任务；等待期间可用当前 Agent 自身等待机制，不创建循环付费请求。", inputSchema:z.object({scope:agentScope,agentId:agentId.optional()}),annotations:readOnlyAnnotations() });
  registerAppTool(server, "claim_agent_job", { title:"领取单个 Agent 任务",description:"原子领取任务并获得完整提示词与本地输出目录；同一任务只允许一个工作端领取。严格按 request.messages 各角色与 constraints 执行，不改写上游模板。",inputSchema:z.object({scope:agentScope,jobId:z.string(),workerId:z.string()}),annotations:mutationAnnotations() });
  registerAppTool(server, "report_agent_progress", {title:"回传阶段进度",description:"用领取令牌及递增sequence回传当前进度。软件同步界面；重复或乱序消息忽略。完成内容仍用complete_agent_job提交校验，不能自行批准生成。",inputSchema:z.object({scope:agentScope,jobId:z.string(),workerId:z.string(),claimToken:z.string(),sequence:z.number().int().positive(),phase:z.enum(["waiting","thinking","output","tool","saving"]).optional().describe("当前真实阶段：等待、思考、输出、工具或保存；不能根据配置强度猜测"),message:z.string().min(1).max(1500)}),annotations:mutationAnnotations({idempotent:true})});
  registerAppTool(server, "complete_agent_job", { title:"交付 Agent 文本或图片",description:"使用领取所得 claimToken 交付完整文本，或任务目录内真实生成的 PNG/JPEG/WebP 图片及工具来源。禁止占位图、旧图冒充生成、编造路径；业务校验由应用继续执行。",inputSchema:z.object({scope:agentScope,jobId:z.string(),workerId:z.string(),claimToken:z.string(),text:z.string().max(8*1024*1024).optional(),imagePath:z.string().optional(),imageTool:z.string().optional(),error:z.string().optional()}),annotations:mutationAnnotations() });
  registerAppTool(server, "cancel_agent_job", { title:"取消 Agent 任务",description:"取消本地等待或执行，拒绝迟到结果；外部工作端应停止相应任务，不自动换供应商。",inputSchema:z.object({scope:agentScope,jobId:z.string()}),annotations:mutationAnnotations({idempotent:true}) });
  registerAppTool(server, "app_status", {
    title: "读取应用状态",
    description: "读取纯梦短剧老虎机版本、运行状态、数据位置、项目数和后台授权并发额度；不返回令牌或密钥。",
    inputSchema: z.object({}), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "list_projects", {
    title: "列出短剧项目", description: "列出所有未归档项目及其当前状态。",
    inputSchema: z.object({}), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "get_project", {
    title: "读取项目或指定字段", description: "读取剧本、角色、场景、分镜、资产候选和生产状态。大项目请用 fields 选择顶层字段；数组按 offset/limit 分页并返回总数与下一页，避免将所有提示词历史一次传回。省略 fields 保持完整项目兼容。",
    inputSchema: z.object({ project_id: projectId,fields:z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).min(1).max(50).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional() }), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "get_production_status", {
    title: "读取生产进度", description: "读取六阶段状态、逐项进度、后台视频任务与最终成片状态。",
    inputSchema: z.object({ project_id: projectId }), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "get_cost_ledger", {
    title: "读取计费明细", description: "分别读取实际已结算、等待官网回执和本地预估；预估不会伪装成实扣。",
    inputSchema: z.object({ project_id: projectId }), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "list_operations", {
    title: "列出 MCP 后台操作", description: "列出由 MCP 发起且由桌面应用持续托管的操作。",
    inputSchema: z.object({ project_id: z.string().optional() }), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "get_operation", {
    title: "读取 MCP 操作", description: "按 operation_id 查询后台操作结果或错误。",
    inputSchema: z.object({ operation_id: z.string().min(1) }), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "list_reusable_assets", {
    title: "列出可复用资产", description: "读取跨项目人物、场景、道具、服装、商品、图片、视频或音频资产。",
    inputSchema: z.object({ kind: z.enum(["character", "scene", "prop", "wardrobe", "product", "image", "video", "audio"]).optional() }), annotations: readOnlyAnnotations()
  });
  registerAppTool(server, "list_archived_projects", {
    title: "列出回收项目", description: "列出可恢复的已归档项目。",
    inputSchema: z.object({}), annotations: readOnlyAnnotations()
  });

  registerAppTool(server, "create_project", {
    title: "新建短剧项目", description: "新建项目，不启动任何付费生成。",
    inputSchema: z.object({ title: z.string().min(1), options: z.record(z.string(), z.unknown()).optional() }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "update_project", {
    title: "更新项目", description: "更新项目可编辑内容；应用仍负责版本失效、运行冲突和数据一致性检查。",
    inputSchema: z.object({ project_id: projectId, expected_updated_at:z.string().optional(), patch: z.record(z.string(), z.unknown()) }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "archive_project", {
    title: "归档项目", description: "把项目移动到应用回收区，可恢复；运行中的项目会拒绝归档。",
    inputSchema: z.object({ project_id: projectId, confirm_archive: z.literal(true) }), annotations: mutationAnnotations({ destructive: true })
  });
  registerAppTool(server, "restore_project", {
    title: "恢复归档项目", description: "从应用回收区恢复项目。",
    inputSchema: z.object({ archive_id: z.string().min(1) }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "import_script_text", {
    title: "导入完整剧本", description: "把完整剧本文本写入项目并触发应用自身的生产版本失效保护；不会立即调用模型。",
    inputSchema: z.object({ project_id: projectId, text: z.string().min(1).max(1_500_000) }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "import_product_path", {
    title: "导入商品原图", description: "从本机绝对路径导入真实商品图，不让 AI 重画商品。",
    inputSchema: z.object({ project_id: projectId, file_path: z.string().min(1) }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "import_candidate_path", {
    title: "导入资产候选", description: "从本机绝对路径向人物、场景、分镜或资产库槽位导入图片、视频或音频。",
    inputSchema: z.object({ project_id: projectId, entity_type: z.enum(["character", "scene", "shot", "library"]), entity_id: z.string().min(1), stage: z.string().min(1), file_path: z.string().min(1) }), annotations: mutationAnnotations()
  });
  registerAppTool(server,'import_production_package_path',{
    title:'导入完整生产资产包',description:'从明确的本地文件路径调用与界面相同的完整资产包校验和导入流程，创建新项目、保留原项目；不调用图片或视频生成。失败不跳过校验。',
    inputSchema:z.object({file_path:z.string().min(1)}),annotations:mutationAnnotations()
  });
  registerAppTool(server, "confirm_candidate", {
    title: "确认资产候选", description: "把候选设为当前使用版本，可选择是否淘汰同槽位其他候选。",
    inputSchema: z.object({ project_id: projectId, candidate_id: z.string().min(1), discard_others: z.boolean().optional() }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "bind_reusable_asset", {
    title: "绑定可复用资产", description: "把独立资产库的人物或场景资产绑定到当前项目对象。",
    inputSchema: z.object({ project_id: projectId, entity_type: z.enum(["character", "scene"]), entity_id: z.string().min(1), asset_id: z.string().min(1) }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "pause_pipeline", {
    title: "暂停生产", description: "安全暂停当前项目生产并保存断点。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations({ idempotent: true })
  });
  registerAppTool(server, "stop_pipeline", {
    title: "结束生产", description: "结束当前项目生产，保留已经完成的内容与历史。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations({ destructive: true, idempotent: true })
  });

  const billable = (name, title, description, extraShape = {}) => registerAppTool(server, name, {
    title,
    description: `${description} 工具立即返回 operation_id，任务由桌面应用托管；必须显式确认可能产生费用。`,
    inputSchema: z.object({ project_id: projectId, confirm_billable: billableConfirm, ...extraShape }),
    annotations: mutationAnnotations({ openWorld: true })
  });
  billable("generate_topics", "生成十个新选题", "重新生成一批不同的十个选题。");
  billable("analyze_script", "识别并拆解剧本", "识别用户剧本格式、人物、场景和完整分镜。");
  billable("generate_complete_script", "生成完整剧本", "按项目策略生成完整可制作剧本。");
  billable("generate_all_assets", "生成全部资产", "按后台图片/视频并发生成缺失的人物、场景、服装、道具和音色资产。");
  billable("generate_all_storyboards", "生成全部分镜图", "按当前模式生成缺失的逐秒合图或首尾帧。");
  billable("generate_all_videos", "生成全部分镜视频", "按真实镜头依赖和后台视频并发生成分镜视频。");
  billable("run_full_pipeline", "运行一键全流程", "从当前真实断点一直制作到最终成片。");
  billable("run_pipeline_from_stage", "从指定阶段运行", "从指定阶段执行当前阶段或后续全流程。", { from_stage: z.enum(["script", "assets", "shots", "videos", "final"]).default("assets") });
  billable("repair_media_quality", "修复音画质检问题", "定向重抽不合格媒体并复检。");
  billable("generate_character_video", "生成人物视频", "为指定角色生成人物视频。", { character_id: z.string().min(1), prompt: z.string().optional() });
  billable("generate_shot_video", "生成单镜视频", "为指定镜头生成视频。single_submission 仅约束本次调用，配合稳定 reroll_nonce 防止重试重复付费，不设置全局抽卡上限。", { shot_id: z.string().min(1), mode: z.string().optional(), single_submission:z.boolean().optional(), reroll_nonce:z.string().min(1).max(200).optional() });

  registerAppTool(server, "audit_media_quality", {
    title: "检查音画质量", description: "本地检查断声、时长和重复画面，不提交新的生成任务。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations({ idempotent: true })
  });
  registerAppTool(server, "audit_actual_media", {
    title: "实际视频画面与语音审核", description: "读取已有分镜、参考资产和本地 ASR，交给所选审核 Agent 核对；保留不确定项，不生成图片或视频。使用所选 Agent 账号额度。",
    inputSchema: z.object({ project_id: projectId, shot_ids:z.array(z.string()).optional(), python_path:z.string(), asr_model_path:z.string(), asr_device:z.enum(['cpu','cuda']).optional(), evidence_python_path:z.string().optional(), audio_model_path:z.string().optional(), active_speaker_repo_path:z.string().optional() }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "stitch_final_video", {
    title: "本地净音粗剪", description: "仅处理已有分镜，音效和字幕不烧录到视频。不新生成媒体、不扣费。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "retry_sfx_preview", {
    title: "补配音效预览", description: "仅补配待补镜头的音效并从既有净音粗剪重建含音效预览；不重剪视频、不新生成媒体、不扣费。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations()
  });
  registerAppTool(server, "export_jianying_draft", {
    title: "生成剪映草稿", description: "将已有分镜、独立音效轨道和可编辑字幕导出为本地剪映草稿；不调用生成服务。",
    inputSchema: z.object({ project_id: projectId, draft_root: z.string().optional() }), annotations: mutationAnnotations({ idempotent: true })
  });
  registerAppTool(server, "cancel_post_production", {
    title: "取消本地后期", description: "取消本项目粗剪或草稿导出，保留原文件，可重新开始。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations({ idempotent: true })
  });
}

function createMcpServer() {
  const server = new McpServer({ name: "puream-drama-workbench", version: "1.0.0" });
  registerTools(server);
  server.registerResource("应用状态", "puream://app/status", { title: "纯梦短剧老虎机状态", mimeType: "application/json" }, async uri => {
    const result = await invokeApp("app_status", {});
    return { contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
  });
  server.registerResource("项目列表", "puream://projects", { title: "短剧项目列表", mimeType: "application/json" }, async uri => {
    const result = await invokeApp("list_projects", {});
    return { contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
  });
  server.registerResource("MCP 操作", "puream://operations", { title: "MCP 后台操作", mimeType: "application/json" }, async uri => {
    const result = await invokeApp("list_operations", {});
    return { contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
  });
  server.registerPrompt("produce_short_drama", {
    title: "安全制作完整短剧",
    description: "先读取项目与费用状态，再经显式确认从真实断点制作到成片。",
    argsSchema: z.object({ project_id: projectId, start_stage: z.enum(["script", "assets", "shots", "videos", "final"]).optional() })
  }, ({ project_id: id, start_stage: stage }) => ({
    messages: [{
      role: "user",
      content: { type: "text", text: `请先调用 get_project、get_production_status 和 get_cost_ledger 检查项目 ${id}。确认剧本、人物、场景、模式和商品策略符合用户要求后，说明可能产生费用并取得用户确认；随后调用 ${stage ? "run_pipeline_from_stage" : "run_full_pipeline"}${stage ? `（from_stage=${stage}）` : ""}，使用返回的 operation_id 持续查询 get_operation 与 get_production_status，直到真实最终成片完成或出现可操作错误。不得把“本阶段完成”说成“全流程完成”。` }
    }]
  }));
  return server;
}

async function main() {
  await serveStdio(() => createMcpServer(), {
    legacy: "serve",
    onerror: error => process.stderr.write(`[puream-mcp] ${String(error?.message || error)}\n`)
  });
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[puream-mcp] ${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createMcpServer, registerTools, main };
