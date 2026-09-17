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
| T03 统一错误/重试/取消与 outbox 语义 | ✅ 完成 | `296482a` | budget 句柄+热循环堵口；新测试 8/8 |
| T04 Agent 事件/租约/进程/完整性 | ✅ 完成 | `47b0573` | 终局分类+取消不复活+迟到结果归档；10/10+回归 42/42 |
| T05 统一批准与弹窗 gate | ✅ 完成 | `f749241` | final 直达后期、自动弹窗许可原子化、v2 逐条批准 |
| T06 单一提示词装配 | ✅ 完成 | `84ae6c1` | prompt-compose（P00+ruleId 去重+溯源）+入库循环预算化 |
| T07 20 分钟软目标与预算视图 | ✅ 完成 | `deb648e` | 活动时间区间并集持久化；超标禁自动新整稿修复 |
| T08 单条聊天后端 | ✅ 完成 | `2ad50e6` | PromptChatService+专用 Schema+线程持久化；7/7 |
| T09 单条聊天抽屉+IPC | ✅ 完成 | `61fe10f` | main/preload 白名单 IPC+每条目"让 Agent 修改"入口 |
| T10 资产 CRUD 白名单命令 | ✅ 完成 | `7051b64` | origin=user 人工保护、软删除、引用标记 |
| T11 分镜 CRUD 白名单命令 | ✅ 完成 | `d0f1a45` | 稳定身份、克隆不复制对白绑定、selectedVideoSetHash |
| T12 依赖失效闭包 | ✅ 完成 | `d0731ef` | §11.5 精确失效下游并保留成果 |
| T13 视频状态统一协调器 | ✅ 完成 | `c5fd01c` | onArtifactCommitted 幂等入队粗剪并接入工作流 |
| T14 净音/音效预览/分轨导出 | ✅ 完成 | `2fa6183` | roughcut-sfx 独立预览+partial_audio+只补音效重试（B08/B20） |
| T15 统一 read-model 与事件游标 | ✅ 完成 | `7920d2b` | buildProductionView+项目专属连续 streamSeq+一致游标握手 |
| T16 下一步按钮与引导修复 | ✅ 完成 | `1661c89` | 删除自动点击、目标可见性/弹窗/reduced-motion 校验 |
| T17 主流 Agent 能力与事件适配 | ✅ 完成 | `f724369` | 5 客户端终局分类 fixture+版本核验证据 |
| T18 迁移、Windows、打包与恢复 | ✅ 完成 | `76eb46a` | 存量库原地升级、legacy 三分类迁移+备份 manifest 可校验 |
| T19 应用级破坏性测试与长稿性能 | ✅ 完成 | `3b590ae` | 事务回滚/租约接管/Agent 重启/重复折叠；37/37（T14–T20 合计） |
| T20 清理旧循环/重复门禁/错误文案 | ✅ 完成 | 见下方 T20 记录 | 减法合同测试 5/5 |

## 当前任务：无（T20 已完成，T00–T20 全部交付）

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

## T03 交付记录（2026-09-18）

### 实际修改文件与函数
1. `app/production-v2/budget.js`（新增）：coordinator 侧统一预算句柄 `createRepairBudget`——全部决策/消耗经 `production-v2/retry-policy`（单一权威）；`nextWorkUnit()` 重置单元计数（策略固定 2/单元）、`runRepairs` 跨单元累计至 `maxRunRepairs`（默认 12）；`consumeRepair` 预算先于调用消耗、耗尽抛 `REPAIR_BUDGET_EXHAUSTED`；`decide()` 暴露统一错误决策（stop/reconcile/pause/repair）。
2. `app/agent-output-normalization.js` `recover`：无界 `for(;;)` 接入预算——默认自建 work-unit 句柄（maxRunRepairs:2 = 三个声明策略恰好 3 次模型调用）；接受 `options.repairBudget` 共享句柄；入口预检 `budget.exhausted`（耗尽句柄零付费调用即终态）；耗尽抛 `AGENT_EVIDENCE_PENDING` + `repairBudgetExhausted:true` + `noAutomaticRetry:true`（与 repeats>=3 同型，保留 accepted 行）。
3. `app/h3-final-prompt-editor.js` `author`：接受 `budget`（缺省自建）；每镜修复上限 2（`repairTries` 映射，一轮=批内全部未完成镜各计 1）；每修复轮 `consumeRepair`（批=work unit，`nextWorkUnit`）；超限镜头进 `stranded` 并以既有终态错误 `H3_FINAL_EDIT_NEEDS_REPAIR` 抛出（`shotIds` 含 stranded、`repairBudgetExhausted` 标记），已完成镜头全部保留。
4. `app/prompt-review-editor.js` `run`：接受 `budget`；外层复审轮（round>0）consume，耗尽 → `waiting/reason:repair_budget` 优雅暂停（既有 UX）；内层修改会话 = work unit，三个付费 continue 路径（requestTargetIds 续供、越界 edits、应用失败）均 consume，耗尽 → 同款暂停。不再存在无界付费循环。
5. `app/workbench-workflow.js`：
   - `recoverAutonomousPipelineFailure` 顶部终态守卫补 `PROVIDER_RECOVERY_WAITING`（**P0 热循环修复**：该码 `retryable:true` 会命中 transient 分支再次抛出自身，被外层 catch 重喂后无 sleep 无限循环；原守卫只堵了两个 `*_EXHAUSTED` 码）。
   - `runFullPipeline` 调用方：re-feed 有限化（`repairChain>3` 或终态码/noAutomaticRetry 直接 `throw repairError`），保留恢复动作自身抛出新可恢复错误的嵌套修复能力。
   - `authorFinalH3PromptBlocks`：coordinator 自建 `repairBudget`，author 与源稿修复重入循环共享同一句柄。
   - `editPromptReviewDocument`：注入 `budget`（经 `prompt-review-proposal.propose` → `editor.edit` → `run`）。
