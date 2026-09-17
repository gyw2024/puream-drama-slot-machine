# BUG-083 Partial topics and read-only provider errors

- Task: `TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003`
- Severity: S2
- Risk: C2
- Status: **source repaired; Windows patch verified; real macOS gate open; website not published**
- Patch: `0.16.89-HF003`

## Symptom and root cause

Topic generation could stop with `Cannot set property code of which has only a getter` and then report that the Agent had not returned ten structurally complete topics. Two independent defects were coupled:

1. OpenAI-compatible pre-header timeouts and accepted Gemini streams can throw native `DOMException` objects whose `code` property is read-only. The application attempted to mutate that object, causing a secondary `TypeError` that hid the provider's real state.
2. Ten topics was implemented as a hard acceptance threshold. A valid partial result was discarded, and the recovery path could make extra paid calls merely to fill the list.

## Required behavior contract

- Ten remains the requested target, not a minimum acceptance threshold.
- One to nine valid topics are displayed immediately; the application does not call the provider again merely to reach ten.
- Zero valid topics permits at most one evidence-based continuation. If it still yields zero, the project enters a safe recoverable `waiting_topics` state without a red format error.
- Existing valid topics survive a redraw failure.
- Provider errors are wrapped in a writable application error; native error objects are never mutated.
- Rate limits and insufficient balance remain distinguishable and are not mislabeled as output-format failures.
- No fixed local topic library is used to conceal an empty provider response.

## Repair scope

- Added `app/public-error.js` for writable causal errors and public-message sanitization.
- Removed unsafe native-error mutation from `app/ai-provider.js`, `app/bridge-client.js`, and `app/main.js`.
- Changed partial-topic acceptance, bounded zero-result continuation, preservation, and output-budget handling in `app/workbench-workflow.js`.
- Updated the workbench copy and partial-result rendering in `app/renderer/workbench.html` and `app/renderer/workbench.js`.
- Added or updated provider, topic, recovery, SLA, and UI regressions under `scripts/`.

## Verification

- Targeted source regression: 72/72 passed.
- Full source suite: 543/543 passed.
- Pure headless topic UI matrix: 20/20 passed for 0/1/3/9/10 topics across 1280x800, 1440x900, 1920x1080, and 200% scaling; no horizontal overflow, overlap, red error toast, or serious Axe finding.
- No paid text, image, audio, or video request was submitted.

## Patch artifact

- ZIP: `D:\Backup\Documents\无限画布\纯梦短剧老虎机\work\xiangsu-seedance-bridge\release-patches\0.16.89-HF003-dual-platform-offline-patch.zip`
- Bytes: `17154708`
- SHA-256: `B4CF2E7C4FA5516A824C6F991F5D0B848DAFF6785F329BE0AA2A461A6A96A9F9`
- Baseline Windows EXE: `F17605D89E694D7DB51A9DD5CF9E49E7656E0975D698697AC03B52504B05F98F`
- Target Windows EXE: `38E1A85EE20B17FA521DD0BE99532E5670F6A6CB79A09A1B5664B0E5EDF4131E`
- Baseline `app.asar`: `08D9E669FDE66F39FB027A6AE81E794B05C438087499B28A0976BF816D338779`
- Target `app.asar`: `26233820215195014B0D925C14A56472F2F4206DB42B7E866DF91FFAE704DEDC`
- Target ASAR header hash: `df8140e390afa1cc9d47b4c670648adbebbbb4f0e180ade9e0efcb6dda50eeb9`

## Platform matrix and rollback

- Windows: exact-baseline installation, idempotent second install, headless Electron startup, gateway creation, exact target hashes, rollback to exact baseline hashes, invalid explicit-path refusal, and unknown-baseline refusal passed on real Windows from the final archive. Evidence: `.codex_tests/TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003/windows-patch-candidate-final/result.json`.
- macOS: the hardened installer validates the baseline ASAR/header/signature, verifies a complete backup, builds and signs a candidate `.app` before swapping, repairs a half-installed target, verifies idempotency, rejects an invalid explicit path/unknown baseline/bad backup, and verifies rollback. Those paths passed a POSIX-shell simulation from the final archive. Real macOS execution and Developer ID signing/notarization are not yet verified and must remain an explicit delivery gate.
- Both installers refuse unknown baselines. Rollback uses only a hash-verified backup made before replacement.

## Publication boundary and open gate

The public website remains at `0.16.89`; this hotfix was not uploaded, published, or switched into the update feed. The project currently has no official macOS 0.16.89 build, Developer ID/notarization pipeline, existing Actions workflow, or Mac runner. The GitHub credential available in this workspace has `repo` but not `workflow` scope, so it cannot create the prepared macOS runner workflow. A real Mac validation requires either that scope or a reachable Mac build/test host, and customer distribution additionally requires the owner's Apple Developer signing/notarization credentials. Until then, Windows is verified; macOS must not be represented as customer-verified.
