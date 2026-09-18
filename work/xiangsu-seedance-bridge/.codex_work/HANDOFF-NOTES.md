# 遗留测试清理·交接备忘（2026-09-18 凌晨，主会话分析沉淀）

## 进度
- 基线 209 失败 → 当前 156（2145 通过，337 文件 0 挂起）。
- 已修完文件（勿重复动）：t07-text-target、text-recovery-regression、account-review-recovery-224、script-review-repair-222、writing-handoff-215、commerce-repair、topic-relay-regression、final-prompt-blocks、direct-fast-script、agent-model-options、simple-mode-isolation。
- 部分修复：shot-screenplay（10→剩 2~3：test 13/14 需按"延期审核确认页"新入口重写——author() 现在对干净稿 early-return ready（line 179-183 附近），语义审核已移出 author）。

## 已确认的语义与修法模式（复用）
1. **vm 切片测试**：workbench.js 提取函数进 vm 需注入 `videoStatusApi: require('../app/workbench-status')`、`window:{ProductionView:require('../app/production-v2/read-model')}`、`escapeHtml` stub；还要把新依赖函数（unifiedActionCard/legacyNextActionForProject 等）一起切片。
2. **prototype 假 this**：`productionTextOptions.call({...})` 类测试需补 `textStageDedupeScope: WorkbenchWorkflow.prototype.textStageDedupeScope`。
3. **阶段名**：老 mock 的 `shot_screenplay_write` 应改为 `shot_screenplay_draft`（返回纯文本）+ `shot_screenplay_structure`（返回文档对象）。
4. **author() 预算耗尽 salvage（已实现）**：prepare 抛 REPAIR_BUDGET_EXHAUSTED 且 state.document?.shots?.length 时转本地 repair 路径。注意：若 structure 连合法稿都没产出（state.document 无 shots），仍会抛出——uploaded-analysis-resume / prompt-review-order 的此类失败要改 mock 让 structure 产出合法稿或断言预算终态。
5. **合同权威位置迁移**：screenSide/depth/facing/eyeline 账本 → `drama-writing-contract.js sharedDramaWritingContract()`；stage 指令 `h3TextStageDirective` 只保留镜头边界规则。UI 文案：workbench.html 制作包叫「资产导入/导入资产包」，mode-selector.html 才有「Codex 资产包直抽」。
6. **AGENTS 证据等待防护（预期行为）**：audit-progress.js——同一请求重发→先诊断一次；诊断后回执不变→抛 AGENT_EVIDENCE_PENDING（recoverable, expectedControl）。测试遇到它＝mock 永远回不合法回执，或复用指纹没命中。

## 重点疑难（带分析）
### repair-241-contracts test 7（equivalent timing aliases）
- 现象：call-1 的 chronology for(;;) 循环因 mock 回执格式旧（{items} 而非 {shots:[{shotId,sourcePhase,proposedPhase,issues}]}）永不通过 → 诊断一次后抛 AGENT_EVIDENCE_PENDING。
- 修法方向：(a) mock 按当前 schema 分支（responseSchema.properties.shots → 回 shots 行）；(b) **测试真意**：prompt-chronology-audit.js `input()` 的 sourceDialogue 应做时序别名规范化（start===startSecond && end===endSecond 时剥掉 start/end）再进指纹，使别名等价输入复用 chronology（call-2 calls 不增）；真实时间编辑（startSecond 1.1）→ 条目审核 +1（call-3 总 calls=2，即 chronology 不额外加跑——需核对其复用键是否应只含 shotIds+prompts+execution 而不含逐句秒数，按测试数字反推）。
### prompt-review-order-regression test 6 / uploaded-analysis-resume（REPAIR_BUDGET_EXHAUSTED）
- structure mock 产出连 issues() 都过不了的稿 → state.document 无 shots → author salvage 不适用。改 mock 产出合法稿，或断言预算终态语义（保留成果+显式续跑）。
### 老旧回执格式类
- 凡 mock 回执与当前 schema 不符导致"等待证据"的，统一改为按 opts.responseSchema 形状回（区分 items/shots 两种）。

## 其他注意
- 隔离跑法：`bash .codex_work/run-tests-isolated.sh 120 8`（全量 2 分钟，绝不跑裸 npm test——会挂起）。
- 单文件验证：`timeout 120 node --test scripts/<file>.test.js`。
- 禁 git 写操作；禁真实用户数据（C:\Users\Administrator\AppData\Roaming\xiangsu-seedance-bridge）；禁真实网络。

## 05:10 更新（已修文件追加）
prompt-review-dialog-regression（v16 版本串）、source-speech-measurements、compact-screenplay、agent-director-contract、agent-analysis-preservation、upstream-contract-246、root-contract-regression、drama-duration-capacity-regression、upstream-performance-contract-v158、video-preflight-recovery-regression、staging-independent-v175（sync-drama-skill --write）、dialogue-first-action-minimalism（还剩 3 条未修）、firstpass-structural-218、content-requirements-root（还剩 1 条 evidence-pending）、dialogue-rewrite-contract。

