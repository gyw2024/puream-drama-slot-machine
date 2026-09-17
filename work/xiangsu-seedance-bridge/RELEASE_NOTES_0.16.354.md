# 0.16.354 — 任务接入去重与补交终态

修复任务接入层的重复启动、补交恢复无限循环，以及界面把「Agent 已结束」和「应用仍在补交」混成同一个状态的问题。

## 一、同一项目同一阶段被重复启动

生产日志实测：`master_production_decisions` 在 0.225 / 0.231 / 0.235 秒内被启动 4 次，`asset_execution_prompt` 在 0.44 秒内被启动 4 次，共 12 处；每次都是独立跑完并各自产生结果，等于 4 倍额度消耗。触发原因是阶段保存自己的检查点后又重新发起同阶段，而请求内容每次都不同（读取上一次刚保存的部分结果），所以按请求指纹去重永远命中不了。

根因：`AgentHub.run` 的去重以 `options.sessionId` 为必要条件，`master_production_decisions`、`asset_execution_prompt` 等阶段没有传 `sessionId`，直接走到 `runFresh`，整套去重被跳过。

- 准入身份改为「模态 + Agent + 项目 + 阶段 + 资产范围」，不再依赖 `sessionId`，也不含请求正文。
- 同阶段仍在运行时，后续调用**合并**到同一次调用，只产生一个 Agent 进程。
- 同阶段在 2 秒窗口内已结束且已有可复用产物时，直接复用已保存结果；没有可复用产物则**拒绝**并报出原有任务号，不新建进程。
- 窗口外的正常重跑、不同资产、不同阶段均不受影响；`allowDuplicateStart` 为显式重抽留出口。
- 图片接入层同样加准入（官网中转不经过本地 Agent 层）：同一资产并发抽卡只发一次付费请求；`lease` 身份去掉时间戳，改为「阶段+资产+提示词+生产修订」的稳定指纹，重试不会注册成新任务。
- 资产级范围键补齐了库资产抽卡原先传 `null` 的位置，避免同阶段多个库资产被误折叠。

## 二、补交恢复无限循环

`agent-delivery-recovery.js` 原本是 `while(!receipt)` 无上限循环。当 MCP 持续拒绝同一份提交时，任务永远停在 running，界面一直显示「正在保存结果」，用户看不到 MCP 的实际拒绝原因，也无法判断该重试还是该放弃。

- 补交次数上限 12 次，达到上限即抛终态错误 `LOCAL_AGENT_DELIVERY_RECOVERY_EXHAUSTED`。
- 每次补交记录结果、错误码与当时的 MCP 拒绝诊断；终态错误携带 `lastRejection`、`rejectionSummary` 与逐次尝试记录。
- 拒绝原因来自任务目录实际落盘的内容（`mcp-preview-draft.json` 的字段级 findings、提交次数、已保存分片、是否生成过 `mcp-result.json`），不是笼统的超时描述。
- 补交进程自身失败时同样附带 MCP 原因，并保持原错误码不被吞掉。
- 超限时写入 `delivery-recovery-report.json` 作为证据，`job.deliveryRecovery` 置为 `exhausted`，任务进入 `failed` 终态；已保存草稿与分片全部保留。

## 三、界面状态分离

- `job.agentTurnEndedAt` 与 `job.deliveryRecovery` 分开记录「外部 Agent 这一轮」和「应用侧 MCP 提交」两个阶段。
- 阶段卡片分别显示：Agent 调用已结束（含结束时刻）／应用补交中（第 N/12 次）／补交已达上限失败（附 MCP 拒绝原因）。
- 补交中的文案由「正在保存结果」改为「Agent 已结束；应用正在补交同一任务的 MCP 结果」，不再让已结束的 Agent 看起来还在思考。

## 生图路由核查（未做改动）

排查「生图请求是否正常提交到 puream.cn」的结论：**代码路径与官网契约一致，未发现需要修复的缺陷；未提交到官网的原因是设置项本身。**

- `imageProvider.baseUrl` = `https://puream.cn`，生图走 `POST /api/ai/gpt-image-2/v1/images/generations`，轮询 `/api/ai/gpt-image-2/v1/tasks/{id}`，鉴权头 `Bearer <授权码>`，参考图字段 `reference_images`（与视频适配器同一字段）。
- 只读探测：`GET /api/ai/gpt-image-2/v1/tasks/*` 返回 401 `API_KEY_REQUIRED` 且 `billing_status:"not_charged"`，`GET .../images/generations` 返回 405（仅接受 POST）——路由真实存在且方法与代码一致。
- 真正原因是本机设置里 `localAgents.image = "codex"`，生图被路由到**本地 Codex Agent**，其任务说明原文为 "Do not … call PUREAM generation APIs"，因此官网后台不会有记录。全部 7 个项目的 `costLedger.entries` 为空、`candidates` 为 0，与该结论一致。
- **未验证项**：带授权码的真实出图会实际计费，本次未发起。需要验证时请把图片路由切回官网 API 后抽一张最小尺寸图。

验证：新增 12 项准入回归测试（并发合并、窗口拒绝、跨资产不折叠、lease 稳定、补交上限、终态携带 MCP 原因）全部通过；既有 `agent-delivery-recovery` 9 项、`agent-activity` 4 项测试保持通过。真实付费生图与真实 MCP 补交超限场景未在本机复现，以上结论以代码与落盘证据为准。
