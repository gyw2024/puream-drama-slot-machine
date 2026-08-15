# v0.14.1 发布证据

任务：`TASK-20260815-MCP-CONTROL-BILLING-001`

## 交付物

- 安装包：`dist-fixed-0.14.1/纯梦短剧老虎机-安装版-0.14.1.exe`
- 交付副本：`D:/Backup/Documents/无限画布/纯梦短剧老虎机-安装版-0.14.1.exe`
- 大小：126,570,605 bytes（120.71 MiB）
- SHA-256：`CCE6B8DEBD454363DB9B5DEBFE91C528E7128BF6839084F3D6908B073086450A`
- Windows Authenticode：`NotSigned`（未伪装为已签名）

## 自动验证

- 全量 Node 回归：198/198 通过。
- 本轮核心回归：通过。
- 12 个关键 JavaScript 文件语法检查：通过。
- 生产依赖 `npm audit`：0 个已知漏洞。
- 安装包标准 MCP 实测：v0.14.1，33 个工具，3 个资源，1 个提示模板；真实授权回报图片并发 32、视频并发 16，权威来源 `drama-admin`。桌面已运行连接与桌面未运行自动拉起两条路径均通过。
- 安装包 UI 全量审计：全部页面和主要弹窗通过；1024×720、1280×800、1440×900、1920×1080 与 200% 缩放无关键布局失败；Axe critical/serious 为 0；DOM 空白图片为 0；SQLite quick check 通过。
- 三份完整约七分钟剧本案例长度分别为 10,084、6,903、9,613 字符，预览与 TXT 下载均通过。
- 中文路径资产通过安全协议解码，实测图片宽度 1024。

## 针对本轮反馈的交互验证

隔离生产态中模拟管理后台视频并发 16：

- 3 个人物视频同时显示“生成中”，第 4 个场景资产显示“排队中”。
- 右侧运行详情同步显示 3 个活跃任务，而不是固定只跑 2 个。
- 顶部状态只显示 `第 2/6 阶段 · 资产`，完成阶段数为 1。
- 文案费显示 `预估¥0.03`，实际合计保持 `已结¥0.00`。
- 逐秒合图提示词弹窗在 12 次实时轮询后仍保持打开，未保存文本、焦点和选区均未变化。
- 6 张中文路径图片全部完成解码；加载、排队和失败状态具备独立视觉反馈。
- 减少动态效果模式和 200% 缩放均通过；Axe critical/serious 为 0。

证据目录：

- `.codex_tests/TASK-20260815-MCP-CONTROL-BILLING-001/ui-regression/2026-08-15T01-20-54-776Z`
- `.codex_tests/TASK-20260815-MCP-CONTROL-BILLING-001/packaged-ui-release/2026-08-15T01-31-08-376Z`
- `.codex_tests/TASK-20260815-MCP-CONTROL-BILLING-001/packaged-mcp-release/2026-08-15T01-39-27-073Z`
- `.codex_tests/TASK-20260815-MCP-CONTROL-BILLING-001/packaged-mcp-autolaunch/2026-08-15T01-39-27-076Z`

## 升级保护

- 原版本完整备份：`D:/Backup/Documents/无限画布/纯梦短剧老虎机_完整备份_0.13.46_20260815_025022_TASK-20260815-DRAMA-FOUNDRY-V2-001`
- 本轮修改前基线：`D:/Backup/Documents/无限画布/纯梦短剧老虎机/.codex_backups/baselines/TASK-20260815-MCP-CONTROL-BILLING-001`
- v0.14.1 完整发布快照：`D:/Backup/Documents/无限画布/纯梦短剧老虎机/.codex_backups/releases/TASK-20260815-MCP-CONTROL-BILLING-001/source-v0.14.1-20260815_093637`（1,877 个文件，9,261,188,934 bytes）
- 安装包归档：`D:/Backup/Documents/无限画布/纯梦短剧老虎机/.codex_backups/releases/TASK-20260815-MCP-CONTROL-BILLING-001/artifacts/纯梦短剧老虎机-安装版-0.14.1-final.exe`；首次构建的自动拉起修复前副本也已单独保留。
- 当前安装版仍为 v0.14.0，未被本轮验证关闭或覆盖。现有数据中仍有 4 条 `remote_pending` 恢复记录（《弟弟藏起的借条》C01/C02/C03 人物视频和《妈的保温箱》S22 分镜视频），因此安装 v0.14.1 延后到这些记录安全处理后。
