# BUG-081 Gemini throughput and full mode matrix

- Task: `TASK-20260823-GEMINI-FULL-MATRIX-001`
- Severity: S2
- Risk: C3
- Status: **fixed, packaged, installed, published and publicly verified**
- Patch: `0.16.89`

## Original symptoms

- Gemini choices contained retired or account-inaccessible model IDs.
- The adapter could send a provider-wide maximum instead of the selected stage budget.
- Token controls did not consistently use the selected model's advertised input/output limits.
- The old Simple-mode harness could enter Agent writing stages even though Simple mode is asset-only.

## Root cause

Provider capability metadata, request budgeting, UI configuration, and acceptance tests had evolved independently. Without a shared capability contract, stale model entries and invalid output budgets were possible. The old harness also conflated two different product modes.

## Local repair delivered

- Gemini catalog now derives selectable text models from the official Models API when available, keeps current fallback metadata, and separates specialized/shutdown entries from selectable text models.
- The 2026-08-23 selectable static fallback contains 12 current `generateContent` text/Gemma IDs. Specialized media, embedding, agent and shutdown entries remain visible only as non-selectable compatibility metadata. The final refresh corrected Gemini Omni, all three Veo 3.1 previews, Gemini Embedding 2 GA and the three retired Imagen 4 versioned IDs. A successful account `models.list` response, including a valid empty result, remains authoritative over this fallback.
- Both discovery and generation canonicalize a copied `.../v1beta/models` collection URL, so a successful refresh can never be followed by an invalid `.../models/models/{id}:generateContent` request.
- Requests preserve the selected model's supported input context and clamp output to the selected model/stage capability; current Gemini test requests use `maxOutputTokens=65536` where the selected model permits it.
- Topic output is exactly ten complete cards; bounded JSON repair carries the complete prior response and does not fabricate local topics.
- Simple mode is asset-only: asset creation/upload, storyboard-sheet prompt preparation, and video prompt preparation; no topic-writing stage is entered.
- Uploaded free-form scripts are AI-standardized before analysis; the dialogue ledger is structurally cleaned so production fields cannot become dialogue.
- Director/H3 prompt compilation preserves action, camera, state, speaker, emotion and reference bindings. Prompt corrections are upstream generation improvements; no downstream quality rejection loop was added.
- H3 metadata finalization now has a metadata-sanitization regression contract. The paid real-video evidence also exposed a delivery-path requirement: strip upstream workflow metadata before user delivery.

## Verification completed

### Automated local regression

`npm.cmd test` completed with **533/533 passed, 0 failed, 0 cancelled, 0 skipped** on the final 0.16.89 source state. A separate final prompt matrix completed **13/13** with zero API/media calls, and a source audit completed **62/62**. The suite includes provider catalog/budgeting, Models-collection URL canonicalization, account-authoritative empty model inventories, saved-model/UI consistency, Simple isolation, uploaded-script parsing/repair, prompt contracts, timing advisories, H3 metadata sanitization, detached pause/stop recovery, billing safety, and release contracts.

### Four-project pre-media full-chain run

Evidence: `.codex_tests/TASK-20260823-GEMINI-FULL-MATRIX-001/runs/2026-08-23T05-33-03-902Z-mock/report.json`.

All four projects reached prompt bundle readiness without media submission:

| Project | Mode | Prompt items | Result |
| --- | --- | ---: | --- |
| `project_mt5dffpt_76c7f671` | Agent complete-script | 27 | ready |
| `project_mt5dfgcj_9721a778` | Uploaded custom script, conversational format | 24 | ready |
| `project_mt5dfgmu_a425e76e` | Uploaded custom script, prose format | 34 | ready |
| `project_mt5dfgu5_69d4075e` | Simple asset-only | 15 | ready |

Total: **100 prompt items**, four isolated projects, zero media submissions. The uploaded tests exercised AI format adaptation before analysis; both format variants reached asset/storyboard/video prompt preparation.

### Video-mode matrix

Evidence: `.codex_tests/TASK-20260823-GEMINI-FULL-MATRIX-001/runs/mode-matrix-final-v3/mode-matrix-report.json`.

The final offline matrix passed all four modes with `contract=h3-final-prompt-v2`, `apiCalls=0`, `mediaSubmissions=0`:

- keyframe: ready, 33 prompt items
- continuation: ready, 28 prompt items
- smart keyframe/continuation: ready, 29 prompt items
- storyboard-sheet one-click path: ready, 27 prompt items

### Reference parity and positive-generation contract

Evidence: `.codex_tests/TASK-20260823-GEMINI-FULL-MATRIX-001/reference-audit/reference-parity-final-v4/reference-parity.json` and `.md`.

