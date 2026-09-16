# 短剧老虎机全模式资产生成前离线审计（2026-09-03）

> 复验状态：下文记录的是第一轮缺口发现。两项根因均已修复；混合语言残句防御与 continuation 换场重置已通过最终组合回归。最终结论以 `audits/PREASSET-ALL-MODES-OFFLINE-AUDIT-20260903.md` 为准。

## 范围与安全边界

- 真实模式来源：`app/production-mode-matrix.js` 与 `app/renderer/workbench.html`。
- 模式：`production_package`、`asset_direct`、`keyframe`、`continuation`、`smart`、`storyboard_sheet`。
- 只运行本地纯函数、fixture、mock 和 Node 回归；未调用文本供应商、图片、视频、语音、OSS 上传或付费上游。
- 新增审计：`scripts/preasset-all-production-modes-offline-audit.test.js`。
- 审计对象：模式帧策略、人物/场景/核心道具提示词、首帧、尾帧、逐秒分镜合图、最终 H3 英文视频提示词、中文核对稿和引用清单。

## 代表性正向矩阵

| 模式 | 资产提示词 | 首帧 | 尾帧 | 合图 | 上一镜视频 | H3 视频合同 |
|---|---:|---:|---:|---:|---:|---:|
| production_package | 跳过，锁包内资产 | 跳过 | 跳过 | 跳过 | 禁止 | 通过 |
| asset_direct | 人物正脸、16:9 场景四视图、核心道具 | 跳过 | 跳过 | 跳过 | 禁止 | 通过 |
| keyframe | 人物四视图、16:9 场景四视图、核心道具 | 每镜 | 每镜 | 无 | 禁止 | 通过 |
| continuation | 同上 | 首镜/真实换场 | 每镜 | 无 | 仅同场第 2 镜起 | 通过 |
| smart | 同上 | 首镜/真实换场 | 每镜 | 无 | 同场连续镜 | 通过 |
| storyboard_sheet | 同上 | 无 | 无 | 每镜 1 张、每秒 1 格 | 禁止 | 通过 |

13 个正向检查均通过，验证内容包括：

- 每个生成单元两句完整对白，原文各出现一次、说话人不互换、无参考音频。
- 对白行严格按对白 30%、语气 25%、情绪 20%、动作 15%、站位/朝向 10% 的顺序编译。
- 每句有独立时间窗，时间窗不重叠，按字符与标点预算可读完，首句前保留闭口建位窗，末句后保留闭口尾窗。
- 明确音高、音量、语速、停顿、重音、气息、表情弧、肢体动作、听者闭口反应、左右/前后站位、朝向和视线。
- 换说话人同时切换机位与嘴型；保持 180 度轴线；禁止凭空入场、分身、字幕、额外人声、杂音、复读和回声。
- 商品由命名人物在剧情空间内持有；细节镜必须从同一只手上的同一包装切入并返回同一持有人；禁止脱离剧情的全屏商品静图。
- 场景资产提示词固定一张 16:9、2×2、同空间四视图；分镜帧固定 9:16；逐秒合图固定每格完整 9:16、时间顺序、无文字。
- 最终 H3 提示词通过官方结构、最终输出锁、中文仅位于 `<d>[Chinese] ...</d>` 与完整英文条款校验。
- mock 计数在每个模式结束后均为 `text=0, fetch=0, bridge=0, media=0`。

## 发现的根因级缺口

### P1：英文表演字段混入中文后会留下英文残句，现有终审未拦截

复现：把 `vocalArcEn` 设为 `low chest register, then hard stress on 救命钱`。当前编译器会删除中文，最终得到 `vocal arc is low chest register, then hard stress on.`。中文确实没有泄漏到对白标签外，但英文控制句已不完整；`assertHailuoFinalPromptIntegrity` 当前仍判定整体提示词有效。

对应离线回归：`mixed-language provider performance metadata cannot degrade into a dangling English control clause`，当前结果为失败。应在核心代码修复后让总计 14/14 通过。

建议根修：

1. 在语义字段入库时拒绝或完整替换含 CJK 的 `*En` 字段，而不是逐字删除。
2. 扩充完整英文片段检测，至少拦截 `stress on.`、`pause after ,`、`stress ... and.` 等悬空介词/并列词。
3. 修复后重新运行六模式矩阵，确保任何自动兜底仍是完整句，不允许静默截断。

### P1 风险：固定 continuation 模式跨场景仍引用上一镜视频

`resolveShotVideoStrategy` 对 continuation 的第 2 镜起一律返回上一镜视频 + 本镜尾帧，即使 `sceneId` 已改变。smart 模式会在真实换场切回首尾帧，continuation 不会。若用户在 continuation 模式的剧本中换场，当前合同可能同时要求“从上一镜最后状态无缝继续”和“进入另一空间”，存在空间变形、瞬移或错误入场风险。

建议根修：continuation 遇到真实换场时也采用本镜首帧+尾帧并停止引用上一镜视频，或在资产生成前明确阻止不带可见转场动作的跨场 continuation。

## 既有回归说明

- 一组既有提示词测试中有三个旧的精确秒点断言与当前自适应对白预算不一致；实际台词、动作和切镜仍存在，属于测试期望漂移，不能当作提示词内容丢失。
- 第二组既有测试中，资产直投中文核对稿的预期秒点为旧值 `1.3–5.1`，实际为重新计算后的 `1.2–4.5`；内容与说话人仍完整。
- 审计期间误把 `h3-three-mode-live-prompt-chain-runner.js` 当作 Node 测试入口；它在第一处 Electron `app.commandLine` 访问即退出，未创建窗口、未读取凭据、未上传素材、未提交任务。此文件不应纳入离线 test 命令。

## 可复现命令

```powershell
node --test scripts/preasset-all-production-modes-offline-audit.test.js
```

最终复验：14/14 通过；与生成前全链组合后为 86/86 通过。
