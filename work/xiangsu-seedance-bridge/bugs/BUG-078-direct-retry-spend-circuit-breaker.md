# BUG-078

- Date: 2026-08-20
- Severity: S3
- Scope: all external text providers in direct script generation
- Incident: v0.16.43 retried semantically invalid direct-script segments without a limit. A Kimi project made 8,023 retry requests across two ranges overnight and consumed external balance.
- Root cause: the retry loop treated all non-authentication and non-balance failures as indefinitely repairable. Per-request session identifiers made every retry billable.
- Fix in 0.16.44: automatic repair is capped at one retry per segment and three retries per script run. Exhaustion persists the exact unfinished ranges and stops before another provider call; the user must explicitly continue to authorize a new repair window.
- Verification: regression tests cover automatic one-time repair and the package install is checked from the installed ASAR before handoff.
