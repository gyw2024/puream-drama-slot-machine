# 资产生成前 AI 入口离线审计（2026-09-03）

> 复验状态：下文两项第一轮缺口均已从源头修复；空壳选题现被写作入口门禁拦截，所有最终 Sxx 已统一为 1–2 句完整对白并补齐逐句表演时长。最终组合回归 86/86 通过，详见 `audits/PREASSET-ALL-MODES-OFFLINE-AUDIT-20260903.md`。

范围：AI 选题、AI 写完整剧本、用户上传剧本三条入口。未调用短剧老虎机任何文本、图片、视频、语音上游；未运行 `live`、`real`、`paid`、资产生成或视频生成脚本。

## 结果

- 既有离线回归：134/134 通过。
- 新增跨入口质量合同：2/4 通过，2/4 失败。
- 合计：136/138 通过，2 项源头合同缺口待修复。
- 上传剧本：逐字对白、说话人、场景出现顺序、动作事件、30 秒自适应时长均通过。
- 完整合格选题：10 个去重选题、0–8 秒钩子、关系冲突/失败代价、商品因果桥和表演/站位提示均通过。

## 失败 1：空壳选题可以进入写剧本

证据：

- `app/workbench-workflow.js:613-668` 的 `normalizeTopicOptions` 只用标题和三个亮点决定卡片是否有效；`hook`、`logline`、`reversal`、`emotionalPayoff`、`productPlacement` 可全部为空。
- `app/workbench-workflow.js:9903-9912` 的 `ideaScriptBootstrapGaps` 只检查存在选题、已选择、商品就绪，未检查选中题的因果字段。
- 离线 fixture 证明：只有标题、关系和三个占位亮点的卡片可被标准化，选中后 bootstrap gaps 为零。

根因：恢复/部分结果的“保留已付费文本”策略与“允许进入下一阶段”共用了同一个有效态，没有把“可展示”和“可写作”拆开。

最小修复：卡片仍可保留展示，但写作启动前增加 `selectedTopicCausalGaps`；至少要求 `hook + logline + reversal + emotionalPayoff`，带货模式再要求 `productPlacement`，不完整卡片不得进入完整剧本生成。

## 失败 2：对白/时长源头合同互相矛盾

证据：

- `app/direct-fast-script.js:315` 明示语义单元允许“0句”。
- `app/direct-fast-script.js:679` 明示商品整体镜 `d` 为空；`:851` 可直接生成空对白单元。
- `scripts/direct-fast-script.test.js:135` 和 `:834` 还把独立静默镜作为通过结果。
- `app/workbench-workflow.js:13209`、`:19867`、`:20077` 允许上传标准稿保留整段“无对白”。
- 与此同时，`app/workbench-workflow.js:7589-7601` 的最终门禁禁止 `DIALOGUE_TABLE_EMPTY`。
- 运行时旧回退 `app/workbench-workflow.js:17930-17943` 使用 `buildDirectFastFallbackSegment`；该回退的对白没有逐句 `plannedSpeechSeconds`，物化后为 0。

根因：语义调度、上传标准化、旧回退与最终生成单元使用了不同对白定义；静默“内部子镜”被错误等同为静默“最终 Sxx”，旧回退也绕过了逐句试演秒数。

最小修复：所有最终 `Sxx` 在源头固定 1–2 句完整对白；商品、反应、入场、物证特写只允许成为相邻有对白 `Sxx` 内部 subshot。旧回退改走带逐句秒数的 `buildDirectFastFallbackSemanticUnit`，或为每句填入正常语速计算和动作留白后再物化。

## 运行命令

```text
node --test scripts/direct-fast-script.test.js scripts/dialogue-boundary-and-approved-video-prompt.test.js scripts/uploaded-script-parser-hardening.test.js scripts/uploaded-script-local-fallback.test.js scripts/drama-mode-three-layer-regression.test.js scripts/duration-contract-regression.test.js
node --test scripts/topic-relay-regression.test.js scripts/text-stage-sla-regression.test.js scripts/script-format-no-deadline-regression.test.js
node --test scripts/offline-ai-entry-preasset-audit.test.js
```

专用测试在载入业务模块前将 `global.fetch` 替换为硬失败哨兵，并在 teardown 断言调用数为 0。说明：最初误用过一次 `npm exec`，npm 可能查询了开发工具 registry；之后所有审计均直接使用系统 `node`。这不涉及应用上游、资产生成或付费任务，因此准确边界是“0 应用上游、0 资产生成”，不是整台进程绝对零网络。
