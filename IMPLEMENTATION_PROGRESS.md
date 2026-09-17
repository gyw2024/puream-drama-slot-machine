# IMPLEMENTATION_PROGRESS — 纯梦短剧 production-v2 实施进度

> 主规范：《纯梦短剧_全面优化实施方案.md》（用户上传版，附录 A–D 内嵌提示词/参考代码/Schema/任务顺序）。
> 规范：基线 0.16.359｜生产入口 `package.json → app/bootstrap.js → app/main.js`｜修改范围 `work/xiangsu-seedance-bridge/app/`。
> 继续工作时**先读本文件**，不凭记忆重新推导；每完成一个任务更新本文件并提交。

## 状态一览（T00–T20）

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| T00 基线/备份/测试环境/现状复现 | ✅ 完成 | 见 git log `T00` | 校验脚本 19/19 PASS |
| T01 权威校验与完整结果保存止漏 | ⬜ 未开始 | | stage-delivery submit/read + typed-output-receipt |
| T02 规范合同与 SQLite CAS/迁移 | ⬜ 未开始 | | 建 app/production-v2/，迁入附录 B 合同 |
| T03–T20 | ⬜ 未开始 | | 按主文档第 15 章顺序 |

## 当前任务：无（T00 已完成，下一任务 T01）

## 方案包缺口（如实记录）

用户提供的实施包**只有主文档一个文件**（`纯梦短剧_全面优化实施方案.md`，120,719 字节）。文档引用的以下独立文件**不存在**，其内容部分内嵌于附录：

- `tasks/实施任务卡.md`、`01-发给执行AI的总指令.md`、`02-验收矩阵.md`、`03-内置模板处置清单.md`（68 项模板处置表）、`04-参考实现与接口合同.md`、`05-阶段与命令合同.md` —— **全部缺失**。执行依据改用主文档第 15 章任务顺序表 + 正文各章规格。68 项模板处置表缺失意味着 T06（提示词装配）按第 13 章原则执行，逐项处置需用户补件或现场核对。
- `reference-code/*.cjs` 7 个参考模块 —— 附录 B 有全文，T02 时誊录入 `app/production-v2/` 并自行补写合同测试。
- `prompts/P00–P13` —— 附录 A 有全文。
- `evidence/源码定位表.md`、`evidence/源码证据快照.md`、`evidence/reference-tests.tap`、`tests/reference-contracts.test.cjs`（66 项参考测试）—— **缺失**。行号锚点以主文档第 2 章表格为起点，T00 已用函数锚点重新验证关键项。
- 源码 ZIP SHA-256 `e0cfe230…` 无法对证（用户未附原始 ZIP），以本机 git 基线为准。

## T00 交付记录（2026-09-17）

### 实际修改文件
- `work/xiangsu-seedance-bridge/scripts/t00-baseline-check.js`（新增）：生产入口链 + B 系列锚点复现校验。
- `IMPLEMENTATION_PROGRESS.md`（新增，仓库根）：本文件。

### 回滚点
- `main@8e1caec`：T00 前置备份（固化 workbench-workflow.js 9800 兜底补丁 + 9 个诊断脚本 + .gitignore）。
- 实施分支：`production-v2-impl`（自 8e1caec 切出）。

### 现状复现证据（node scripts/t00-baseline-check.js → 19/19 PASS）
- 生产入口链确认：`main=app/bootstrap.js`（`require("./main")`），版本 0.16.359。
- **B01 复现**：`runPipelineFromStage` 内 `["script","assets","shots","videos","final"].some(shouldRun)` 门控后 582 字符即 `await this.requestPromptReview(...)` —— 含 `final` 的入口仍触发整稿提示词确认。
- **B08 复现**：`stitchProjectLocal`（函数锚点，基线行号 30428）在拼接前 `await matchStageSfx`（基线行号 30406）；`separate-draft-tracks` 不混音效。
- **B12 复现**：`app/screenplay-stage-separation.js:19` `for(;;){` 无界循环。
- B02/B03/B04/B05/B07/B09/B20 锚点存在；`onArtifactCommitted` 不存在（B09 成立）。
- `app/production-v2/` 不存在（T02 起创建）。

### 测试基线（隔离法：bash .codex_work/run-tests-isolated.sh 60 8，结果 .codex_work/test-results.txt）
- 318 个测试文件：**310 正常完成，8 挂起超时**；断言合计 **pass=1874 / fail=160**。
- 8 个挂起文件（已知问题，`npm test` 全量会永久挂起，禁用；逐文件带 timeout 60s 跑）：
  `direct-fast-script` `duration-contract-regression` `prompt-matrix-dialogue-regression` `prompt-review-order-regression` `shot-screenplay-routing` `shot-screenplay` `timed-storyboard-prompt-cost-regression` `uploaded-analysis-resume-regression`
- 与上一时段基线（1874/160、同 8 文件挂起）**完全一致** → 可复现。
- 160 条失败是否新增：git 基线已入库（353–359 已提交），后续可用 `git worktree add` 从任意提交对比，不再受阻。

### 未能验证的环境
- 未做 Windows 打包安装验证（T18）。
- 未做真实付费模型/媒体调用（按规范须用户明确授权后才实机验证）。
- `evidence/` 参考测试（66 项）无原始文件，无法对照。

### 下一任务
- **T01 权威校验与完整结果保存止漏**：`app/mcp/stage-delivery.js` `submit`（`inspect` 空即放行 → `conforms` 优先）、`read`（回执绑定 attempt/cancel/source）、`app/typed-output-receipt.js` 加 `validateSchemaSupported` 与规范化比较。首个文件：`app/typed-output-receipt.js`。
