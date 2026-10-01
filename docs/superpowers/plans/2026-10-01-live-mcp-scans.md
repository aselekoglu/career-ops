# Live MCP portal scans implementation plan

**Goal:** Start an actual configured-portal scan from ChatGPT and retrieve fresh, persisted results.

**Architecture:** Authenticated Sites MCP starts a durable Neon scan record through Vercel. Vercel dispatches a GitHub Actions worker immediately. The worker hydrates allowlisted scanner inputs through an authenticated Vercel callback, runs the existing scan.mjs/ATS adapters, and returns a receipt for atomic Neon persistence. Polling reads that scan record, never an old snapshot.

**Spec:** User-supplied 2026-10-01 live scanning requirements in this conversation.

**Constraints:** No application submission; configured enabled companies only; mode=portals initially; sinceDays 1..30; no arbitrary crawling; unknown ATS dates stay unknown; new discovery is distinct from posting date; existing local schedules remain unchanged; no credentials or career data in source or logs.

- [ ] Extend the existing scanner with an opt-in JSON receipt and actual ATS date evidence. Preserve all existing local behavior and filters.
- [ ] Add validated request/result contracts and focused tests for dates, failures, duplicates, unknown dates and zero results.
- [ ] Add durable scan storage, atomic worker claims, stale-job expiry and conflict-safe inbox persistence to Neon.
- [ ] Add short authenticated start/status/result and narrowly authenticated worker callback API routes. Keep all other cloud writes disabled.
- [ ] Add a GitHub Actions worker that executes the existing scanner from isolated hydrated files, without copying DB credentials or user CVs to GitHub.
- [ ] Extend Sites MCP with explicit start/status/results tools and write annotations only for start. Preserve existing read-only tools.
- [ ] Run focused tests, web checks/build, scanner regressions, workflow validation and an actual preview scan.
- [ ] Configure required runtime secrets and workflow registration; publish Vercel and Sites; validate a fresh scan through installed MCP tools.

## Failure handling and review

- One active cloud scan at a time; duplicate dispatch cannot claim a running job.
- A worker crash or dispatch rejection becomes a durable failed state, not permanent queued/running.
- Individual provider failures produce a partial result with explicit failed/skipped sources.
- Completion is idempotent and atomic with inbox updates; concurrent imports cannot be overwritten.
- Pipeline document reads must bypass the indefinite process cache after cloud scans are introduced.
- Unknown or future posting dates never appear in verified recent results.
- Workflow inputs must not enter shell command strings; worker authentication is separate from browser Basic credentials.

## Deployment prerequisites

Vercel: existing DATABASE_URL and Basic auth; CAREER_OPS_SCAN_DISPATCH_TOKEN (repository Actions:write); CAREER_OPS_SCAN_WORKER_SECRET; CAREER_OPS_SCAN_REF pointing at the reviewed worker branch.

GitHub repository: matching CAREER_OPS_SCAN_WORKER_SECRET; workflow file registered on default branch; worker code available on deployment ref. No DATABASE_URL or Basic password is copied to GitHub.

Sites uses its existing private Basic-auth secrets. New scan tools are enabled only after the worker path is ready.
