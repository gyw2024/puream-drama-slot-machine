# BUG-142 — Dialogue binding corruption and repeated review amplification

Task TASK-20260907-AG-REVIEW-3-001; impact S2 / complexity C2 / D3.

## Confirmed causes

1. `buildEditedFullReferencePrompt` passed whole camera lines into `bindProviderCueSubjects`; source dialogue was exposed to Chinese alias and ID replacement. Saved keyframe S02/S04 showed 菜 replaced by an internal prop ID. Native post-conversion protected dialogue too late.
2. Review cache fingerprints belonged only to entire batches. One changed prompt invalidated unchanged siblings. Corrupt duplicate-ID cache rows could also falsely satisfy count checks while leaving another item unreviewed.
3. Source pruning omitted sceneId and propBindings from the reference entity set, especially for first/last-frame inputs.
4. Separate asset/video/still repair counters allowed repeated complete review preparation between each repair family.
5. Older deferred semantic records could lose per-shot pending flags. Approval checked those flags rather than all current semantic-pending evidence.

## Repairs

Protect dialogue spans before any silent-direction transform. Reuse only exact per-item/source/rules/reviewer-profile receipts, retaining negative findings. Require cache ID uniqueness and valid issue arrays. Keep scene and prop source context. Share an automatic repair-pass count across repair families. Unify semantic-pending checks across request, manual confirmation and submit boundaries.

The editable `ready` state intentionally remains different from approval. A reviewer outage remains compatible with explicit manual review; no global draw/concurrency restriction was introduced. AG advice to block every optional review failure was not applied because that would contradict the user workflow.

## Verification and status

AG completed exactly three text-only reviews (5, 1, 0 findings). The subsequent full regression exposed seven legacy/manual-flow failures: a missing optional semantic receipt had been incorrectly treated as an incomplete run. The final local correction distinguishes never-started legacy compilation from modern required authoring and explicitly started/deferred runs. All 1260 tests then completed: 1259 passed, 0 failed, 1 pre-existing skip. This final compatibility correction is locally regression-tested; it was not sent for a fourth AG review.

New failing regression cases were reproduced before repairs, then passed. Current authored saved prompts across five mode cases replayed 40/40 with exact dialogue and voice binding; the separate main film's 41 unfinalized shots remain explicitly unapproved. Final full test, third AG review and installation evidence must be read from the task evidence directory; this record alone is not an acceptance receipt.

Rollback: exact pre-task source/config copies in .codex_backups/TASK-20260907-AG-REVIEW-3-001. Existing 0.16.202 installer remains available. Do not overwrite business databases to undo a code change.
