# 本地 Agent 接入升级 0.16.176

任务：TASK-20260905-DRAMA-LOCAL-AGENTS-176。开始 2026-09-05 18:37:22，北京时间；授权截止 19:37:22。

## 实际交付

已经安装并启动 0.16.176。安装版 MCP 握手通过，41 个工具，55 个原有项目，当前生产运行数 0。安装 ASAR 与构建 ASAR 哈希相同。

系统设置新增“本地 AI 工作软件”。写作与生图独立选择：软件原 API、WorkBuddy、Antigravity、Codex、DeepSeek Harness、Grok Build。原 API 配置和用户选择不会被静默覆盖；Agent 失败不会自动改用 API。外部 Agent 使用自身账号额度，不等于免费。

完整工作区继续按原阶段提交选题、编剧、拆解和提示词任务，视频提示词保留每批最多 5 镜的工作规则。直传参考图、首尾帧、分镜合图等通过同一个文本/图片入口接入。简易模式原本不包含 AI 编剧，所以写作选项明确禁用并解释；图片来源可以独立选择。

Agent 图片沿用原图片候选、确认与入库链路，传递原参考图身份/顺序、尺寸和画幅，不额外压缩为中转 API 联系表。必须回传任务目录内可解码的真实 PNG/JPEG/WebP 文件；文字、伪造文件头、越界文件和迟到结果不入库。工具能力声明、图片文件有效、图片内容质量是不同验收层次，不能互相替代。

## 五个接入的实际状态

| Agent | 已完成 | 仍需注意 |
|---|---|---|
| Codex | 官方 exec 写作调用真实返回 LOCAL_AGENT_OK；MCP 配置已加入 | 生图须在具备 imagegen 工具的 Codex 会话执行接管指令；没有把 CLI 看图能力当作生图能力 |
| Antigravity | 官方 CLI 1.1.27 已下载并通过官方 SHA-512 核对；真实文本调用成功；桌面和 CLI MCP 配置已加入 | 官方 generate_image 已适配，但本次没有实发图片生成 |
| DeepSeek Harness | 在独立 Python 环境安装官方 SDK 及配套运行时；真实文本调用成功 | 在设置中的 Harness home 填 C:\Users\Administrator\.dsh，这是本次验证使用的已存在目录；未预设其具备生图能力 |
| WorkBuddy | 原 .mcp.json 中已加入短剧 MCP，其他连接器保留；任务领取/交付适配器完成 | 本次没有驱动 WorkBuddy 原生界面；需在 WorkBuddy 会话执行“复制接管指令”，工作端登记在线后才能处理提交任务 |
| Grok Build | 官方 CLI 已识别；MCP 已加入；写作和图像工作端协议已适配 | 两次受限文本验证分别在 60 秒、45 秒超时，尚不能宣称真实调用已连通；没有继续盲目重试或修改其账号 |

因此：客户端升级已完成，五家适配器已交付；并非五家账号、所有图片工具都已完成真实生成验收。尚未完成的是 WorkBuddy 活跃工作端接管、Grok 真实调用连通，以及各 Agent 的实际生图验收。

## 使用

1. 完整模式进入“系统设置 → 本地 AI 工作软件”；简易模式进入“更多 → 设置与连接”。分别选择写作和生图来源，再保存设置。
2. Codex、Antigravity 的文本入口可自动识别。DeepSeek 的 Python 环境也会自动识别，Harness home 填上表路径。
3. MCP 接管方式：在对应 Agent 重新加载 MCP 配置，执行该 Agent 卡片中的“复制接管指令”。必须由真实 Agent 登记自身身份和实际生图工具，不得用模拟工作端冒充连接成功。
4. 在短剧原有生产按钮提交。任务与取消可在设置面板查看。未连接、取消、超时均有明确状态；不会把进程退出当作素材交付，也不会自动重复生成。
5. 如需立即使用已验证写作入口，可选 Codex 或 Antigravity；图片可继续保留内置 API，或连接具备生图工具的 Agent 后切换。应用当前默认仍保留原 API，不替用户决定供应商。

## 验证证据和边界

- 全量测试：1,016 项，1,015 通过，0 失败，1 跳过。最终日志：`.codex_tests/TASK-20260905-DRAMA-LOCAL-AGENTS-176/full-tests-release2.log`。
- 真实 Electron 解码（无窗口）：完整测试栅格图通过，只有 PNG 文件头的伪图被拒绝。测试图明确为非 AI 生成样例。
- 内置浏览器验证真实源代码界面、隔离数据和模拟应用桥：完整/简易模式设置、来源保存与重载、未连接提示、1440/768/652 宽度及 200% 缩放；留有 axe 报告。不是对原生 Electron 窗口的 GUI 操作或验收。
- 真实安装版：stdio 初始化、tools/list、app_status 和两工作区 list_local_agents 均通过；安装文件与构建一致。
- 用户数据快照：2,928 个文件，没有新增/删除；项目素材工作区文件和两份 SQLite 数据库均保持原哈希，两份数据库 quick_check 都为 ok。发生哈希变化的是 drama-license.json 及滚动备份。当前与滚动备份的差异字段是 activatedAt、lastHeartbeatOkAt、tokenEnc、activationCodeEnc；不能声称全部配置字节零变化，也未输出任何凭证值。
- 此次没有提交真实图片或视频生成，也没有修改官网服务、云端并发、账单规则、原剧本或生成资产。

## 安装包与回滚

安装包：`work/xiangsu-seedance-bridge/dist-fixed-0.16.176/纯梦短剧老虎机-安装版-0.16.176.exe`

SHA-256：`4AE3121F0EBA40A04D58DE2DF0BB5777ED739562663C6BEA75BD000FACDA2EF1`

安装 ASAR：`41F86BAB230E1FE6BF6FFF875C2F7B125D889B1FB206E2BC2A71738810916A8D`

回滚备份位于 `.codex_backups/TASK-20260905-DRAMA-LOCAL-AGENTS-176/baseline`，包含修改前源代码和原 0.16.175 ASAR，以及修改前 Agent 配置。正常回退应使用原 0.16.175 安装包；不要单独替换 ASAR，Electron 可执行文件包含 ASAR 完整性信息。无须删除任何用户项目和资产。MCP 回滚只移除本次 puream-drama-workbench 配置段或恢复对应备份，保留其他服务。

新增的独立工具安装目录：`C:/Users/Administrator/AppData/Local/agy/bin` 和 `C:/Users/Administrator/AppData/Local/puream-agent-tools/deepseek-harness`。没有覆盖系统 Python、修改全局 PATH 或进行原生窗口自动化。

## 能力依据

- Antigravity 官方 CLI：[安装与授权](https://www.antigravity.google/docs/cli/install/)、[工具列表](https://www.antigravity.google/docs/sdk/tools/)。
- DeepSeek 官方：[Python SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)。
- WorkBuddy 官方：[MCP 连接器](https://open.workbuddy.cn/docs/connector)。MCP 客户端不等于可被外部自动调用的无界面模型服务。
- Grok 官方：[Build](https://docs.x.ai/build/overview)、[模式和命令](https://docs.x.ai/build/modes-and-commands)。交互式图像命令不被当作已验证的非交互生图接口。
