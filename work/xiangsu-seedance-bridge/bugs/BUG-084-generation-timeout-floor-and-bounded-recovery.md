# BUG-084 Generation timeout floor and bounded recovery

- Task: `TASK-20260823-DRAMA-TIMEOUT-020`
- Severity: S1
- Risk: C3
- Target version: `0.16.90`
- Status: fixed, packaged, installed and verified locally
- Publication boundary: local Windows installation and standalone installer only; website remains unchanged

## Symptom

A customer's own OpenAI-compatible relay responds quickly when used by Codex, while topic generation in the desktop application can stop with `PROVIDER_TIMEOUT`. The topic screen may appear to keep working without returning available cards, and an interrupted structured response can enter repeated JSON continuation calls.

## Root cause

The desktop request was not equivalent to the Codex request:

1. Topic generation requested a 100,000-token completion budget for ten cards, which could make an upstream gateway reserve an unnecessarily large completion.
2. Non-Gemini topic calls were aborted by a desktop-owned 90-second wall-clock timer, even when a healthy stream was still producing data. PUREAM, OpenAI-compatible and provider-native adapters had different, shorter hidden limits.
3. `maxReconnectAttempts: 1` was interpreted as one total attempt, so the comment claiming one retry was false.
4. Workflow partial-topic handling accepted one to nine cards, but provider-level automatic JSON continuation ran first. An unclosed root object could therefore hide complete cards and create an unbounded sequence of paid suffix requests.
5. Several script, upload-analysis and prompt-compilation stages still used 40-300 second request limits. Tests named as no-deadline coverage did not reject the actual 90-second literal.
6. Media import, image normalization, face-grid processing, FFmpeg analysis/stitching and metadata cleanup still had independent 20-300 second subprocess watchdogs.
7. A video submission without a task ID was classified as a phantom after 90 seconds, despite the submit transport now allowing a legitimate 20-minute wait. The legacy renderer also stopped polling a paid task after exactly 20 minutes.
8. Gemini hard-quota metadata was lost when the provider error was wrapped, and the admission recovery budget could still be shortened below the production floor.

## Required contract

- Every paid/generative request, stream idle watchdog, submit request and result wait has a timeout floor of at least 20 minutes. A stream with real model progress is not killed by a same-length wall-clock timer.
- Health probes, wallet reads, UI timers and polling intervals remain short because they are not generation deadlines.
- User pause/cancel always aborts immediately.
- One to nine valid topic cards are displayed immediately; ten is a target, not an acceptance threshold.
- Topic generation does not invoke generic structured-JSON continuation. It extracts complete cards from the received prefix.
- A transport recovery is bounded and reuses the same logical session/idempotency key. No whole-request replay is allowed after partial text, usage/receipt, `done`, or another settled response signal.
- Generic structured-JSON suffix continuation is bounded. A settled response can never be reset and rewritten as a new paid request.
- Provider capability limits remain available globally, while each workflow stage requests only the completion budget its schema actually needs.

## Verification ledger

- Source regression: `561/561` passed.
- Provider/Gemini targeted regression: `48/48` passed; final affected-path matrix: `89/89` passed.
- Build assets: FFmpeg and both bundled Windows helpers passed size and SHA-256 verification.
- Packaged runtime: passed at 1024x720, 1280x800, 1440x900, 1920x1080 and 200% zoom; serious accessibility violations `0`; paid jobs `0`.
- Partial-topic UI: `0/1/3/9/10` cards rendered at all four audited viewport profiles; serious accessibility violations `0`.
- Simple mode packaged runtime: current six panels passed; the fresh-user three-step guide opened and closed; no text-model controls; 100%-200% zoom passed.
- Silent installer exit code: `0`.
- Installed runtime: version `0.16.90`, packaged mode true, SQLite quick check passed, paid jobs `0`, running automations `0`.
- User-data preservation: project directories `86 -> 86`; reusable-library assets `785 -> 785`.
- Installer: `126788842` bytes; SHA-256 `9E659F4C82AAD2C4C36D626F28E4A159AB10A504B03EA7AEF646461E4418AB3C`; Authenticode `NotSigned`.
- Installed EXE SHA-256: `2AFFA8D623283C3E355E5E2B8596CF31A42F1D106F7FE922475AA4DE7A66C13B`.
- Installed `app.asar` SHA-256: `31AA60192D1ECD190B6FA7E89A10986C76180AC0197797E6C9994BCD7C573141`.
- Removed obsolete `0.16.87`, `0.16.88`, `0.16.89`, patch-package and preinstall-binary directories after installation verification. Kept only `dist-fixed-0.16.90` as the current local release artifact.
- Website/public update manifest was not changed.

Evidence roots:

- `.codex_tests/TASK-20260823-DRAMA-TIMEOUT-020/packaged-ui/2026-08-23T11-50-08-725Z`
- `.codex_tests/TASK-20260823-DRAMA-TIMEOUT-020/topic-ui`
- `.codex_tests/TASK-20260823-DRAMA-TIMEOUT-020/simple-ui/2026-08-23T11-55-14-896Z`
- `.codex_tests/TASK-20260823-DRAMA-TIMEOUT-020/installed-ui/2026-08-23T11-56-34-776Z`