6. `scripts/t03-retry-budget.test.js`（新增 8 用例）。

### 旧行为如何失效、新行为在哪里生效
- 旧：`recover` 在模型每次返回**不同**非法输出时永不收敛（指纹去重只挡重复输出），持续付费；`h3 author`/`prompt-review run` 修复轮无上限。新：全部经同一 retry-policy 预算，耗尽即终态暂停/错误，证据保留，可显式续跑。
- 旧：transient 预算（4 次）耗尽后 `PROVIDER_RECOVERY_WAITING` 被调用方重喂 → 每次 `transientRetries+=1` → 再抛 → **无 sleep 热循环**（附：`transientRetries` 由 structure/transient 两路径共享，任一耗尽即触发）。新：终态守卫 + 调用方上抛，循环必终止。
- 新增命令路径 outbox 入队：`repository.enqueueOperationInTransaction` 直接插 `queued`、从不调 `beginOperation`，天然无自动恢复；测试固化该语义（幂等入队、attempts=0、显式 claim 才领取、取消不复活）。**后续 T05+ 新命令路径必须统一走 `repository.enqueueOperation`，禁止绕过直写 operation_outbox。**

### 测试（原始数字）
- `node --test scripts/t03-retry-budget.test.js` → **8 pass / 0 fail**。
- 存量回归：agent-output-normalization 4/0、codex-text-receipt 5/0、local-agent-admission 16/0、agent-delivery-recovery 5/0、firstpass-structural-218 8/1（**存量失败**——已用 `git stash` 对照 HEAD 版本复跑，同为 `not ok 5`，与 T03 无关）。
- t00 基线校验 PASS；t01 18/18；t02 24/24 复跑全绿；4 个改动文件 `node --check` 语法通过。

### 未能验证的环境
- 未实机跑一键全流程（真实付费模型）验证恢复路径的新行为；恢复函数分支极多（30+ 错误码），本次仅源码级 + 单测覆盖关键堵口。
- `firstpass-structural-218` 的存量失败（AGENT_EVIDENCE_PENDING vs PROVIDER_REQUEST_ABORTED，audit-progress 诊断优先生效）本身像真缺陷，已记入下方遗留。

### 遗留与风险
- **存量失败待办**：`firstpass-structural-218` not ok 5——取消信号应优先于 audit-progress 的 unchanged-receipt 诊断。属既有行为缺陷，非 T03 引入；建议单开修复（涉及 audit-progress.request 的 signal 优先级）。
- h3 每镜 2 次修复上限是行为收紧：极端场景（某镜需 3+ 轮才收敛）现在会提前进入终态、保留已完成镜头待显式续跑。符合规范"不为收敛而无限付费"，但若用户反馈"以前能跑过的现在停了"，按此口径解释。

### 下一任务
- **T04 Agent 事件、租约、进程与完整性**（主文档第 15 章：验收=终局判断正确、取消不复活、所有输出可恢复）。入口：`local-agent-runtime.js`（job 终局判定）+ T02 已就绪的 `claimOperation/commitOperation` 租约接线。取消路径用 T03 的 `budget.cancel()`/decide(stop) 贯穿。



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

## T14–T20 交付记录（2026-09-18，批量连续执行）

### T14 净音/音效预览/分轨导出（`2fa6183`）
- B08：`mixFixedSfxIntoVideo` 一直存在但从未被粗剪工作流调用（且被旧 build contract 明文禁止）。按 §10 新要求反转合同：净音版仍不烧音效，但粗剪完成即在同一 EDL 上产出独立 `*-roughcut-sfx-*.mp4` 含音效预览；`postAudioMode=preview_and_draft|draft_only|none`，缺省 preview_and_draft，显式设置原样保留。
- partial_audio：clean 成功/音效失败 → `postAudioState=partial_audio`，净音版保持可预览可导出；部分批次待补时先混入已验证 cue。
- B20：`matchStageSfx` 批次失败不再清空全部 cues——已验证批次保留，`pendingShotIds` 记录待补；重试（`retrySfxPreview`，MCP 工具 `retry_sfx_preview` 免费本地）带 `previousPlan` 只重新匹配待补镜头。
- 新增 `scripts/t14-post-audio.test.js` 5/5；`post-production-build-contract` 更新为 audible-preview 合同（8/8）。

