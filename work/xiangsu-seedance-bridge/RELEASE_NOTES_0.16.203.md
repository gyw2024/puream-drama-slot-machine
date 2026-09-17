# 0.16.203 — Exact dialogue and bounded review repair

Task: TASK-20260907-AG-REVIEW-3-001. Local candidate until installation verification is recorded.

- Compiler reference binding no longer replaces Chinese dialogue words, character names or literal asset IDs inside complete dialogue tags. The same compiler fix is present in the production-package Skill.
- Review receipts support exact item/source/rules/reviewer-profile reuse after one sibling prompt changes. Negative findings remain negative; duplicate-ID or malformed cache rows are rejected.
- Frame/native-mode reviews retain source scene IDs and supported prop bindings even when only temporal frames are supplied.
- Asset/video/still targeted repairs share two automatic repair passes per invocation, followed by a final review. Explicit manual retries remain available. This is not a draw, account or concurrency limit.
- Legacy deferred semantic state cannot pass confirmation simply because a per-shot pending field was lost. The editable `ready` screen is not an AI approval; optional external reviewer failures do not remove human confirmation.
- Valid legacy/manual compiler paths without an optional semantic-author receipt remain confirmable; a missing receipt is no longer mistaken for a failed run.
- This user's review selection changed from Grok Build to Antigravity. Other users' selections are not changed by installing this version.

Evidence is under .codex_tests/TASK-20260907-AG-REVIEW-3-001 at the project root. No new image/video generation or Grok model calls are part of this release audit. Local/mocked tests and AG text review do not prove final audiovisual quality or perfection of every software route.
