# 0.16.359 发布说明 — 修复"单镜视频提交被提示词确认死循环拦截"

## 现象

资产全部完成、57 条提示词已全部确认（弹窗也显示 57/57 已确认），点击"生成单镜视频"仍弹出"确认后续全部生成提示词"全量确认框；点"一键保存并确认全部"也无效，下次提交继续弹——死循环，视频永远提交不出去。

## 根因（两层叠加，均为逻辑冲突而非数据损坏）

1. **确认稿与提交清单口径断层**：用户 19:50 确认提示词时，参考清单还按旧口径枚举了 4 个无资产的沉默在场者（`shot-01` 为 Picture 1–10）；0.16.357 修复资格对齐后，提交清单只剩 7 图。提交门 `submission-agent-review.prepare` 检出 `referencesCurrent=false` 即抛 `PROMPT_CONFIRMATION_REQUIRED`。而"一键确认"只改确认状态、不重建清单，且 bundle 指纹完全一致（源稿/设置都没变）导致 bundle 永不重新编译——**确认多少次都出不去**。
2. **审核回执代际断层**：提交门要求 `agentAudit` 带 `requirementsVersion + promptSha256 + passed` 回执，该项目的确认项还是旧格式 `{status:'not_verified'}`（无哈希回执）。工作流自身判定"已批准"用的是 `approvedPromptReviewItem`（包版本+指纹+用户确认），两处口径不一致——即使引用清单完全一致，旧项目也永远被拦（12:20 的 shot-38~42 诊断记录三项全 true 仍被拦即是此因）。

## 修复

- `app/workbench-workflow.js`
  - 新增 `referenceManifestEligibilityAligned(project, shot, references)`：判定"确认清单与实际付费清单的差异**仅为**剔除当前资产资格排除的角色位（顺序不变、音频位不变）"。
  - `buildShotPrompt`：确认稿短路前先校验清单一致；若属资格对齐型漂移，改用 `renderApprovedVideoPrompt(project, shot, references)` **机械重编译**（同一份已批准剧情事实 + 实际清单，无模型调用、不改剧情/对白），保证 `<Picture N>` 绑定不错位。
- `app/submission-agent-review.js`
  - `referencesCurrent` 接受资格对齐型漂移；
  - 清单对齐时只接受"提交文本 === 同源重编译结果"（`promptRecompiledFromApprovedFacts`，写入回执留痕）；旧确认文本仍一律拒绝（其 Picture 绑定已失效）；
  - 审核判定统一为 `approvedPromptReviewItem` OR 完整回执（修复代际断层，老项目不再被砖）。

## 验证

- 新增 `scripts/submission-eligibility-realignment.test.js` 5/5：对齐放行、旧稿仍拦、越界漂移（缺场景图）仍拦、legacy 回执不砖、乱序/增位拒绝。
- 原有 `submission-agent-review.test.js` 5/5 保持通过（签名 URL 换址、内容/身份/策略变更拦截等语义不变）。
- 真实项目「新的带货漫剧·测试」shot-01 全链路模拟：10 图确认稿 → 7 图重编译稿（9627→8993 字符），提交门放行；shot-38~42 同路径受益。
- 回归：content-requirements-root 7/2、h3-director 2/3 均为存量失败（stash 基线一致），零新增失败。

## 说明

- 不修改任何已确认数据：确认稿原样保留，重编译发生在提交边界且可被"同源重渲染等价"校验证明，回执记录 `referencesAligned/promptRecompiledFromApprovedFacts` 供审计。
- 效果：37/42 个含沉默在场者的镜头无需任何重新确认即可直接提交视频；其余镜头行为不变。
