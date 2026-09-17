# BUG-085 Gemini quota and video preflight network recovery

- Task: `TASK-20260823-DRAMA-GEMINI-VIDEO-RECOVERY-003`
- Severity: S2
- Risk: C2
- Target version: `0.16.91`
- Status: resolved locally; `588/588` automated regressions, packaged audits, silent installation, installed audits and byte-preservation gates passed
- Publication boundary: local Windows installation and standalone installer only; website remains unchanged

## Symptoms

1. Gemini returned a 429 quota response with an explicit recovery delay, but the script stage could stop on the first rejection even though the provider returned no text and no billable receipt.
2. A video batch could stop at reference-media upload or result download with the raw message `fetch failed`. In the upload case no paid video task ID existed; in the download case the remote generation could already have completed.

## Root causes

1. Gemini `PerDay` quota metadata overrode a finite provider recovery delay, and the fixed twelve-attempt ceiling could end before the shared twenty-minute admission budget.
2. Production provider calls, reference uploads and remote-result downloads did not consistently use Electron's `net.fetch`. Falling back to the Node/Undici network stack created a proxy, certificate and DNS behavior split between the desktop application and other clients using the same upstream.
3. A generic timeout, socket reset or `TypeError` on a billable POST does not prove whether the upstream accepted the request. The previous generic retry path could replay an ambiguous request; Gemini also marked a 200 response as accepted too late, after body consumption, and a compatibility fallback could replay an already accepted response.
4. Reference uploads lacked the final twenty-minute watchdog and same-content in-flight coalescing. Repeated shots could upload the same local reference concurrently, while one failed sibling could collapse the whole batch without retaining successful upload evidence.
5. A completed remote video followed by a local download failure was not represented as a recoverable same-task checkpoint. The recovery fingerprint also included expiring signed-query data, so the same result could appear to be a new request.
6. Remaining short media/status watchdogs could classify a legitimate long-running submission as a phantom before the production twenty-minute floor.
7. Partial semantic-shot checkpoints were not considered recoverable unless a separate failure marker had already been written. An interrupted structured-JSON suffix that resumed inside a string or delimiter could also be discarded even though it was valid continuation progress.
8. Workflow, batch and renderer status paths copied raw exception text into customer-visible state, exposing `fetch failed`, upstream URLs, request identifiers and provider internals.

## Required contract

- A transient Gemini admission rejection reuses one session ID and is governed by the cumulative twenty-minute wait budget, including request time, not a small fixed retry count.
- A daily quota response may honor one finite provider-directed recovery probe; if the project is still daily-quota blocked, the existing script checkpoint is paused without replaying accepted output or repeatedly consuming the provider's request allowance.
- Production provider, upload and remote-download traffic uses Electron's network stack so it follows the application's system proxy and certificate behavior.
- Explicit 429/5xx responses and provable pre-connect failures may recover within budget. An ambiguous billable POST timeout/reset, an accepted response whose body is interrupted, or any response carrying progress/usage/receipt is checkpointed and never blindly replayed.
- All saved semantic ranges, story spines, segments and shot plans are valid recovery evidence.
- Reference upload recovery reuses the same `clientRequestId`; identical reference bytes share one in-flight upload, completed URLs are cached within the logical run, and sibling outcomes are retained independently.
- A remote video that already has a `taskId` is only queried or downloaded. Download interruption is a same-task recovery point and cannot create another paid video task.
- All affected generation, upload, download, media-processing and no-task-ID recovery watchdogs have a production floor of at least twenty minutes; user pause/cancel remains immediate.
- Pre-task upload network failures remain recoverable and customer-visible state uses a sanitized actionable message instead of raw transport/provider text.

## Verification ledger

Confirmed release evidence:

- Full automated source suite: `588/588` passed.
- Network/idempotency adversarial coverage passed for Electron transport injection, Gemini accepted-response body interruption, ambiguous POST `TypeError`, provable pre-connect recovery, absence of fake Gemini idempotency headers, completed-video download recovery, signed-URL fingerprint stability, same-content five-way upload coalescing and same-idempotency cloud response loss.
- Reference-upload recovery coverage passed for the twenty-minute production watchdog and bounded test override.
- Provider-stream regressions passed for no replay after ambiguous timeout and for interrupted suffix continuation that begins inside an existing JSON value.
- License/concurrency regression remains green: `13/13` passed, including bounded offline grace without permitting a new generation lease.
- JavaScript syntax checks passed for the modified runtime modules.
- Build assets verified: bundled FFmpeg SHA-256 `2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3`; helper binaries also matched their locked hashes.
- Headless customer-error UI: workbench `25 + 5 network + 5 quota` cases and Simple mode `2 viewports + partial startup + network + quota` cases passed. No raw JSON, URL, request ID, model ID or credential fragment was visible; no horizontal overflow or serious Axe issue was found.
- Packaged runtime audit passed across `1024x720`, `1280x800`, `1440x900`, `1920x1080` and `200%` zoom. Simple mode packaged audit passed with the real first-run guide flow and 16 screenshots.
- Installer: `dist-fixed-0.16.91/纯梦短剧老虎机-安装版-0.16.91.exe`, `126795692` bytes, SHA-256 `4D47DB378F1268546DDAC5685BE43D7D27CA4EF08AED74846F9BAEBF081525E1`, Authenticode `NotSigned`.
- Silent installation exited `0`. Installed EXE version is `0.16.91`, SHA-256 `C88D73CDBC914CA55DB626267DF8B26F21DAC309A9DFF7CD17747BB02969D6B0`; installed `resources/app.asar` SHA-256 is `E5505E42F4DC4E1C57F9B93CBF431E737739CA6EC3CC8161EA4150F392CC637B`, exactly matching the packaged ASAR.
- Installed runtime audit passed with `paidJobCount=0`, `runningAutomationCount=0`, Foundry SQLite healthy, no page overflow, and the installed Simple mode audit passed all six pages and six size/zoom layouts.
- User-data preservation: `1093` files, `201` directories and `2470459706` bytes were hashed before and after installation; `added=0`, `removed=0`, `changed=0`. Both Foundry SQLite databases returned `quick_check=ok`.
- Obsolete `dist-fixed-0.16.90` was removed from the repository after an AES-256 WPS backup, remote hash/metadata verification, full 84-file restore comparison and seven pre-delete gates. The backup certificate is `.codex_tests/TASK-20260823-DRAMA-GEMINI-VIDEO-RECOVERY-003/cleanup/cleanup-certificate.json`.
- No paid upstream media generation was submitted during release verification. Provider behavior is proven by deterministic transport/idempotency contracts, not by spending customer quota.
- Website/update feed intentionally remains unchanged; this is a local installation and standalone installer delivery only.
