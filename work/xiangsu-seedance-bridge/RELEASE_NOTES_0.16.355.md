# 0.16.355 — 任务接入去重与补交终态

修复任务接入层的重复启动、补交恢复无限循环，以及界面把「Agent 已结束」和「应用仍在补交」混成同一个状态的问题。

0.16.354 构建过程中发现该版本自身引入了两处回归，已定位并修复后重新出包，**请使用 0.16.355，不要使用 0.16.354 的安装包**。

## 一、同一项目同一阶段被重复启动

### 实测证据

从本机 `运行数据/user-data/workbench/agent-jobs` 的 76 条任务记录中筛出 4 个项目、共 12 处相邻重复启动（间隔 0.19–0.45 秒）：

| 项目 | 阶段 | 连启次数 | 相邻间隔 |
| --- | --- | --- | --- |
| project_mu2g7jux_872e66e0 | master_production_decisions | 4 | 246 / 233 / 236 ms |
| project_mu2koi7h_3c8593db | master_production_decisions | 4 | 225 / 231 / 235 ms |
| project_mu2u6fde_be48d4c3 | master_production_decisions | 4 | 196 / 189 / 197 ms |
| project_mu3jpj5t_f2b858d7 | master_production_decisions | 4 | 285 / 279 / 310 ms |

逐条比对请求正文后发现关键事实：**同一组内 4 次启动携带的镜头集合完全相同**（分别为 42、47、54、42 镜，即整片镜头），属于同一逻辑轮次被重复付费，不是不同批次。

同时确认了**不能按阶段名去重**：`asset_execution_prompt` 在 0.43 秒内启动 4 次，但 4 份请求正文长度为 70576 / 61515 / 64149 / 51387，是 4 个不同资产，各自必须独立出图；`master_production_decisions` 本身也支持按镜头子集并发（`parallelism` 最多 4 个任务同时运行）。

### 根因

`AgentHub.run` 的去重以 `options.sessionId` 为必要条件。上述生产阶段不传 `sessionId`，直接走到 `runFresh`，整套去重被跳过：既没有并发合并，也没有窗口内拒绝，于是同一逻辑轮次被启动了 4 次，各自跑完并各自计费。

### 修复

- 准入身份 = 模态 + Agent + 项目 + 阶段 + **该次逻辑调用的身份**，不依赖 `sessionId`，也不含请求正文（重复触发时正文会因读回刚保存的部分结果而略有不同，按正文指纹永远命中不了）。
- 逻辑调用身份由调用方显式声明：
  - 主编排阶段声明**镜头集合**（`dedupeShotIds`），集合相同（与顺序无关）即同一轮次 → 折叠；镜头子集不同即并行批次 → 各自独立。
  - 资产提示词阶段声明**批次条目集合**（`dedupeIds`）。
  - 抽卡阶段声明**资产**（`dedupeScope`，沿用 0.16.354 的图片准入）。
- 同阶段仍在运行时，后续调用**合并**到同一次调用，只产生一个 Agent 进程。
- 同阶段 2 秒窗口内已结束且已有可复用产物时直接复用已保存结果；没有可复用产物则**拒绝**并报出原有任务号（`LOCAL_AGENT_DUPLICATE_START`），不新建进程。
- **未声明身份的调用一律不折叠**，行为与修复前完全一致。身份必须由调用方声明，因为接入层无法区分「同一单例阶段被重复启动」和「合法的按资产/按批次并发」；猜错要么让一个轮次付 4 次费，要么静默丢掉 3 个批次。
- 窗口外的正常重跑、不同资产、不同镜头批次、不同阶段均不受影响；`allowDuplicateStart` 为显式重抽留出口。
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

## 四、构建过程中发现并修复的自引入回归

0.16.354 的首个构建产物不对外交付，原因如下（保留记录以便追溯）：

- **回归 A：`AgentHub.run` 丢失了入口守卫。** 原实现只在 `modality==='text' && options.sessionId` 时启用请求指纹复用，改写时被删掉，导致无 `sessionId` 的调用也会拿历史任务做重放：`agent-stage-routing` 的「四个阶段各自独立路由」拿不到新任务，`local-agent-integration` 的「准备失败不得留下无主任务」因请求指纹计算提前抛错而根本没建任务记录。
- **回归 B：准入身份一度按「项目单例阶段」白名单实现。** 复核真实证据后发现该阶段支持按镜头子集并发，白名单会把 3 个并行批次折叠成 1 个，造成丢镜头，已改为按实到镜头集合声明身份。
- 修复后 `agent-stage-routing` + `local-agent-integration` 由 42 通过 / 4 失败回到 **44 通过 / 2 失败**，与未改动基线完全一致——剩余 2 项为改动前既已存在的失败，与本次修复无关。

## 生图路由核查（未做改动）

排查「生图请求是否正常提交到 puream.cn」的结论：**代码路径与官网契约一致，未发现需要修复的缺陷；未提交到官网的原因是设置项本身。**

- `imageProvider.baseUrl` = `https://puream.cn`，生图走 `POST /api/ai/gpt-image-2/v1/images/generations`，轮询 `/api/ai/gpt-image-2/v1/tasks/{id}`，鉴权头 `Bearer <授权码>`，参考图字段 `reference_images`（与视频适配器同一字段）。
- 只读探测：`GET /api/ai/gpt-image-2/v1/tasks/*` 返回 401 `API_KEY_REQUIRED` 且 `billing_status:"not_charged"`，`GET .../images/generations` 返回 405（仅接受 POST）——路由真实存在且方法与代码一致。
- 真正原因是本机设置里 `localAgents.image = "codex"`，生图被路由到**本地 Codex Agent**，其任务说明原文为 "Do not … call PUREAM generation APIs"，因此官网后台不会有记录。全部 7 个项目的 `costLedger.entries` 为空、`candidates` 为 0，与该结论一致。
- **未验证项**：带授权码的真实出图会实际计费，本次未发起。需要验证时请把图片路由切回官网 API 后抽一张最小尺寸图。

## 验证

- 新增准入与补交回归测试 16 项（并发合并、窗口内复用、窗口内拒绝并报出原任务号、未声明身份不折叠、同一镜头集合与顺序无关、不同镜头批次不折叠、跨资产不折叠、lease 稳定、补交上限、终态携带 MCP 原因、阶段选项确实把身份传到接入层）全部通过。
- 既有 `agent-delivery-recovery` 9 项、`agent-activity` 4 项测试保持通过。
- 定向回归（接入层、阶段路由、补交、界面、图片路径共 20 个测试文件）与未改动基线逐项对齐，无新增失败。
- **未验证项**：真实付费生图、真实 MCP 补交超限场景未在本机复现；以上结论以代码、落盘任务记录与请求正文比对为准。真机跑一遍四连发阶段是最终确认手段。
