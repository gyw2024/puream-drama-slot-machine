# 纯梦短剧老虎机 Bug 台账

本台账记录已确认的用户问题、根因、首次修复版本和必须持续执行的回归检查。状态只有通过源码测试与安装包审计后才能标记为“已验证”。

| 编号 | 用户现象 | 根因 | 首次修复版本 | 回归检查 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | 一键生成选题被中止或 JSON 结构不匹配 | 中转返回包裹层与客户端严格结构解析不兼容 | 0.13.28 | `topic-relay-regression.test.js` | 已验证 |
| BUG-002 | 上传长剧本后解析、拆镜在 5 分钟停止 | 客户端存在固定文本期限且上游内容未分块 | 0.13.28 | `script-format-no-deadline-regression.test.js`、`uploaded-analysis-resume-regression.test.js` | 已验证 |
| BUG-003 | 审核蓝图关闭后仍编译、打回或拦截 | 审核开关只影响界面，未贯穿编译与返修入口 | 0.13.28 | `blueprint-off-global-bypass.test.js`、`blueprint-off-prompt-compiler-regression.test.js` | 已验证 |
| BUG-004 | 逐秒合图仍被尾帧或公网参考图拦截 | 模式矩阵复用了首尾帧连续性合同 | 0.13.27 | `twenty-second-full-matrix.test.js` | 已验证 |
| BUG-005 | 上一阶段结束后视频自动生成，按钮仍显示不可用 | 任务恢复与用户触发状态混用 | 0.13.27 | `adversarial-state.test.js` | 已验证 |
| BUG-006 | 手改分镜提示词后“再抽一次”没有运行 | 编辑态被蓝图校验与未提交弹层拦截 | 0.13.28 | `blueprint-off-global-bypass.test.js` | 已验证 |
| BUG-007 | 新建项目不能并行、切换项目卡死、历史项目无法删除 | 全局 busy 状态代替了项目级任务状态，删除缺少回收区 | 0.13.28 | `adversarial-state.test.js` | 已验证 |
| BUG-008 | 用户上传剧本却仍按设置时长强行改写 | 上传模式与 AI 全生成共用时长合同 | 0.13.28 | `duration-contract-regression.test.js` | 已验证 |
| BUG-009 | 人物资产库新项目为空 | 可复用资产被错误限定在当前项目 | 0.13.28 | `adversarial-state.test.js` | 已验证 |
| BUG-010 | 视频提示词缺少说话人、语气、听者和完整对白 | 提示词编译未把对白账本设为最高优先级 | 0.13.28 | `hailuo-prompt-contract.test.js`、`prompt-matrix-dialogue-regression.test.js` | 已验证 |
| BUG-011 | 长时间写剧本但文本扣费显示为 0 | SSE 结算回执没有同步到项目文案账本 | 0.13.28 | `timed-storyboard-prompt-cost-regression.test.js` | 已验证 |
| BUG-012 | 文本阶段显示上游原始 JSON/额度错误 | 服务端原始异常未经公开错误映射 | 0.13.28 | `topic-relay-regression.test.js` | 已验证 |
| BUG-013 | 充值后写剧本仍在约 5 分钟处显示连接失败 | 同项目同时发出 3 个大文本流；网络中断被标记为禁止重试且整阶段失败 | 0.13.29 | `text-recovery-regression.test.js`、`manual-entry-fast-script.test.js`、安装包审计、官网 r79 文本接口公网探针 | 已验证 |
| BUG-014 | 软件内无法查看官网余额或直接充值 | 桌面端未接入官网统一钱包与微信充值订单 | 0.13.29 | `wallet-recharge-contract.test.js`、官网钱包专项 4/4、官网 r79 余额接口公网探针、安装包审计 | 已验证 |

## 维护规则

- 每个修复都递增最小单元版本号。
- 不删除历史条目；复发时在原编号追加复发版本和新根因。
- 官网钱包是余额、冻结金额、充值订单与到账状态的唯一权威，桌面端不维护独立余额。
- “已验证”必须同时具备源码回归用例和打包后检查；涉及官网的条目还必须保留线上或候选接口验证结果。
