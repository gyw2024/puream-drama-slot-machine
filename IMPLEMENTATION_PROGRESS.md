# IMPLEMENTATION_PROGRESS — 纯梦短剧 production-v2 实施进度

> 主规范：《纯梦短剧_全面优化实施方案.md》（用户上传版，附录 A–D 内嵌提示词/参考代码/Schema/任务顺序）。
> 规范：基线 0.16.359｜生产入口 `package.json → app/bootstrap.js → app/main.js`｜修改范围 `work/xiangsu-seedance-bridge/app/`。
> 继续工作时**先读本文件**，不凭记忆重新推导；每完成一个任务更新本文件并提交。

## 状态一览（T00–T20）

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| T00 基线/备份/测试环境/现状复现 | ✅ 完成 | `49e3fb0` | 校验脚本 27/27 PASS |
| T01 权威校验与完整结果保存止漏 | ✅ 完成 | `ec96b0e` | 新测试 18/18 + 存量回归无新增失败 |
| T02 规范合同与 SQLite CAS/迁移 | ✅ 完成 | `4ccd385` | production-v2 8 模块+repository；24/24 |
| T03 统一错误/重试/取消与 outbox 语义 | ⬜ 未开始 | | retry-policy 接入各模型调用层 |
| T03–T20 | ⬜ 未开始 | | 按主文档第 15 章顺序 |

## 当前任务：无（T02 已完成，下一任务 T03）

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
- **T03 统一错误、重试、取消与 outbox 语义**：把 `production-v2/retry-policy.js` 接入实际模型调用层——`agent-output-normalization.js` 修复循环、`h3-final-prompt-editor.js`、`prompt-review-editor.js` 全部从 coordinator 侧注入同一 budget handle（替换各自独立的重试计数）；`workbench-workflow.js/recoverAutonomousPipelineFailure` 不得在 budget exhausted 后 continue；新增命令路径的 outbox 入队统一走 `repository.enqueueOperation`（`autoResume:false`）。首个文件：`app/agent-output-normalization.js`。
- **注意**：`05-阶段与命令合同.md` 缺失，T03 起涉及字段/IPC 合同时按主文档第 4/8 章正文执行，并在各任务记录中注明推定口径。

## T02 交付记录（2026-09-17）

### 实际修改文件
- `app/production-v2/`（新建 9 个文件）：`contracts.js`、`approval-policy.js`、`prompt-range.js`、`retry-policy.js`、`dependency-graph.js`、`post-plan.js`、`read-model.js`、`terminal-policy.js`（以上 8 个为附录 B 全文誊录，require 路径 `.cjs`→`.js`）、`repository.js`（新写：commitCommand CAS/幂等、claim/commitOperation 租约、cancelOperation、approval_snapshots）。
- `app/foundry/runtime-store.js`：`RUNTIME_SCHEMA_VERSION` 1→2；migrate 新增 `command_log`/`approval_snapshots`/`prompt_chat_threads`/`prompt_chat_messages` 四表；`operation_outbox` 增 `lease_epoch`/`lease_owner`/`lease_expires_at`（PRAGMA table_info 检查后 ALTER，原地升级）；`commitProject` 拆出 `commitProjectInTransaction`（无 BEGIN 版本，供命令 CAS 单事务组合）；`beginOperation` 增 `autoResume` 选项（默认 true 保留旧行为，v2 命令路径传 false——§8.5 不擅自恢复失败任务）。
- `scripts/t02-production-v2-contracts.test.js`（新增 24 用例）、`scripts/t00-baseline-check.js`（production-v2 断言从"不存在"改为存在性校验）。

