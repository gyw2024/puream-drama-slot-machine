# 纯梦短剧老虎机 0.16.0 正式发布证据

发布日期：2026-08-16

## 成片不可关闭的契约

- 参考视频没有人物介绍，系统也不得生成人物介绍、人物小传、故事简介、人物展示卡、身份锚图、人物四视图、资产板或参考板镜头。
- 人物图只是幕后身份锁定参考，第一帧必须是正在发生的剧情。
- 成片只保留剧中对白、现场环境声和同步动作声；强制禁止字幕、标题、可读文字、旁白和背景音乐。

## 源码与发布产物

- 桌面端源码提交：`711ef7c802839190cfafbba48660ee3291bdee72`
- 官网发布源提交：`2ed0789e501a69043e56327140d2949c2d54e2d1`
- 安装包：`D:\Backup\Documents\无限画布\纯梦短剧老虎机-安装版-0.16.0.exe`
- 官网下载：`https://puream.cn/api/drama-slot/download`
- 大小：`126649520` 字节
- SHA-256：`F70E28446CDF799FE81ECF0D1489341F2E6A2C9462C238C20AC589C23FF43C5A`
- Authenticode：`NotSigned`（本版未配置 Windows 代码签名证书）

## 正式环境

- 当前服务：`puream-workflow-full-api-r96-drama-release-0160-20260816.service`
- 内部端口：`3107`
- 服务状态：`active/running`，`NRestarts=0`
- Nginx：6 个正式入口全部切换到 3107，3106 引用为 0
- 旧 r95：`disabled/inactive`，完整服务文件与 Nginx 配置仍在备份中
- 回滚脚本：`/opt/puream-workflow-platform/.codex_backups/TASK-20260816-DRAMA-WALLET-005/pre-cutover-r95-20260816T0908Z/rollback-r96.sh`

## 验证结果

- 桌面端自动化回归：282/282 通过。
- 官网服务：20/20 测试通过，Next.js 正式构建通过，生产依赖审计 0 漏洞。
- 9/9 真实最短模式矩阵完成，0 个未解决失败；每个项目都生成最终视频，技术完整性、最终质量、音轨和视觉门禁全部通过。
- 矩阵不变量：`totalDeadlineMs=0`、字幕禁止、背景音乐禁止、人物介绍禁止、Simple/Agent 只共享资产库。
- 矩阵证据：`work\xiangsu-seedance-bridge\.codex_tests\TASK-20260815-DRAMA-SHORTEST-MATRIX-004\live-shortest-matrix\report.json`
- 人工视觉复核图：`work\xiangsu-seedance-bridge\.codex_tests\TASK-20260815-DRAMA-SHORTEST-MATRIX-004\final-contact-sheets-v6`
- 打包后 Agent UI 审查：`work\xiangsu-seedance-bridge\.codex_tests\TASK-20260815-DRAMA-SHORTEST-MATRIX-004\release-audit\packaged\2026-08-16T08-30-53-416Z`
- 打包后 Simple UI 审查：`work\xiangsu-seedance-bridge\.codex_tests\TASK-20260815-DRAMA-SHORTEST-MATRIX-004\release-audit\simple\2026-08-16T08-30-53-410Z`
- MCP 审查：33 个工具，版本 0.16.0；证据目录 `release-audit\mcp\2026-08-16T08-30-53-546Z`。
- 自定义安装位置验证通过，安装后产品版本 `0.16.0.0`。
- 安装版实时更新检查通过：当前版本与官网版本均为 0.16.0，下载地址、大小和 SHA-256 都与发布源一致。
- 公网 HTTPS 整包下载复验：大小与 SHA-256 和本地构建通过逐字节一致性检查。
- 升级兼容验证：18/18 现有项目可读，19/19 SQLite 状态可读，0 正在运行任务，53 个可复用图片均非空。
- 2.965 GiB 保存位置迁移验证：18 个项目、395/395 资产完整，旧路径引用为 0，原数据保留。

## 证据边界

- 已人工复核 9 个最终成片的联系表，确认从剧情画面开始，未见人物介绍、人物卡、资产板、字幕、黑屏或白边擦除。
- 本轮未对 9 支创意成片做 ASR 逐字转写，因此不把“最终音轨逐字对白精确度”写成已证实结论；对白原文、说话人、听者、语气、时间码和嘴型所有权已由不可变事实账本与自动化契约锁定。
