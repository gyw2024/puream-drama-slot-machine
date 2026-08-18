# 0.16.21

## Asset cost and voice recovery hotfix

- Default asset generation now creates only character four-view and scene four-view images. It no longer submits the private `character_intro` image stage.
- Character videos and storyboard/video references reuse the existing character four-view asset.
- Candidate readiness now requires a real, non-empty local file. Missing character videos and voices cannot be reported as complete.
- Reusable library voices are materialized into the current project before downstream prompt binding.
- `SHOT_SPEAKER_VOICE_REQUIRED` performs one targeted asset recovery instead of repeating the generic repair loop.
- Legacy false-complete asset batches reopen at the asset stage without submitting paid work during startup.

## Verification

- Full local regression: 382 passed, 0 failed.
- Dedicated regression confirms three characters plus three scenes submit exactly six image requests and no `character_intro` request.
