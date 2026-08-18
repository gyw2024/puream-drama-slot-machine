# 0.16.26

- Fixed the video batch preflight state so the UI distinguishes local checks from submitted video jobs.
- Recovered projects no longer re-enter the retired storyboard-sheet crop gate that previously stopped all paid video submissions.
- Kept the project selector synchronized with the project actually loaded in the workbench.
- Added regression coverage for recovery routing, preflight visibility, and selector/queue state.

No live video generation was submitted during validation.