## 新增经验
- **延期审核（T05）**：干净已存稿/结构稿→author 直接 ready，reviews=0；"随稿语义审核+criteria 回执"类断言一律改为 reviews=0 + status ready + 文档保持，并注明审核在确认页。
- **版本串断言**：prompt-review 现为 prompt-review-v16-confirmation-inplace-editor。
- **skill 副本**：app 代码改动后必须 `node scripts/sync-drama-skill.js --write`（staging-independent-v175 校验字节一致）。
- source-speech-measurements/compact-screenplay.test 里 require('./compact-screenplay.test') 会连带执行其测试。
- mock 分支要放在 stage 判断里：draft(无 responseSchema)/structure(有 schema、shots 属性)/review/repair。

## 22:40 更新（主会话直接修复，子代理 429 期间）
- 基线 122 → 99 左右；已修文件追加：screenplay-protocol-transition（4→0）、text-stage-sla（1→0）、frame-and-simple-tone（1→0）、shot-screenplay-routing（8→0）、uploaded-analysis-resume-regression（5→0）、h3-asset-direct-mode-regression（5→0）。
- **新架构事实（改测试必读）**：
  - analyzeScript = agent-analysis-entry.analyze：一次编剧入库（shot_screenplay_draft 纯文本 → shot_screenplay_structure 文档对象），旧的 standardization/formatAdaptation/analysisEnhancement/分块语义全部退役。干净稿 author() 早退 ready；review 阶段已死分支，语义审核在确认页。
  - analyze 短路条件：sourceFingerprint=sha256(raw) + analyzedAt + shots/scenes 存在 + (!shotScreenplay || runtimeCurrent)。preparePromptReviewBundle 在 !runtimeCurrent 时会 forceReanalysis:true 重入编剧——夹具要么给 runtimeCurrent 的 shotScreenplay 记录（shotExecutionFingerprint=hash(execution)），要么 mock generateText 处理 draft/structure。
  - WorkbenchWorkflow 构造函数闭包捕获 textGenerator（rawGenerateText），事后 workflow.textGenerator= 赋值无效；用可变委托 let intakeHandler + (...args)=>intakeHandler(...args)。
  - runtimeCurrent 要求逐镜 shotExecutionFingerprint===hash(execution) 且 hash(shot.shotExecution)===hash(execution)，dialogueTurns 映射 {id:sourceDialogueId,speakerId,text} 一致。
  - 语义批次响应 schema（semantic-output-schema）要求 items[].events（minItems 1，字段 id/actorIds/offscreenActorIds/propIds/usesProduct/start/end/after/continuityActionIds/throughoutDialogueIds/recordedSpeech/descriptionEn/descriptionZh）；mock 缺 events → AGENT_EVIDENCE_PENDING 死循环。
  - 图片抽卡防重：IMAGE_DUPLICATE_START_WINDOW_MS=2000，重抽测试传 { allowDuplicateStart:true }；角色抽卡要求 project.characters[].assetRequired===true；道具图绑定要求 assetLibraries.props[].assetRequired===true。
  - WorkbenchWorkflow mock 构造（如 AgentHub replay 测试）：Object.assign(Object.create(AgentHub.prototype),{root,jobs,activeRequests:new Map(),stageStarts:new Map(),latestByStage:new Map(),...})。
  - promptReviewIsCurrent mock：promptReviewIsCurrent:(_p,state)=>state!=='approved'，否则 requestPromptReview 提前返回不设 automation。
  - 导演系统提示措辞已换：用 /导演结构化决定作者/ + /只执行指定目标镜的完整剧本/（旧 "writer has already directed this exact shot" 已删）。
  - 道具资产图措辞：写实资产图（旧"写实影视道具资产图"）；角色视频音频句已删 captions 字样（canonical-prompt-defaults.json 与 generation-template-defaults.js 双份都要改，generation-template-defaults 是覆盖层）。
  - 结构修复预算：intake 1 次 + 每轮 prepare 2 次反馈重试，耗尽抛 REPAIR_BUDGET_EXHAUSTED → salvage 到本地 repair（stage=shot_screenplay_repair，allowedShotIds 可用 scopeExtensions 扩）。mock 坏稿时 structure 总调用 3 次。
  - 剧本修复交付：patch 合并后必须过 issues()（sceneId 存在、visible actors ⊆ characterIds 等都要同时修）。

