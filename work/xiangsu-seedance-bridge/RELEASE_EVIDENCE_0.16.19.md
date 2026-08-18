# Release Evidence 0.16.19

日期：2026-08-18

## Scope

- 将所有创作质量审查收口到审核蓝图总开关和模块开关。
- 旧断点主反转预检仅在 `script + productionStructure` 开启时执行。
- 分镜技术审查归属 `videos` 模块；成片审查归属 `delivery` 模块。
- 国内 OpenAI-compatible 文本供应商使用同一逻辑请求 ID，并对瞬时网络中断续接。

## Verification

- `node --check app/workbench-workflow.js`
- `node --check app/ai-provider.js`
- `npm.cmd test`：372/372 通过，0 失败，约 5.9 秒
- `npm.cmd run verify:build-assets`：通过，FFmpeg、face-grid-processor、window-hider 均核验
- `npm.cmd run audit:packaged`：通过；1024/1280/1440/1920、200% 缩放、阶段页、设置页、审核面板和对话框均无严重 axe、横向溢出或遮挡

## Artifacts

- 目录版：`D:\Backup\Documents\无限画布\纯梦短剧老虎机\work\xiangsu-seedance-bridge\dist-fixed-0.16.19\win-unpacked\纯梦短剧老虎机.exe`
  - SHA-256：`2696C943789E9D08153171409FBC863212EB5C462B3FE39BC45AE89466001CAF`
- 安装包：`D:\Backup\Documents\无限画布\纯梦短剧老虎机\work\xiangsu-seedance-bridge\dist-fixed-0.16.19\纯梦短剧老虎机-安装版-0.16.19.exe`
  - SHA-256：`1E4E0DD83C249FF76DFB3A64E3A9ACD7EAB0A50F8B540D6ECF5C5D9CA29142E5`
- 桌面快捷方式：`C:\Users\Administrator\Desktop\纯梦短剧老虎机.lnk`
  - 目标：`D:\Backup\Documents\无限画布\纯梦短剧老虎机\work\xiangsu-seedance-bridge\dist-fixed-0.16.19\win-unpacked\纯梦短剧老虎机.exe`
- 正式备份：`D:\Backup\Documents\无限画布\纯梦短剧老虎机\.codex_backups\releases\TASK-20260818-AUDIT-GATE-CLOSE-001\final`

## External boundary

未提交真实付费图片、音频或视频生成任务；上游账号、余额、授权和供应商可用性仍以运行时返回为准。
