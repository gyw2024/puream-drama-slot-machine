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
| BUG-015 | 已准备三种剧本示例，但历史项目和上传剧本用户看不到 | 示例入口只存在于首次 AI 写作格式弹窗，弹窗确认后不再出现 | 0.13.30 | `script-format-no-deadline-regression.test.js`、打包态与安装态审计 | 已验证 |
| BUG-016 | 软件内充值门槛与运营要求不一致 | 桌面端直接沿用了官网 30 元最低充值规则 | 0.13.30 | `wallet-recharge-contract.test.js`、充值弹窗打包态与安装态审计 | 已验证 |
| BUG-017 | 写文案运行一小时后提示“应拆成 4 个生成单元，实际返回 0 个” | 文本请求没有截止时间；上传剧本拆镜并发超过官网两路上限；解析未兼容常见包裹层；上游返回说明文字时客户端重复请求后仍整阶段失败 | 0.13.31 | `direct-fast-script.test.js`、`uploaded-analysis-resume-regression.test.js`、`uploaded-script-local-fallback.test.js`、全量测试、打包态与安装态审计 | 已验证 |
| BUG-018 | 5–10 分钟 AI 剧本写作无法稳定在 10 分钟内完成 | 全剧骨架后只以单路顺序写 5 镜小段，单个异常段会阻断全剧，缺少本地生产合同保底 | 0.13.31 | 5/10 分钟全剧本地编译、H3 双说话人、商品后置及参考片硬审计回归 | 已验证 |
| BUG-019 | 8 分钟简短模式写作慢、蓝图全开会与生成提示互相冲突，异常时仍可能停在失败页 | 生成、参考片、蓝图和本地审计存在四套冲突对白指标；选题会二次请求且无本地候选；完整短句曾被按字符截断；海螺说话人分配会把双人攻防的听者误判为静默人物 | 0.13.32 | `eight-minute-simple-sla.test.js`、`direct-fast-script.test.js`、`quality-blueprint-details.test.js`、全量 120 项、打包态与安装态审计 | 已验证 |
| BUG-020 | 最新版看不到多种剧本模式，点击 AI 写剧本也没有弹出选择 | 剧本模式只在写作入口的临时弹窗确认，没有纳入项目制作策略；历史项目还可能沿用未确认状态 | 0.13.33 | `mode-strategy-audit-and-provider-regression.test.js`、打包态与安装态 UI 审计 | 已验证 |
| BUG-021 | 没有设置审核蓝图时仍出现审核拦截或启动瞬间显示开启 | 后端默认配置、历史配置归一化和 HTML 初始勾选值不是同一套显式启用语义 | 0.13.33 | `quality-blueprint-gate.test.js`、`mode-strategy-audit-and-provider-regression.test.js`、打包态与安装态 UI 审计 | 已验证 |
| BUG-022 | 人物视频提示缺少正脸并整条资产链失败；AutoDL 隔离后其余资产和分镜也被阻断 | 人物视频依赖没有按本地像塑/云端 H3 模式分层；独立人物图缺失时直接终止；远端暂停被误记为整批失败 | 0.13.33 | `mode-strategy-audit-and-provider-regression.test.js`、视频供应商矩阵、20 秒最短链路矩阵 | 已验证 |
| BUG-023 | 官网与余额正常，但桌面偶发“文本模型连接失败” | Electron 在收到 HTTP 响应前会偶发抛出 `net::ERR_FAILED`，旧恢复器只识别 `ERR_EMPTY_RESPONSE`，没有按同一幂等号切换网络栈恢复 | 0.13.33 | `text-recovery-regression.test.js`、生产余额双网络栈探针、生产文本最小探针 | 已验证 |

## 维护规则

- 每个修复都递增最小单元版本号。
- 不删除历史条目；复发时在原编号追加复发版本和新根因。
- 官网钱包是余额、冻结金额、充值订单与到账状态的唯一权威，桌面端不维护独立余额。
- “已验证”必须同时具备源码回归用例和打包后检查；涉及官网的条目还必须保留线上或候选接口验证结果。