All four projects passed with zero failed checks, warnings or errors. Final runtime video prompts in all supported modes use a positive clean-story contract and no longer prime the video model with subtitle/caption/screen-text vocabulary. Static storyboard-image prompts retain their explicit clean-frame constraint. Dialogue remains exact inside `<d>` while tone, speaker, listener reaction, action, scene state, camera direction and reference bindings remain outside spoken text. A separate regression also prevents duplicated transition wording such as `then then`. These are source-generation corrections; no result-side media rejection loop was added.

### Real video forensic review

The single authorized Hailuo H3 shot was submitted once and settled. Evidence is under `.codex_tests/TASK-20260823-GEMINI-FULL-MATRIX-001/real-video/one-shot-s01/forensics/`.

- 8.00s, 24fps, 768x1344, H.264/AAC.
- 32-frame contact sheet: identities, wardrobe, bedroom set, action chain and speaker/mouth binding were visually coherent.
- One motivated hard cut at approximately 2.083s; no fragmented/repeated cuts.
- No visible subtitle, sticker, watermark or readable on-screen text in the 32-frame review.
- Local `faster-whisper-small` recovered both dialogue turns without truncation; the second line was fully recognized. The first line had a homophone uncertainty, so the report does not overclaim word-perfect ASR.
- The paid artifact exposed a real timing defect: the second line was authored for 2.0–5.0s but occurred approximately 4.47–7.83s, crossing the declared no-speech tail. The source compiler was then repaired to discard undersized authored dialogue windows, allocate the full clip adaptively from speech duration, align the hard cut to the speaker change, and remove the contradictory silent tail. This is a generation-side correction, not a result-side blocker.
- Original MP4 metadata exposed workflow internals. A stream-copy derivative with `-map_metadata -1` preserved all 192 decoded frames exactly (`maxPixelDiff=0`) while removing the `prompt` field. Product delivery must apply that finalization path.

### Final timing preflight

The final prompt compiler timing preflight is advisory and non-blocking: authored dialogue windows are inspected for overlap, complete turn coverage, speaker ownership, and no-speech tail consistency. If authored windows are inadequate, the compiler recomputes a bounded schedule from dialogue length/voice budget and carries the action forward; it does not delete dialogue or reject a shot. This behavior is covered by the timing and video-prompt regression tests in `scripts/` and by the `h3-final-prompt-v2` matrix above.

## Release artifact

Built artifact: `dist-fixed-0.16.89/纯梦短剧老虎机-安装版-0.16.89.exe`

- bytes: `126783554`
- SHA-256: `D1775103D1BDD5808710EE2CE1B6BA3C2501DFD38298B0FF9C8CF4F2B0CB9304`
- unpacked executable: `dist-fixed-0.16.89/win-unpacked/纯梦短剧老虎机.exe`
- unpacked/installed executable SHA-256: `F17605D89E694D7DB51A9DD5CF9E49E7656E0975D698697AC03B52504B05F98F`
- installed `app.asar` SHA-256: `08D9E669FDE66F39FB027A6AE81E794B05C438087499B28A0976BF816D338779`
- silent install exit: `0`; desktop shortcut targets the standard installed `0.16.89` executable.
- packaged UI, installed UI and Simple-mode headless audits passed with zero serious Axe findings, no horizontal overflow, and zero paid media submissions. Final packaged evidence: `.codex_tests/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/packaged-ui-0.16.89-recovery-final/2026-08-23T09-08-27-824Z`; final installed evidence: `.codex_tests/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/installed-ui-0.16.89-recovery-final/2026-08-23T09-09-55-665Z`; Simple evidence: `.codex_tests/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/simple-ui-0.16.89`.
- Authenticode status is `NotSigned`; this artifact is not represented as code-signed.
- The previous `9F3F0F...` and `54CC77...` packages are explicitly obsolete and must not be published. The locally installed pre-recovery 0.16.89 executable and `app.asar` are preserved under `.codex_tests/TASK-20260823-DRAMA-ADMIN-MULTIDEVICE-002/preinstall-obsolete-0.16.89-20260823-1719`.

## Production publication

The official website now serves `0.16.89` from `https://puream.cn/api/drama-slot/version`. A complete public HTTPS download returned `126783554` bytes with SHA-256 `D1775103D1BDD5808710EE2CE1B6BA3C2501DFD38298B0FF9C8CF4F2B0CB9304`, exactly matching the local release artifact. The obsolete `9F3F0F...` candidate is isolated under a hidden rejected server filename and is not referenced by the public manifest.

## Post-release observation (not a release blocker)

**OSS 24-hour elapsed observation:** production has an exact-expiry worker plus a dual-tag lifecycle fallback. Two live worker rounds scanned 41 temporary objects with zero cleanup failures; future-expiry, missing-tag and outside-prefix objects were retained. A naturally elapsed 24-hour observation cannot be accelerated and remains an operational observation rather than a local product gate.

## Evidence policy

No user credential is persisted or printed. No paid request was replayed after settlement. Local, private-production and public-download checks are reported separately so one layer is never used as evidence for another.