### 旧行为如何失效、新行为在哪里生效
- 旧：项目级快照提交无 expectedRevision，并发写互相覆盖（B17）。新：`repository.commitCommand` 在 BEGIN IMMEDIATE 内读行版本比较，冲突抛 `REVISION_CONFLICT`；同 commandId 同输入幂等重放原结果，不同输入抛 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`。
- 旧：`beginOperation` 自动把 failed/paused/waiting 拉回 running（§8.5 四层重试叠加根源之一）。新：`autoResume:false` 时重放仅返回原状态；显式恢复仍走默认路径（旧调用方零破坏）。
- 旧：无任何租约概念，outbox 操作可能被并发执行。新：`claimOperation` 发放 lease epoch（排队/过期/无主可领取），`commitOperation` 校验 epoch+inputHash，取消后提交返回 `cancelled`（取消不复活）。
- 初次批准快照：`approval-policy` 哈希白名单 + `approval_snapshots` 表已就绪（T05 接线）。

### 测试（原始数字）
- `node --test scripts/t02-production-v2-contracts.test.js` → **24 pass / 0 fail**。
- 存量回归 `foundry-v2-architecture` → 15 pass / 2 fail（**与 T00 基线 15/2 一致，存量失败**）。
- `node scripts/t00-baseline-check.js` → 27/27 PASS。

### 未能验证的环境
- 迁移仅在新建库上验证；**未在真实存量 foundry-v2.sqlite（旧项目数据）上跑升级路径**——下次应用启动时首次触发，需在 T18 打包前用真实数据备份实测。
- node:sqlite 为实验特性（Node 22 现状，与既有代码一致）。

### 遗留与风险
- `repository.js` 尚未被任何 UI/MCP/workflow 调用（按方案设计，T03 起逐入口接线；未接线前不影响现网行为，也不宣称任何用户可见改进）。
- `prompt_chat_*` 两表已建但无读写代码（T08 使用）。

## T01 交付记录（2026-09-17）

### 实际修改文件与函数
1. `app/typed-output-receipt.js`：
   - 新增 `stableStringify`/`sameJson`（规范化 JSON：key 排序）；`conforms` 的 enum/const/uniqueItems 改用规范化比较——对象 key 顺序不再影响语义判定。
   - 新增 `validateSchemaSupported(schema)`：schema 感知遍历（properties/patternProperties/$defs 内是名字非关键字；enum/const/type 是数据），返回 `{ok, unsupported:[{path,keyword}]}`。
   - 新增 `validateSubmittedValue(value,schema)`：**conforms 决定有效性，inspect 只解释**——inspect 漏报时兜底默认 finding，非法值不可能再被放行。
   - `format` 关键字按 draft-07 注解接受（实测 11 个存量任务 schema 含 format；不加会把真实任务全部打回）。其余未知关键字维持 fail-closed。
2. `app/mcp/stage-delivery.js` `submit`：responseSchema 分支从「inspect findings 空=通过」改为 `validateSubmittedValue` 权威判定（规范 §8.3 原文要求）。
3. `app/mcp/stage-preview.js` `preview`：同款 inspect 漏报漏洞，同一模式修复（规范 §8.3：预览适用同一权威校验）。
4. `app/local-agent-runtime.js`（run/runFresh 任务装配，request.json 写入前）：新增 responseSchema 前置校验——不支持的 schema 抛 `LOCAL_AGENT_SCHEMA_UNSUPPORTED`（noAutomaticRetry），任务直接 failed。程序配置错误不再进入模型修复，也不会在提交门变成永久死门。
5. `app/mcp/app-controller.js`：
   - `safeResult(value, artifactStore)`：大结果（>120KB）**先完整落盘**（临时文件+原子更名+哈希回读校验）再返回引用 `{artifactRef, sha256, byteLength, preview, previewTruncated:true, resultComplete:true, readMethod:"read_operation_result"}`；磁盘失败时 `resultComplete:false`+错误码，绝不把丢失的结果谎报为已保存（规范 §8.7 / B16）。
   - 新增 `readOperationResult` + `read_operation_result` 分页方法：artifactRef 不透明、只能经操作注册表解析（拒绝任意 filePath）；读取时校验登记哈希；分页返回 UTF-8 总字节与字符位 offset/nextOffset。
   - 新增 `safeOperationResult(record, result)` 并接入 `startOperation` 完成路径。
6. `scripts/t01-validation-contract.test.js`（新增 18 个用例）。

### 旧行为如何失效、新行为在哪里生效
- 旧：`submit`/`preview` 用 `inspect()` 返回数组空否判有效性 → inspect 不认识的关键字/漏报场景下，schema 非法结果照常 `saved`。新：`validateSubmittedValue` 以 `conforms` 为唯一权威，两处调用点替换完成（mcp-submissions.jsonl 流水保留）。
- 旧：`run()` 装配任务时不检查 schema 支持范围，坏 schema 到提交门才表现为「永远 needs_revision」死门。新：request.json 写入前抛程序错误并标 job failed。
- 旧：`safeResult` 大结果只回 24KB 预览，正文丢弃不可恢复。新：完整 artifact 落盘于 `<rootDir>/mcp-operations/artifacts/<operationId>.json`，MCP 客户端用 `read_operation_result` 分页取回。

### 测试（原始数字）
- `node --test scripts/t01-validation-contract.test.js` → **18 pass / 0 fail**。
- 存量回归：mcp-stage-delivery 15/0、stage-output-schemas 3/0、response-schema-routing 2/0、antigravity-output-schema 4/0、codex-text-receipt 5/0、semantic-schema-214 3/0、submission-agent-review 5/0、hailuo-final-submission-integrity 4/1（**与 T00 基线 4/1 一致，存量失败，非本次引入**）。
- 合计本轮 36/36（t01+mcp-stage-delivery+stage-output-schemas 复跑）。

### 未能验证的环境
- 未跑全量 318 文件回归（8 个文件挂起，禁用全量；已跑受影响模块全集）。
- 未实机验证 MCP 客户端（Codex/Claude）真实调用 `read_operation_result` 的互操作。
- 未做 Electron/Windows 打包验证（T18）。

### 边界说明（未做、留给后续任务的）
- `agent-output-normalization` 自身修复循环、native tool receipt（createReceiptTracker）与归一化入口的权威校验接线属 T03/T04（重试预算/Agent 事件层）。
- `stage-delivery.read` 的回执与 attempt/lease/epoch 绑定需要 T02/T03 的 operation 模型，T01 未动 read（保持 jobId+hash 校验现状）。
