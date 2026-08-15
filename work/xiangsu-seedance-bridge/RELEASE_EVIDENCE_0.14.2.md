# 纯梦短剧老虎机 v0.14.2 正式发布证据

- 发布任务：`TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001`
- 发布日期：2026-08-15
- 缺陷编号：`BUG-072`
- 结论：桌面正式版、安装升级、真实数据兼容、MCP 控制入口及官网公开下载均已通过验收并发布。

## 根因与修复边界

海螺 H3 专用编译器已经在自己的 1900 字符预算内保留对白、说话人、表演和输出禁令，但统一视频提交层又对已编译文本执行一次通用压缩，并再次追加输出锁后从尾部截断。两个模块各自单测都能通过，组合后却会删除对白表演合同或无字幕/无背景音乐等硬约束。

v0.14.2 将长度预算的所有权收敛到供应商编译器：系统生成的海螺提示词在提交层只验证、不再改写；通用提示词压缩器先预留最终输出锁预算，检测到结构化对白合同时禁止盲截。若完整对白与机器硬约束确实无法同时装入供应商上限，系统会在计费提交前失败关闭。

## 源码与真实项目门禁

- `npm.cmd test`：202/202 通过。
- 定向组合回归：18/18 通过。
- `npm audit --omit=dev --audit-level=high`：0 个漏洞。
- `npm run verify:build-assets`：FFmpeg 与辅助程序哈希通过。
- JavaScript 语法检查、`git diff --check`：通过。
- 客户真实项目 `老屋门口的药费单`：30 个镜头。
  - 海螺编译：30/30 通过。
  - 最终提交对象：30/30 通过。
  - 最终输出锁：30/30 仅一份。
  - 对白、说话人、表演及音色绑定：30/30 保留。
  - 无字幕、无背景音乐、无人物介绍、无多视图资产板：30/30 保留。
  - 最终提交内容与供应商编译内容：30/30 字节一致。
- 真实项目组合证据：`.codex_tests/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/after-real-project-final-path-v2.json`。

## 界面、打包和升级门禁

- 源码界面回归：`.codex_tests/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/ui-regression/2026-08-15T02-29-21-230Z`。
  - 后台视频并发 16 生效，3 个候选任务可同时运行。
  - 分镜提示词编辑器连续 12 个轮询周期不自动关闭。
  - 阶段状态显示真实的“第 2/6 阶段·资产运行中”。
  - 文案待结算与已结算分开显示；图片卡有明确加载状态。
  - 200% 缩放与减少动态效果通过；axe 严重/致命问题为 0。
- 打包态界面：`.codex_tests/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/packaged-ui-final/2026-08-15T02-32-33-708Z`。
  - 7 个阶段、7 个弹窗、5 组窗口/缩放矩阵通过。
  - 三种完整约 7 分钟剧本案例可读取。
  - 安全图片协议和像素解码通过；未提交付费任务。
- 打包态 MCP：`.codex_tests/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/packaged-mcp/2026-08-15T02-33-22-864Z`。
  - 版本 0.14.2，33 个工具、3 个资源和提示入口均可发现。
- 安装态：`.codex_tests/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/installed-ui/2026-08-15T02-35-24-477Z`。
  - 安全图片协议解码 1024×1024、SQLite quick check、三种完整示例通过，任务数 0。
- 真实用户数据升级：`.codex_tests/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/live-upgrade/2026-08-15T02-35-39-624Z`。
  - 16/16 个项目可加载。
  - SQLite：16 个项目当前态、1142 个修订、1152 个审计事件、590 个资产护照。
  - 项目资产和可复用库图片像素解码无空白；可复用库 49 张图片，打开耗时 161 ms。
  - 活跃自动化 0、活跃远端任务 0；4 条没有上游 taskId 的历史 `remote_pending` 记录原样保留。

## 安装包

- 构建产物：`dist-fixed-0.14.2/纯梦短剧老虎机-安装版-0.14.2.exe`
- 正式交付副本：`D:\Backup\Documents\无限画布\纯梦短剧老虎机-安装版-0.14.2.exe`
- 字节数：126,572,368
- SHA-256：`5F8A62C9FC587BFC65094D5BACCED74D8092C8AB13DCA5C8955CA364CF520F5C`
- Authenticode：`NotSigned`。本次没有可用的商业代码签名证书，未伪造签名状态。
- 已安装程序：`C:\Users\Administrator\AppData\Local\Programs\xiangsu-seedance-bridge\纯梦短剧老虎机.exe`
- 已安装版本：0.14.2；安装态 `app.asar` SHA-256 为 `0CED5D99CC1E876240D578B805E7EB51208450608A710053D534E931EA3076F8`。

## 官网正式发布

- 产品页：`https://puream.cn/drama-slot-machine`
- 下载接口：`https://puream.cn/api/drama-slot/download`
- 正式服务：`puream-workflow-full-api-r90-drama-0142-20260815.service`
- 端口：3103；Nginx 9 处引用全部指向 3103。
- Next.js 构建 ID：`r7Vz8cLrRkIVTJk1Mt87z`
- 服务状态：active + enabled，`NRestarts=0`，严重日志计数 0。
- 旧 r89：inactive + disabled，但服务单元、候选目录和回滚材料保留。
- 服务器内公网校验：页面 0.14.2；完整下载 126,572,368 字节，SHA-256 与本地构建一致。
- 客户外部链路复核：`D:\Backup\Documents\官网开发\downloads\TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001\纯梦短剧老虎机-安装版-0.14.2-public.exe`，大小与 SHA-256 一致。
- 无写入探针：旧余额别名 404、聊天 OPTIONS 204、空支付请求未授权 401、模型列表 200；未发起任何生图、生视频或其他计费生成任务。

## 回滚与保全

- 桌面安装前完整备份：`.codex_backups/releases/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/pre-install-0.14.0`。
- 网站发布前文件级备份：`/opt/puream-workflow-platform/.codex_backups/releases/TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001/pre-r90-20260815T025103Z`。
- 一键回滚：上述目录中的 `rollback.sh`，可恢复 r89、原 Nginx 配置和 0.13.23 下载。
- 云快照：新建快照因腾讯云配额限制返回 `LimitExceeded.SnapshotQuotaLimitExceeded`；未删除任何既有快照。发布记录复用此前已验证为 NORMAL 的 `lhsnap-nj2lp8mg`，并叠加本次精确的 r89 文件级备份和可执行回滚。
- 临时上传公钥已撤销，服务器匹配密钥计数 0；本地临时私钥和公钥均已删除。
