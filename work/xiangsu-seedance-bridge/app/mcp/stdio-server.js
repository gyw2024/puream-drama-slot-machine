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
    title: "读取完整项目", description: "读取剧本、角色、场景、分镜、资产候选和生产状态。",
    inputSchema: z.object({ project_id: projectId }), annotations: readOnlyAnnotations()
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
    inputSchema: z.object({ project_id: projectId, patch: z.record(z.string(), z.unknown()) }), annotations: mutationAnnotations()
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
  billable("generate_shot_video", "生成单镜视频", "为指定镜头生成视频。", { shot_id: z.string().min(1), mode: z.string().optional() });

  registerAppTool(server, "audit_media_quality", {
    title: "检查音画质量", description: "本地检查断声、时长和重复画面，不提交新的生成任务。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations({ idempotent: true })
  });
  registerAppTool(server, "stitch_final_video", {
    title: "拼接最终成片", description: "使用已经确认的分镜视频在本机拼接并执行交付检查，不新生成分镜视频。",
    inputSchema: z.object({ project_id: projectId }), annotations: mutationAnnotations()
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
