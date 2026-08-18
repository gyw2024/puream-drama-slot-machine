# Release evidence 0.16.21

## Scope

- Remove default paid `character_intro` image generation.
- Reuse character four-view images for character-video and downstream identity references.
- Require real non-empty files for candidate readiness.
- Materialize reusable voices into the current project before prompt binding.
- Recover `SHOT_SPEAKER_VOICE_REQUIRED` once through the asset stage.
- Reconcile false-complete legacy asset progress without paid startup work.

## Verification

- Full source regression: `382 passed, 0 failed`.
- Packaged UI audit: passed; version `0.16.21`, no critical/serious accessibility findings, no layout overflow.
- Installed UI audit: passed from `release\0.16.21\app`; packaged mode, hardware rendering, zero paid jobs.
- Cost regression: 3 character sheets + 3 scene sheets produced exactly 6 image submissions; zero `character_intro` submissions.
- Target project `project_msygbhiy_1fa664ee`: visible and loadable; 32 images decoded with zero blanks in assets and shots views.
- Target project migration: old `15/15` false completion becomes `6/12` real completion with 3 character videos and 3 voices queued.

The global historical live-upgrade audit remains red for pre-existing data outside this hotfix: three old projects reference a product image under a deleted project, and 22 recoverable deleted-project directories are not represented as current SQLite project-state rows. No historical data was deleted or fabricated to hide that condition.

## Artifacts

- Installer: `dist-fixed-0.16.21\纯梦短剧老虎机-安装版-0.16.21.exe`
- Installer SHA-256: `02884E5F97D85937B11509819F748A4F0A4D66ACBD851DC68A0AE7197D118DCB`
- Installed executable: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.21\app\纯梦短剧老虎机.exe`
- Installed executable SHA-256: `531C22908ECAFD6EFE3A864EDF4C4C783E84A6278F5353CA96D6DDD40F79CAB4`
- Installed `app.asar` SHA-256: `66709438D741306A159F45865C9B4C8C3066C3936E50C638284B2855058EEF21`
- Desktop shortcut target: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.21\app\纯梦短剧老虎机.exe`

## Rollback

- Source baseline: `.codex_backups\task-asset-regression-20260818-203925`
- Previous installed release remains at `D:\Backup\Documents\无限画布\纯梦短剧老虎机\release\0.16.1\app`.
