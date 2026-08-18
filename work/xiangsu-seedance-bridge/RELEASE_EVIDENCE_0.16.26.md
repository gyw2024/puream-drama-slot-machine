# Release Evidence 0.16.26

## Scope

Task: TASK-20260819-VIDEO-QUEUE-001

The release fixes a video-stage false-running state where the project operation was active but no video job had been submitted. It also fixes the retired storyboard crop-gate recovery path and project-selector drift.

## Verification

- Full test suite: 399/399 passed.
- Focused video recovery suite: 18/18 passed.
- Syntax and diff checks: passed.
- Packaged Electron audit: passed.
- Routes: console, script, assets, shots, videos, final, settings.
- Viewports: 1024x720, 1280x800, 1440x900, 1920x1080, and 200% zoom.
- Critical/serious axe violations: 0.
- Horizontal overflow: 0.
- Blank images: 0.
- Paid video submissions during verification: 0.

## Artifacts

- Installer: dist-fixed-0.16.26/纯梦短剧老虎机-安装版-0.16.26.exe
- Installer SHA-256: 304FF204AEC6FCB4CD0C4B5DD79B2ECAECDAFC7838714E1820D431ECD83AFB95
- Unpacked executable SHA-256: 7729118FCE01B2D1A30FAE017EACB208F6ADC0ED9286D7D6BCAFA148EFA307F4
- UI evidence: .codex_tests/TASK-20260819-VIDEO-QUEUE-001/packaged-ui/2026-08-18T18-54-33-178Z

## Rollback

The existing 0.16.25 runtime and installer remain untouched.
