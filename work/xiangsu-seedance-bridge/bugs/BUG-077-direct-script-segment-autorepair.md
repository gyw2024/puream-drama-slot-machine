# BUG-077

- Date: 2026-08-20
- Severity: S2
- Scope: desktop script generation, all structured text providers
- Symptom: after the semantic shot schedule succeeded, one truncated or semantically invalid five-shot body segment caused `SCRIPT_SEMANTIC_SEGMENT_REQUIRED` and paused the project for a manual Continue action.
- Root cause: direct-script segments were syntactically recovered by the provider layer, but post-parse locked-dialogue validation returned a terminal rejected result instead of creating a targeted repair request. The former 4608-token segment budget also encouraged providers to return redundant whole-script metadata and truncate the required `s` array.
- Fix in 0.16.43: each incomplete direct segment now automatically retries only its own range with compact validation feedback, until the range validates or the user cancels / balance, authentication, API-key, or provider configuration blocks it. Segment output is explicitly constrained to `{ "s": [...] }`, and the budget is raised to 8192 tokens to preserve all five locked dialogue shots.
- Verification: deterministic regression test proves one failed S11-S15 segment is retried automatically while every completed segment is generated exactly once; full `npm test` passed 424/424 before packaging.
