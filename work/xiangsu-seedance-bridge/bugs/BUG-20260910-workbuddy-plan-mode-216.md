# WorkBuddy writing returns a plan instead of scene JSON

Task: TASK-20260910-WORKBUDDY-WRITER-216. Scope: local WorkBuddy CLI text adapter. Final version: 0.16.217.

## Confirmed cause

The adapter launched every WorkBuddy text request with `--permission-mode plan`. This imposes a planning workflow on actual writing and reviewing. On project `project_mtvdaus9_70b66adb`, request `agent_e1ab7a4f-ef4a-4d48-a1e1-a8284703e85d` ended at 2026-09-10 18:21:26 Asia/Shanghai with only a 204-character planning announcement. There was no S05–S08 script body to recover by formatting. The application correctly rejected it with MODEL_JSON_INVALID; S01–S04 and the eight-scene plan remained saved.

## Repair

Use `dontAsk` with all built-in tools disabled and strict MCP configuration retained. Supply a session-only writer/reviewer system prompt. JSON validation stays in the application. Prefer native `structured_output` when present while still rejecting terminal errors first. Account, model, global WorkBuddy configuration and GUI are unchanged.

The intermediate 0.16.216 experiment passed a native `--json-schema`. A short smoke call passed, but the full request exposed WorkBuddy's tool-backed implementation: it demanded StructuredOutput and repeated an already-complete response. That option was removed in 0.16.217 and protected by a regression assertion. The scene request eventually delivered valid S05–S08 before the application was paused at review, preserving all eight scenes. Do not distribute the intermediate installer.

## Validation

- 50 agent integration, terminal failure, stage routing and model option tests passed.
- 39 authoring, checkpoint handoff, JSON recovery and version contract tests passed.
- Real Kimi-K3 smoke request returned parsed scene JSON with dialogue and end state.
- Installer 0.16.216 completed with exit code 0. All 60 project files and settings hashes remained unchanged across installation.
- Original project resumed through the installed app's local control API, operation `mcpop_295c8c55-f896-49f5-9f42-925c997a7c0e`, beginning at S05–S08. Eight scenes passed structural validation; the original four parts remained byte-for-byte equal as JSON at that point. The final 0.16.217 smoke call also passed with no native schema/tool requirement.
- Installed 0.16.217 ASAR matches its build and contains the exact patched source. Two complete real reviews and six scene-repair responses passed application parsing. Subsequent editorial repairs may intentionally change earlier scenes.
- The built-in accumulated 15-minute text budget paused one review; an explicit continuation through the existing application API restored the saved checkpoint without changing the guard.
- At 18:56:12 the operator paused the content-repair test because the review correctly requires real product facts in place of the placeholder “根据产品特性自由编辑”. Eight scenes and completed repairs remain saved. The application records this cancellation as `failed / PROVIDER_REQUEST_ABORTED`; it is not a new JSON/transport failure. No WorkBuddy CLI child remains running. The script has NOT passed final content review; remaining findings concern prop continuity and unsupported product-selection facts.
- Other 59 project files remain unchanged. Settings were byte-identical across the first installation. Later application saves changed settings ciphertext fields; current-vs-backup differences are confined to API-key fields encoded by WorkbenchStore, so a final byte-identical settings claim is not made.

## Rollback

Baseline: `纯梦短剧老虎机/.codex_backups/TASK-20260910-WORKBUDDY-WRITER-216`. Contains original touched source/package metadata, project checkpoint, project/settings hash manifests and the matching installed 0.16.215 executable/ASAR pair. Do not restore an old ASAR without its matching executable integrity resource. Preserve newly generated project data when rolling back application binaries.

No UI layout was changed; no native GUI automation was used. No image or video generation was requested.
