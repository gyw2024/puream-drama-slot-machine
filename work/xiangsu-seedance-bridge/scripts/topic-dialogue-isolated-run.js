"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { invokeApp } = require("../app/mcp/control-client");

const out = process.env.TOPIC_DIALOGUE_OUTPUT || path.resolve("outputs", "TASK-20260820-topic-dialogue");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitOperation(operationId) {
  for (let i = 0; i < 180; i += 1) {
    const op = (await invokeApp("get_operation", { operation_id: operationId })).operation;
    fs.writeFileSync(path.join(out, `operation-${operationId}.json`), JSON.stringify(op, null, 2));
    if (op.status !== "running") return op;
    await sleep(2000);
  }
  throw new Error(`timeout:${operationId}`);
}
async function runBillable(method, projectId) {
  const started = await invokeApp(method, { project_id: projectId, confirm_billable: true });
  const op = await waitOperation(started.operation.operationId);
  if (op.status !== "completed") throw Object.assign(new Error(op.message), { code: op.errorCode || "OPERATION_FAILED", operation: op });
  return op;
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const title = `隔离选题-简易对白真实后端-${Date.now()}`;
  const created = await invokeApp("create_project", { title, options: {
    engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true,
    executionMode: "step", inputMode: "ai", scriptFormat: "dialogue", scriptFormatConfirmed: true,
    commerceMode: "none", targetDurationSeconds: 60, shotDuration: 10
  }});
  const projectId = created.project.id;
  fs.writeFileSync(path.join(out, "create-project.json"), JSON.stringify({ projectId, title, dataRoot: process.env.PUREAM_MCP_DESKTOP_USER_DATA_DIR || "", providerMaxTokens: 65536 }, null, 2));
  const topicsOp = await runBillable("generate_topics", projectId);
  let project = (await invokeApp("get_project", { project_id: projectId })).project;
  fs.writeFileSync(path.join(out, "topics.json"), JSON.stringify({ operation: topicsOp, ideation: project.ideation }, null, 2));
  const topics = project.ideation?.topics || [];
  if (topics.length !== 10) throw new Error(`topic_count:${topics.length}`);
  const selected = topics[0];
  await invokeApp("update_project", { project_id: projectId, patch: { ideation: { ...(project.ideation || {}), selectedTopicId: selected.id, selectedTopic: selected } }});
  fs.writeFileSync(path.join(out, "selected-topic.json"), JSON.stringify(selected, null, 2));
  const importedProduct = await invokeApp("import_product_path", { project_id: projectId, file_path: "C:\\Users\\Administrator\\AppData\\Roaming\\xiangsu-seedance-bridge\\workbench\\reusable-asset-library\\files\\asset_mst6531s_533f15b4.png" });
  await invokeApp("update_project", { project_id: projectId, patch: { product: { ...(importedProduct.project?.product || {}), name: "舒缓护膝", description: "轻薄贴合、行动支撑，帮助中老年日常活动更稳", sellingPoints: "轻薄贴合、行动支撑、日常活动舒适" } }});
  const scriptOp = await runBillable("generate_complete_script", projectId);
  project = (await invokeApp("get_project", { project_id: projectId })).project;
  fs.writeFileSync(path.join(out, "script-stage.json"), JSON.stringify({ operation: scriptOp, script: project.script, productionPlan: project.productionPlan }, null, 2));
  const analyzeOp = await runBillable("analyze_script", projectId);
  project = (await invokeApp("get_project", { project_id: projectId })).project;
  fs.writeFileSync(path.join(out, "analysis-stage.json"), JSON.stringify({ operation: analyzeOp, project }, null, 2));
  const reviewOp = await runBillable("prepare_prompt_review", projectId);
  project = (await invokeApp("get_project", { project_id: projectId })).project;
  fs.writeFileSync(path.join(out, "prompt-review-stage.json"), JSON.stringify({ operation: reviewOp, project }, null, 2));
  const review = project.promptReview || project.promptReviewBundle || project.promptReviewReport || {};
  fs.writeFileSync(path.join(out, "final-result.md"), [
    `# 选题-简易对白真实后端复审`, ``, `- 项目 ID：${projectId}`, `- 选题数量：${topics.length}`, `- 选中：${selected.title || selected.id}`,
    `- 剧本格式：${project.productionPlan?.scriptFormat || ""}`, `- 剧本字符数：${String(project.script?.raw || "").length}`,
    `- 镜头数：${(project.shots || []).length}`, `- 人物数：${(project.characters || []).length}`, `- 场景数：${(project.scenes || []).length}`,
    `- 提示词复审结果：${JSON.stringify(review, null, 2)}`, ``, `## 上游操作`, JSON.stringify([topicsOp, scriptOp, analyzeOp, reviewOp].map(op => ({ action: op.action, status: op.status, operationId: op.operationId, completedAt: op.completedAt, errorCode: op.errorCode })), null, 2)
  ].join("\n"));
  const summary = {
    projectId, dataRoot: process.env.PUREAM_MCP_DESKTOP_USER_DATA_DIR || "", topics: topics.length,
    selectedTopicId: selected.id, selectedTitle: selected.title,
    scriptFormat: project.productionPlan?.scriptFormat, scriptRawChars: String(project.script?.raw || "").length,
    shots: (project.shots || []).length, characters: (project.characters || []).length, scenes: (project.scenes || []).length,
    assetPromptCounts: { characters: (project.characters || []).filter(x => x.prompt || x.imagePrompt).length, scenes: (project.scenes || []).filter(x => x.prompt || x.imagePrompt).length, props: (project.assetLibraries?.props || []).filter(x => x.prompt || x.imagePrompt).length },
    storyboardPromptCount: (project.shots || []).filter(x => x.imagePrompt || x.storyboardPrompt || x.compositeImagePrompt).length,
    videoPromptCount: (project.shots || []).filter(x => x.videoPrompt || x.prompt).length,
    generatedFiles: (project.candidates || []).filter(x => x.filePath).length,
    promptReviewKeys: Object.keys(review || {}),
    upstream: [topicsOp, scriptOp, analyzeOp, reviewOp].map(op => ({ action: op.action, status: op.status, operationId: op.operationId, completedAt: op.completedAt, errorCode: op.errorCode, usage: op.result?.usage || op.result?.upstreamReceipt || null }))
  };
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { fs.writeFileSync(path.join(out, "fatal.json"), JSON.stringify({ code: error.code || "", message: error.message, operation: error.operation || null }, null, 2)); console.error(error.stack || error); process.exitCode = 1; });
