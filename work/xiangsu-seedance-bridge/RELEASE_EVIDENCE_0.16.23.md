# Release Evidence 0.16.23

## Scope

- Uploaded scripts require an authoritative AI structured result before characters, scenes, props, or shots are committed.
- The deterministic parser remains recovery evidence only and can never become a successful asset ledger.
- Time ranges, shot headings, and production-only labels are rejected as scene assets.
- Returned invalid structure receives one bounded Agent repair turn; provider/network failures are not blindly replayed.
- The same workflow implementation is used by both Agent and Simple modes.

## Verification

- Full automated suite: `386/386` passed.
- Focused uploaded-script and scene regressions: `24/24` passed.
- 26 timed input blocks produced only two physical scenes: `旧小区楼道`, `银行大厅`.
- Simulated first AI result with scene `0-10秒` was rejected and repaired to `客厅` before commit.
- Simulated provider failure committed zero scene assets, preserved the source and checkpoint, and resumed only the failed chunk.
- Packaged UI audit: passed at 1024x720, 1280x800, 1440x900, 1920x1080, and 200% zoom.
- Packaged accessibility: zero serious or critical Axe violations across seven stages and seven dialogs.
- Installed audit: passed; version `0.16.23`, packaged runtime, hardware rendering, zero paid jobs.

## Artifacts

- Installer: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\work\xiangsu-seedance-bridge\dist-fixed-0.16.23\纯梦短剧老虎机-安装版-0.16.23.exe`
  - Size: `126686378`
  - SHA-256: `7406D23319FE603E8EF7633E87D838AA34F749B7F7876871DC8204C6CA0206CB`
- Installed executable: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.23\app\纯梦短剧老虎机.exe`
  - Size: `225613824`
  - SHA-256: `4CB1C0EA7A5319ECA7EF23E9238311E714C10D0F19A1D5C8EF8E1497D37EBA7D`
- Installed app.asar: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.23\app\resources\app.asar`
  - Size: `18128408`
  - SHA-256: `9EE896C310B10EE7C824D8C26D486F16C71BAF375089E10376458CE8761EE56A`

## Evidence And Rollback

- Packaged audit: `D:\Backup\Documents\无限画布\.codex_tests\TASK-20260818-UPLOADED-SCRIPT-AI-NORMALIZE-01\packaged-ui\2026-08-18T14-05-56-651Z`
- Installed audit: `D:\Backup\Documents\无限画布\.codex_tests\TASK-20260818-UPLOADED-SCRIPT-AI-NORMALIZE-01\installed-ui\2026-08-18T14-07-11-785Z`
- Desktop shortcut target: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.23\app\纯梦短剧老虎机.exe`
- Preserved rollback: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.22\app`
- Task baseline: `D:\Backup\Documents\无限画布\.codex_backups\tasks\TASK-20260818-UPLOADED-SCRIPT-AI-NORMALIZE-01\20260818_214741-baseline`
