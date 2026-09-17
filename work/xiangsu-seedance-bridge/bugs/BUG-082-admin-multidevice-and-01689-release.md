# BUG-082 Admin multi-device and 0.16.89 release

- Task: `TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002`
- Severity: S2
- Risk: C3
- Status: **production published and publicly verified**
- Patch: `0.16.89`

## Required contract

An authorization code never carries a trusted local administrator flag. The official website resolves `User.role === ADMIN` and may return an `UNLIMITED` device policy only for that server-authoritative role. Administrators still require a valid paid plan and expiry, sufficient wallet balance, and the same account-level image/video concurrency as other users. Role downgrade returns the account to `SINGLE/DEVICE_BOUND` after bounded revalidation.

## Desktop verification

- Administrator policy and local-tamper regression: 9/9 passed.
- Gemini/catalog/admin combined release preflight: 46/46 passed.
- Full source suite: 533/533 passed.
- Installer: `dist-fixed-0.16.89/纯梦短剧老虎机-安装版-0.16.89.exe`
- Installer bytes: `126783554`
- Installer SHA-256: `D1775103D1BDD5808710EE2CE1B6BA3C2501DFD38298B0FF9C8CF4F2B0CB9304`
- Installed EXE version: `0.16.89.0`
- Installed EXE SHA-256: `F17605D89E694D7DB51A9DD5CF9E49E7656E0975D698697AC03B52504B05F98F`
- Installed `app.asar` SHA-256: `08D9E669FDE66F39FB027A6AE81E794B05C438087499B28A0976BF816D338779`
- The pre-install 0.16.88 executable, `app.asar`, and desktop shortcut are preserved under `.codex_tests/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/preinstall-0.16.88-20260823-165511`.

## Detached automation recovery found by the real-data gate

The first real-data upgrade audit found three historical upload-analysis projects left forever in `stopping` even though they had no local operation and no upstream video task. Startup reconciliation previously handled only detached `running`, so a completed stop request could never converge. The 0.16.89 final candidate now resolves only detached `pausing/stopping`: `pausing` becomes `paused_user`, and `stopping` becomes recoverable `cancelled/PIPELINE_STOPPED`; a live local operation or real upstream video task remains authoritative and is never overridden.

The final installed build loaded all 86/86 real projects and matched 86 authoritative SQLite rows. Active automations fell from 3 to 0, active jobs remained 0, all three affected projects retained their `script.analysisCheckpoint`, no project or reusable-library image reference was blank, and the reusable library opened in 718 ms against a 5000 ms budget. Evidence: `.codex_tests/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/live-upgrade-0.16.89-recovery-final/2026-08-23T09-10-13-101Z`.

## Website gray and incident recovery

The first private 3076 gray service inherited production `DB_PATH` from a shared environment file. It never received public Nginx traffic, but the isolated test wrote synthetic rows into production SQLite. The service was stopped immediately; production 3075 remained active with zero restarts. A pre-recovery consistent database backup was created, the exact synthetic session/account/leases/logs were deleted in one transaction, and the pre-existing ADMIN fields were restored to their pre-test baseline. Post-recovery field comparison, orphan checks and SQLite integrity all passed; the real ADMIN session was retained.

Gray isolation was then corrected at both `Environment` and `ExecStart`. The running process environment and open database file descriptor matched the gray copy and had a different device/inode from production. After isolation:

- the same valid ADMIN logged in on two machines, received two tokens, and heartbeated with `UNLIMITED`;
- image concurrency remained 5 with the sixth request queued/429;
- video concurrency remained 5 with the sixth request queued/429;
- an ordinary user received `DEVICE_BOUND` on the second machine;
- an expired ADMIN received `SUBSCRIPTION_EXPIRED`;
- a downgraded ADMIN returned to `DEVICE_BOUND`;
- forged client admin metadata had no effect;
- the wallet retained atomic balance checks and `INSUFFICIENT_BALANCE`, with no ADMIN bypass.

## Production release

- Public version: `https://puream.cn/api/drama-slot/version`
- Public download: `https://puream.cn/api/drama-slot/download`
- Complete public HTTPS readback: `126783554` bytes, SHA-256 `D1775103D1BDD5808710EE2CE1B6BA3C2501DFD38298B0FF9C8CF4F2B0CB9304`.
- Website topology: r108 on `127.0.0.1:3120`, with six Nginx mappings.
- Admin sidecar topology: r92 on `127.0.0.1:3076`, with one Nginx mapping.
- r108, r92 and Nginx are active with `NRestarts=0`; r107/3119 and r91/3075 remain active for immediate rollback.
- Snapshot: `lhsnap-1b0po2ko`, state `NORMAL`.
- Consistent SQLite backup: `/opt/puream-workflow-platform/.codex_backups/production/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/pre-cutover-01689-final-20260823_171614/drama-admin-stats.sqlite`; `6275072` bytes, SHA-256 `908746CA128BBC0DC0907BC97CA67D879F0BBA847309F9E0591F5FF7B4D811AB`, integrity `ok`.
- Production and post-cutover public authorization regressions passed without paid media submission. Synthetic sessions, leases and login logs were exactly cleaned to zero, restored account fields matched their baseline, and production SQLite integrity remained `ok`.
- Final website evidence: `D:/Backup/Documents/官网开发/.codex_tests/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/final-release-0.16.89.json`.