### T15 统一 read-model 与事件游标（`7920d2b`）
- `read-model.js` 新增 `buildProductionView(project, operations, capabilities)`：phase/stageSummary/counts/warnings/blockedReasons/nextAction/review.canAutoOpen/activeOperations/artifacts；缺字段显示 unknown/not_ready 不回落 completed；视频齐全要求 `localVerified`（§9）。
- runtime-store 新增 `project_events` 表：项目专属连续 streamSeq（非全局 sequence），`appendProjectEvents/listProjectEvents/projectEventCursor`。
- `getProductionView`：游标先于快照读取 → 快照→订阅握手不可能丢事件；`workbench:production-view` IPC。
- 工作流 `runOwnedOperation` 挂 operation.started/completed/paused/failed 四类事件。
- workbench `nextActionForProject` 与 simple-mode `firstIncompleteStage` 均改为先消费统一视图（带 legacy 兜底）。

### T16 引导修复（`1661c89`）
- 删除 `renderNextActionGuide` 中 `setTimeout(() => liveTarget.click())` 自动点击。"带我去操作"只做切 tab、scrollIntoView、focus。
- 新增 `guideTargetVisible`：disabled/hidden/祖先 hidden/aria-hidden/computedStyle display:none/visibility:hidden 全查；弹窗打开时只允许弹窗内目标；找不到目标只给文字导航；prefers-reduced-motion 关动效。

### T17 Agent 能力与事件适配（`f724369`）
- `terminal-policy.classifyEvent` 从 codex/claude-code 扩到全部 5 个声明客户端（antigravity: event=result/error；grokbuild: turn.completed/failed+result；deepseek-harness: event 线；workbuddy: result 方言）。error_max_turns 维持 incomplete（可续）语义。
- `agent-catalog-version` 版本核验扩到全部客户端：有官方渠道者（grokbuild/deepseek）做远端比对，其余本机核验留证。
- 运行时事件循环分类条件从 `codex||claude-code` 改为 `definition(id)` 全覆盖。`t17-agent-evidence.test.js` 5/5。

### T18 迁移/打包/恢复（`76eb46a`）
- foundry 存量库原地升级：`migrateV2LeaseColumns` 泛化为 ensureColumns，project_state 缺 contract_fingerprint 列自动补——实测旧 schema 库（手工建旧表+插入数据）打开后数据完好。
- `legacy-migration.js`（§14.1 三分类）：真实 userConfirmed 证据+媒体 → `legacy_imported`（status=approved 无证据不伪造）；有媒体无批准 → `authorized_media`（本地预览/粗剪/导出保留，新付费需局部授权）；全空 → `review_ready`（gate 只自动展示一次）。幂等：同 sourceRevision 重跑只校验。
- `createMigrationManifest/verifyMigrationManifest`：备份 project.json+sha256，篡改可检出。
- `t18-legacy-migration.test.js` 5/5。安装包实际运行验证需真机 electron-builder（本环境静态校验 build:installer/audit 脚本链完整）。

### T19 应用级破坏性测试与长稿性能（`3b590ae`）
- 事务中途崩溃 → 整体回滚、可安全重放；租约持有人崩溃 → TTL 过期后新 worker 接管、旧租约 commit 返回 stale_attempt；AgentHub 进程死亡重启 → 运行中任务标 interrupted、迟到结果归档不复活；同操作并发重复触发折叠为一个 attempt。
- 长稿：500 镜 buildProductionView + 5000 事件 reduceEvents 均在预算内（<200ms/<1500ms）。

### T20 清理减法合同（本提交）
- `t20-cleanup-contract.test.js` 5/5：单一后期路径（final 直达+流水线末段同入口、localPostOperations 去重）；付费热循环预算化/有界化收口保持；双门禁不叠加；门禁错误 expectedControl+结构化 code；v2 路由布尔唯一（productionV2.enabled，无第二套路由布尔）。

### T14–T20 测试合计
- 新增 7 个测试文件 37/37 PASS；t00 基线 27/27 PASS；受影响存量回归（contract 8/8、agent-catalog 4/4、t04 10/10、t02+t08 31/31）无新增失败。

### 未能验证的环境（如实记录）
- Windows 安装包实际安装/启动冒烟（需 electron-builder 构建环境与真机 GUI），本次完成到静态合同+审计脚本链验证。
- 真实 Agent CLI（codex/agy/grok/deepseek）端到端事件流与版本核验（fixture 为据）。
- 全量 318 文件回归（8 文件挂起禁用全量，沿 T00 结论）。