## 22:55 追加（下一批诊断线索，均未修）
- 全量 90 失败 / ~45 文件。screenplay-lifecycle 已修（4→0，提交 9f15b0e）：延期审核断言 = stages==[] + contentReview.status==='deferred'；commerce 规则断言改为 WRITER_RULES.includes(prompts.rule('commerce'))。
- shot-screenplay test 13/14（拆分/合并修复机制）：review→issues→repair 的 author() 内循环已随延期审核废弃；需确认确认页修复流的新入口（reviewFeedback 参数存在但 workflow 侧无调用方）再重写，勿机械改。
- staged-upload-preparation 2/6/9：checkpoint 重校验/溢出上抛/前缀复用，需读 prepare 断点逻辑。
- stability-shared-contract 3：/restrained calm, suppression and silence may be intentional/ 措辞已变，按现行表演政策文本对齐；6：deferred 全局编译+pending 状态。
- script-format-no-deadline 1/4：assert.rejects 未抛（格式确认门槛行为变化），需定位现行为；7：renderer scriptFormatDialog id 变了。
- product-claim-authority 1/2/3：author/review/repair 链上的商品事实权威，mock 需按 draft/structure 新阶段重写后重验。
- agent-stage-routing 7：文案改为「所选后期来源 grokbuild 未完成音效匹配（7 镜待补）…」可对齐；14/23 需读规则装配。
- manual-entry-fast-script 5：PROMPT_REVIEW_REQUIRED 新门槛（确认页拦截提交）——测试需先 confirmAllPromptReview；12：TEXT_MODEL_REQUIRED（设置需补文本模型名）；13：并发锁断言。

## 00:30 追加（主会话第二轮，90→76）
- 本轮已修：stability-shared-contract(3→0，app真缺陷：performanceTimelineFailures 不再把规划器自己产出的编辑性留白判死) 、source-performance-budget(2→0，v8-editorial-advisory 语义：溢出=advisory 而非 issue)、staged-upload-preparation(3→0，app修复：管线用 budgetOverflowIssues() 把 v8 advisory 重新升级为阻塞 issue——reusablePrefix/rebasePart/断点重校验/新鲜结果四处)、uploaded-dialogue-ledger(1→0，app实现 reanalyze_dialogue 本地账本修复分支于 agent-analysis-entry) 、script-format-no-deadline(3→0，**app被掏空的门全部从 ad3c245 恢复**：assertAiScriptFormatConfirmed、renderer scriptFormatDialog 模态、ensureScriptFormatBeforeWriting、事件接线、projectScriptFormat 摘要行——遇"函数变 return 常量"先查 ad3c245/8abf5bf)、agent-stage-routing(3→0，SFX 新文案、防倾倒阈值 0.75/30000、skipChronology:true 用于批量复用测试)。
- **h3-director-payload-causality 未修（下一批优先）**：编译器自超限 65 字符（10065/10000），探针 .codex_work/probe-h3-payload.js 可直接分段测量；且测试断言短语（"Only <Subject 1> (S1) moves the lips for this line"、"cut to <Subject N>'s established visible speaking face…" 等在现行 agent-director.js 中不存在——test 1/2/3 的全部文案断言需按现行 v25 编译器逐条重新对齐，是整套重写不是机械改名。subject_definitions/summary/retention/detailed_description/overall_soundscape 分段结构未变。
- 剩余 ~76 失败清单：.codex_work/test-results.txt。同模式可复用：manual-entry-fast-script(5=PROMPT_REVIEW_REQUIRED 先 confirmAllPromptReview；12=TEXT_MODEL_REQUIRED 补文本模型；13=并发锁)、product-claim-authority(按 draft/structure 重写 mock)、screenplay-source-recovery/source-finding-verification/script-review-evidence-214(语义审核延期到确认页)。

## 00:50 追加
- manual-entry-fast-script 已修（3→0，提交见 git log）：test5 夹具 item 补 userConfirmed:true（T03 回执语义）；test12 mock workflow.analyzeScript 隔离分析边界（compilePromptReviewBundle 对 !runtimeCurrent 项目强制 forceReanalysis 重入是设计行为）；test13 把 B 操作改为 pending gate（单飞 Promise.resolve().then 延迟注册，瞬时完成会让 hasActiveOperation 观察不到）。
- product-claim-authority (3) 未修，需整套重写：author 干净稿 draft(user keys: mode,source,topic,product,runtimePolicy)/structure(mode,screenplay) 载荷已无 productClaimAuthority 包、系统提示也不含 authority.INSTRUCTION。权威包现挂在确认页链：screenplay-review-partitions.js:16,40（UNIT_SCOPE 系统）+ screenplay-repair-delivery.js:62（recoveryKey 含 productClaimAuthority）。重写思路：直接驱动分区审核+修复交付函数，mock 审核给出 badAdvice（清热益气），断言修复请求载荷带 authority.packet(product) 且系统含 INSTRUCTION，修复结果不得采用越权功效台词。
