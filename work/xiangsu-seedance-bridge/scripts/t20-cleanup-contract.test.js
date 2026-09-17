"use strict";
// T20: 清理旧循环/重复门禁/错误文案——减法完成，无两套生产路径互相冲突。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = name => fs.readFileSync(path.join(__dirname, "..", "app", name), "utf8");
const workflow = app("workbench-workflow.js");

test("单一后期路径：final 分支与流水线末段都走同一条门禁入口，本地后期并发去重", () => {
  const finalShortCircuit = workflow.indexOf('if (fromStage === "final")');
  const pipelineFinal = workflow.indexOf('if (shouldRun("final"))');
  assert.ok(finalShortCircuit > -1 && pipelineFinal > finalShortCircuit, "final 直达必须先于流水线末段判断");
  // 本地后期按项目去重：并发第二个调用要么合并要么显式拒绝，绝不双跑。
  assert.match(workflow, /localPostOperations\.get\(projectId\)/);
  assert.match(workflow, /LOCAL_POST_BUSY/);
});

test("付费热循环全部预算化/有界化（T03/T07 收口保持）", () => {
  const intake = app("screenplay-stage-separation.js");
  const intakeCode = intake.replace(/\/\/.*$/gm, ""); // strip comments
  assert.match(intake, /consumeRepair|createRepairBudget|repairBudget/, "入库循环必须消耗修复预算");
  assert.doesNotMatch(intakeCode, /for\s*\(;;\)/, "入库 for(;;) 必须已移除（代码，非注释）");
  const normalization = app("agent-output-normalization.js");
  assert.match(normalization, /repairBudgetExhausted|AGENT_EVIDENCE_PENDING/);
  const provider = app("ai-provider.js");
  for (const bound of ["IMAGE_POLL_DEADLINE_MS", "VIDEO_POLL_DEADLINE_MS", "TEXT_RATE_LIMIT_ATTEMPT_CEILING"]) {
    assert.match(provider, new RegExp(bound), `ai-provider 缺少有界化常量 ${bound}`);
  }
  // 预算耗尽必须终止自动重试。
  const intakeThrowsBudget = /REPAIR_BUDGET_EXHAUSTED/.test(intake) && /noAutomaticRetry:true/.test(intake);
  assert.ok(intakeThrowsBudget, "预算耗尽必须抛终态码且禁止自动重试");
  assert.match(workflow, /AUTONOMOUS_PIPELINE_REPAIR_EXHAUSTED|PROVIDER_RECOVERY_WAITING/);
});

test("双门禁减法：视频/资产生成按 v2 逐条批准或整稿 gate 二选一，不叠加", () => {
  assert.doesNotMatch(workflow, /this\.assertPromptReviewApproved\(projectId\);\s*this\.assertPromptReviewApproved\(projectId\)/, "不得连续调用两次整稿 gate");
  assert.match(workflow, /assertApprovedItemsForEntities\(gateProject[^)]*intent: "分镜视频生成"/, "视频门必须走 v2 逐条批准");
});

test("错误文案：门禁错误必须 expectedControl + 结构化 code，供 UI 精确引导", () => {
  for (const code of ["PROMPT_REVIEW_REQUIRED", "PROMPT_ITEM_APPROVAL_REQUIRED"]) {
    assert.match(workflow, new RegExp(`code:\\s*"${code}"`), `缺少结构化错误码 ${code}`);
  }
  assert.match(app("screenplay-stage-separation.js"), /code:'REPAIR_BUDGET_EXHAUSTED'/, "入库预算耗尽必须抛结构化终态码");
  const gateBlock = workflow.slice(workflow.indexOf("PROMPT_ITEM_APPROVAL_REQUIRED") - 400, workflow.indexOf("PROMPT_ITEM_APPROVAL_REQUIRED") + 200);
  assert.match(gateBlock, /expectedControl: true/, "门禁错误必须标记 expectedControl");
  // 逐条批准文案必须告诉用户保留了什么、不会发生什么。
  assert.match(gateBlock, /不会提交付费任务/);
});

test("v2 路由开关唯一：productionV2.enabled 是唯一路由布尔", () => {
  const v2Flags = workflow.match(/productionV2\?\.(enabled|route\w*)/g) || [];
  const otherRouteBooleans = workflow.match(/useProductionV2|enableV2Pipeline|legacyPipelineMode/g) || [];
  assert.ok(v2Flags.length > 0, "必须存在 v2 路由开关");
  assert.deepEqual(otherRouteBooleans, [], "不得引入第二套路由布尔（§14.3）");
});
