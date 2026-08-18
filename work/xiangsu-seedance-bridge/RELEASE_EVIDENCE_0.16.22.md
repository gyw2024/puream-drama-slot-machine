# Release Evidence 0.16.22

## Scope

- Asset resume confirmation now uses the persisted backend asset plan.
- Retired character identity-image stages are excluded from missing-item counts.
- Failed items are not counted twice.
- Startup persists repaired legacy asset progress into JSON and SQLite.
- Previous 0.16.21 asset-cost and character-voice recovery fixes remain included.

## Verification

- Full automated suite: `383/383` passed.
- Focused asset regression: `6/6` passed.
- Packaged UI audit: passed at 1024x720, 1280x800, 1440x900, 1920x1080, and 200% zoom.
- Packaged accessibility: zero serious or critical Axe violations.
- Installed audit: passed; version `0.16.22`, packaged runtime, hardware rendering, zero paid jobs.
- Installed asset-confirmation audit: `已就绪 6 项会跳过，只补缺失/失败的 6 项。`
- Target project startup migration: status `paused`, stage `assets`, progress `6/12`, queued `6`, failed `0`, running `0`, jobs `0`; raw `project.json` parses successfully.

## Artifacts

- Installer: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\work\xiangsu-seedance-bridge\dist-fixed-0.16.22\纯梦短剧老虎机-安装版-0.16.22.exe`
  - Size: `126685990`
  - SHA-256: `C99B5E4B60C8CEF145C38705ADD491A52175475E1DA76311DF1146753A52CA49`
- Installed executable: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.22\app\纯梦短剧老虎机.exe`
  - Size: `225613824`
  - SHA-256: `8ED1D7497C34A069B67B82F2907CA5CBC3251BF3461B25B9732FB078AA8A0D4D`
- Installed app.asar: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.22\app\resources\app.asar`
  - Size: `18127592`
  - SHA-256: `4864EAAF4B997E9137547531AAE1741AEB60F88BEE067662EBDCDAEC34070FF9`

## Installation And Rollback

- Desktop shortcut target: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.22\app\纯梦短剧老虎机.exe`
- Preserved rollback: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.21\app`
- Source backup: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\work\xiangsu-seedance-bridge\.codex_backups\task-asset-count-voice-plan-20260818-210828`
