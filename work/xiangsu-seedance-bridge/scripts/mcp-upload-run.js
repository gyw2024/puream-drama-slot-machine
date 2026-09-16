"use strict";
const fs = require("node:fs");
const { invokeApp } = require("../app/mcp/control-client");
const projectId = process.argv[2];
const scriptPath = "C:/Users/Administrator/Desktop/上传测试_暖心阅读灯_舞台对白剧本.txt";
const productPath = "C:/Users/Administrator/Desktop/Codex 图像 2026年8月5日 16_57_28.png";
async function main() {
  const text = fs.readFileSync(scriptPath, "utf8");
  const calls = [
    ["import_script_text", { project_id: projectId, text }],
    ["import_product_path", { project_id: projectId, file_path: productPath }],
    ["update_project", { project_id: projectId, patch: {
      product: { name: "暖心阅读灯", description: "白色圆形底座、暖黄色灯光、旋钮开关的阅读灯", sellingPoints: "暖黄色阅读光、旋钮调节、照亮孩子晚读" },
      productionPlan: { inputMode: "manual", scriptHandling: "respect", commerceMode: "natural", executionMode: "step" }
    } }]
  ];
  for (const [method, params] of calls) {
    const result = await invokeApp(method, params);
    console.log(JSON.stringify({ method, ok: result.ok, projectId: result.project?.id, stage: result.project?.currentStage, status: result.project?.status, product: result.project?.product }));
  }
}
main().catch(error => { console.error(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; });
