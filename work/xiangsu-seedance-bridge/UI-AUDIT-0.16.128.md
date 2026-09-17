# Frontend adversarial audit report

## Verdict

- Result: `pass`
- Runtime/build: 纯梦短剧老虎机 `0.16.128`; packaged Electron build and installed executable
- Routes/windows/states covered: mode selector, Codex package import, script, assets, shots, videos, final, settings, dialogs, package-locked and empty/running states
- Viewports/zoom: `1024x720`, `1280x720`, `1280x800`, `1440x900`, `1920x1080` at 100%; `1280x800` at 200%
- Source vs packaged vs production evidence: source UI audit, packaged UI audit, installed isolated audit, and installed real `.pdramapack` import audit all passed

## Tool evidence

| Tool | Version | Scope | Result artifact |
| --- | --- | --- | --- |
| Electron/Playwright audit | app `0.16.128` | Source mode selector and workbench | `.codex_tests/TASK-20260902-DRAMA-PACKAGE-DIRECT-MODE-012/ui-after-source/2026-09-02T04-19-46-302Z` |
| Packaged audit runner | app `0.16.128` | Packaged `win-unpacked`, viewport, zoom, keyboard and axe checks | `D:/Backup/.codex_tests/TASK-DRAMA-PACKAGED-AUDIT/packaged-ui/2026-09-02T04-42-23-417Z` |
| Installed audit runner | app `0.16.128` | Installed executable, isolated data, local image decoding | `.codex_tests/TASK-20260902-DRAMA-PACKAGE-DIRECT-MODE-012/installed-general-final/2026-09-02T04-44-07-985Z` |
| Real package audit | app `0.16.128` | 22-shot Jiubao package import, locked UI and zero-submit contract | `.codex_tests/TASK-20260902-DRAMA-PACKAGE-DIRECT-MODE-012/installed-ui/2026-09-02T04-44-22-037Z` |

## Findings

| ID | Severity | Page/state | Confirmed issue | Evidence | User impact | Required fix | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUG-118-A | P0 | Imported package | Package was labelled `asset_direct` and package shot references were presented as first-frame storyboards | `BUG_HISTORY.md` BUG-118 | Operator could not know which generation contract would submit a shot | Add independent `production_package` contract and preserve `shot_anchor` lineage | Real package reports only `production_package`, empty frame-stage sets and zero imported storyboard stages |
| BUG-118-B | P0 | Video submission | Imported package had no dedicated immutable and exactly-once submission boundary | `scripts/production-package-mode-v128-regression.test.js` | A prompt could be rewritten or a shot submitted more than once | Lock imported content and block any second upstream attempt/task evidence | Targeted regression `8/8`; real audit reports `onceOnly: true`, `videoJobCount: 0` |
| BUG-118-C | P1 | Package shot workspace | Generic manual storyboard controls appeared in a package-owned reference workflow | Installed before/after shot screenshots | UI implied that package references were editable/generated storyboards | Hide generic storyboard upload bar in package mode and show package-locked reference semantics | Final installed screenshot has no manual storyboard bar and strategy editing is disabled |
| BUG-118-D | P1 | Asset preview | Re-rendering replaced an unchanged product image node; deep Unicode Windows paths could fail through generic Chromium file transport | Installed image-decode audit | Preview could flicker or fail despite a valid local asset | Reuse unchanged image nodes and serve verified images through the secure asset protocol | Installed audit decodes the Unicode-path PNG at `1024x1024`; no console, page or request failures |

## Page matrix

| Page/window | Default | Loading | Empty | Error | Keyboard | Visual | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mode selector | Pass | N/A | Pass | Pass | Pass | Pass | Shows three distinct entries; package mode is named `Codex 资产包直抽` |
| Package import | Pass | Pass | Pass | Pass | Pass | Pass | Import button has an accessible label and remains visible at 200% |
| Shot workspace | Pass | Pass | Pass | Pass | Pass | Pass | Package references are locked; generic storyboard upload controls are hidden |
| Video workspace | Pass | Pass | Pass | Pass | Pass | Pass | Image-only contract, no reference audio, no previous-shot video and once-only copy are visible |
| Settings/dialogs | Pass | Pass | Pass | Pass | Pass | Pass | No horizontal clipping or serious/critical axe findings |

## Automated candidates

- Confirmed horizontal overflow: `0`
- Confirmed critical/serious axe violations: `0`
- Runtime console errors: `0`
- Runtime page errors: `0`
- Runtime request failures in the real package audit: `0`
- Paid video tasks created by the audit: `0`

## Accepted deviations

- None.

## Re-test

- Fixed IDs: `BUG-118-A`, `BUG-118-B`, `BUG-118-C`, `BUG-118-D`
- Remaining P0/P1: `0`
- Before/after evidence: `.codex_tests/TASK-20260902-DRAMA-PACKAGE-DIRECT-MODE-012/ui-baseline` and `.codex_tests/TASK-20260902-DRAMA-PACKAGE-DIRECT-MODE-012/installed-ui/2026-09-02T04-44-22-037Z`
- Package/build identity: installer SHA-256 `B9821D448198797904AF81B45EE8AAE21155C99DE1CDA17EA3CCE41142DC0C99`; package SHA-256 `fb42c8c7cdc158f9fbfb81b6ca13d5e8d1b8367602d924192b20527b8419925c`
- User-data preservation: `2093` files, `5,472,749,568` bytes, two SQLite databases passed `quick_check`; before/after roots changed `0`, added `0`, removed `0`, changed `0`
- Rollback path: `.codex_backups/releases/TASK-20260902-DRAMA-PACKAGE-DIRECT-MODE-012`
