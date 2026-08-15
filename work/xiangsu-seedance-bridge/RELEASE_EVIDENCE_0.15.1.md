# 纯梦短剧老虎机 v0.15.1 正式发布证据

- 发布任务：`TASK-20260815-DRAMA-CONTINUOUS-BLOCK-003`
- 缺陷编号：`BUG-20260815-003-H3-CONTINUITY-OVERSEGMENT`
- 发布日期：2026-08-15
- 发布状态：源码、构建、安装、隔离 UI、真实历史数据升级、存储迁移均已验收。

## 根因

v0.15.0 为解决“对白换人但镜头不换”的问题，把编辑层的每一次说话人或机位变化直接提升为供应商任务边界。它修正了嘴型归属，却混淆了三种不同概念：对白事实、镜头剪辑、供应商调用。因此一个本可在 H3 内部顺畅切镜的连续场景被过度拆分，产生节奏割裂、跨任务表演不连续和更多上游调用。快速剧本编译器还会把同一业务分镜的多轮对白压到开场人物名下，旧提示词库残留的“换人必须结束任务”规则又可能覆盖新逻辑。

## 底层修复

- `app/agent-director.js` 建立三层权威合同：不可变对白账本、原子镜头段、连续供应商生成块。
- 同场景 5–15 秒内容默认合为一个 H3 任务；块内最多 5 个镜头段、3 个音色，精确输出 `HARD_CUT@秒点`、说话人、镜头主体、嘴型主体、监听者和逐字对白。
- `app/direct-fast-script.js` 保留多轮对白的真实说话人和时间顺序，不再把整段对白扁平化到开场人物。
- `app/workbench-workflow.js` 先预编译完整连续块及全部原子降级方案，再允许付费提交；连续块失败只降级该块，不重做已成功内容。
- `app/media-quality.js` 增加成片切镜证据审计。需要切镜而检测不到，或检测结果不合格，均触发局部原子降级。
- 所有活跃 H3 写作入口统一采用 v4 连续块规则，并有回归测试禁止旧的“每次换人都结束供应商任务”约束重新进入生产路径。

## 源码与供应链门禁

- 全量自动化测试：`219/219` 通过。
- JavaScript 语法检查：通过。
- `git diff --check`：通过。
- `npm audit --omit=dev --audit-level=high`：0 个漏洞。
- 上传传输门禁：`/video-reference` 与 `/image-reference` 均限制为 8 MiB；审计 SHA-256：`6BD133F2016DFE672D9FE8389C5E96A01A2DE9882D09AB2BFE1250149DE6A557`。
- 构建资产校验：通过。
  - FFmpeg：`2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3`
  - face-grid：`AC65468BE5376AEC7276B9D91022DD8EEDDDAAF6467DB5B852DEDBC99F78BBCA`
  - hider：`5522FEC2BD7F87D491E5A76B4372DF0655D24B8C0E8E0777C30462B8BAE0374E`
- 验证期间付费 H3、图片或视频提交：`0` 次。

## UI、安装与真实数据验收

- 打包态 UI 对抗审计：通过；共 60 张运行截图，覆盖 7 个阶段、7 个弹窗、1024/1280/1440/1920 宽度和 200% 缩放；横向溢出 0、重叠 0、过小控件 0、axe 违规 0、空白图片 0。
- 打包态证据：`D:\Backup\.codex_tests\TASK-20260815-DRAMA-CONTINUOUS-BLOCK-003\packaged-ui\2026-08-15T13-38-19-750Z`。
- 隔离安装态审计：通过；版本 `0.15.1`、SQLite 正常、5 个业务资产库和 9 种复用入口可用、中文特殊路径 1024×1024 图片可经 `puream-asset://` 正常解码，付费任务 0。
- 隔离安装态证据：`D:\Backup\.codex_tests\TASK-20260815-DRAMA-CONTINUOUS-BLOCK-003\installed-ui\2026-08-15T13-40-25-713Z`。
- 真实升级审计：通过；17/17 当前项目可加载，1 个删除项目仍可恢复，18 个权威项目状态对齐；项目图片 1829 项空白 0，复用库图片 53 项空白 0，资产库打开 339ms，运行中任务和自动化均为 0。
- 真实升级证据：`D:\Backup\.codex_tests\TASK-20260815-DRAMA-CONTINUOUS-BLOCK-003\live-upgrade\2026-08-15T13-41-01-513Z`。
- 自定义保存位置迁移审计：通过；17 个项目、7535 个项目路径替换、12956 个 JSON 路径替换、395/395 个抽检资产位于新目录且存在，旧路径引用 0，源数据保持不变。
- 迁移证据：`D:\Backup\.codex_tests\TASK-20260815-DRAMA-CONTINUOUS-BLOCK-003\foundry-relocation\2026-08-15T13-42-17-117Z`。

## 正式产物

- 正式安装包：`D:\Backup\Documents\无限画布\纯梦短剧老虎机\纯梦短剧老虎机-安装版-0.15.1.exe`
- 文件大小：`126596739` 字节。
- SHA-256：`3B27A7D1716A35E119ADCBBE96BE7019C819F898EB5B986B819F61553F4C3662`
- Authenticode：`NotSigned`（当前未配置 Windows 代码签名证书）。
- 本机安装位置：`C:\Users\Administrator\AppData\Local\Programs\xiangsu-seedance-bridge\纯梦短剧老虎机.exe`
- 已安装产品版本：`0.15.1.0`。
- 已安装 EXE SHA-256：`96F8A428D9CB8D072FD9996FF2448239BEB7191F9A07DB2CACFC46752FA0F450`
- 已安装 `resources\app.asar` SHA-256：`74F5F1436DF35FCFFD26152AE2D61787D3C0F91354438FE647F15059C4C3FF64`

## 数据保护与回滚

- v0.15.0 源码、已安装程序和完整真实运行数据备份：`.codex_backups/baselines/TASK-20260815-DRAMA-CONTINUOUS-BLOCK-003/pre-change-0.15.0`。
- 最终正式安装前后 `projects.json`、`settings.json`、`foundry-v2.sqlite` 哈希逐项一致；安装过程没有覆盖用户项目、设置或账本。
- 已删除项目的 SQLite 状态和可恢复档案均保留；迁移审计使用副本，不删除源目录来制造通过结果。

## 验证边界

本次“全功能测试”覆盖所有无需付费即可确定验证的代码、合同、状态机、数据、安装、升级、迁移和 UI 行为。为避免未经授权产生费用，没有向 H3 或其他图像/视频供应商提交真实生成任务，因此不把上游模型随机出片质量冒充为已实拍验证；真正付费出片仍需以用户触发后的样片验收为准。
