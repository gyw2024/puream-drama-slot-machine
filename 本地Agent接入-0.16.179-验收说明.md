# 本地 Agent 接入 0.16.179 验收

任务：TASK-20260905-DRAMA-LOCAL-AGENTS-178。范围为上一轮 WorkBuddy / Grok Build 接入与发布收尾；本机升级，不是官网发布。

## 已修复的根因

1. 版本号与输出目录分开维护，命令行目录覆盖掩盖了旧配置。新增 npm version 生命周期同步目录，并在实际打包前校验 package、lockfile 和输出目录。保留原有测试，并新增旧目录复现测试。
2. WorkBuddy 原先只有 MCP 领任务模式，漏掉安装包内 WorkBuddy 专用运行入口。现有原生入口使用安装包自身 product 配置及 WorkBuddy 账号，未伪装成其他品牌，也不复制密钥。
3. WorkBuddy 的 --max-turns 1 会随机截断内部处理。复测日志确认 Max turns (1) exceeded；已移除该限制，保留超时、禁用工具、无桌面控制与禁止 API 自动回退。
4. Grok 的实际启动与任务接收等待超过早期验收的短超时。实测约 74 秒，验收使用 180 秒，软件原有默认任务超时 600 秒保留。

## 最终证据

- 全量 1,021 项：1,020 通过，0 失败，1 跳过。
- 0.16.179 打包 ASAR 实际写作：WorkBuddy 33,679 ms、Grok 73,772 ms；两句中文对白、标点、顺序与 C02/C01 归属均与指定 JSON 完全一致。
- 已安装并重启 0.16.179；MCP 41 个工具握手通过；56 项目、0 运行中生产任务。
- 安装 ASAR 与构建 ASAR SHA-256 一致：51863c0630712c3af9f22a6cc3b0035994263829f4c7c0746fb3a8a530faa14f。
- 安装包 SHA-256：d993a29a71c6ad1945a5b0557c3fb32075937690c1827ee54208740e6cd4d45d。
- 本次配置界面在 Codex 内置浏览器隔离环境检查；无效路径、MCP 待连接、保存、1280/1920 宽度及缩放检查已留 JSON。不是 native GUI 自动化验收，未重测全部旧页面。

## 数据与边界

安装前后清单均 2,930 个文件，新增/删除均为 0，项目媒体文件未变化。严格字节比较发现 10 个变化：LevelDB 日志、SQLite WAL/SHM、两工作区 settings 及滚动备份；不能称所有配置字节不变。两数据库完整性检查通过。任务开始时项目数为 55，安装前已经是 56，未删除新项目。

本次仅实测文本，不生成图片或视频。WorkBuddy / Grok 生图仍要求接入具备真实生图工具的 MCP 工作端，不应把文本验收当成完整资产生图验收。Antigravity / Codex / DeepSeek 保留上一轮接入；未在本轮重复付费测试。

源码目录存在大量其他未提交变更，本轮未将它们一起提交。未改官网、云端并发、用户分镜和成片。

## 位置与恢复

- 安装包：work/xiangsu-seedance-bridge/dist-fixed-0.16.179/纯梦短剧老虎机-安装版-0.16.179.exe。
- 验收证据：.codex_tests/TASK-20260905-DRAMA-LOCAL-AGENTS-178。
- 任务基线：.codex_backups/TASK-20260905-DRAMA-LOCAL-AGENTS-178/baseline。
- 已验证源码备份：.codex_backups/TASK-20260905-DRAMA-LOCAL-AGENTS-178/verified-0.16.179。
- 必要时可重装保留的 dist-fixed-0.16.176 安装包回退；不要单独替换受完整性校验保护的 ASAR，不覆盖项目数据库。

使用：系统设置 → 本地 AI 工作软件 → 选择写作来源。WorkBuddy 选“WorkBuddy 安装包原生入口”；Grok Build 选“官方非交互 CLI”。保存设置，模型留空沿用对应 Agent 的设置。
