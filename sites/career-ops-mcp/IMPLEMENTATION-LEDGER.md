# Evaluation MCP bridge implementation ledger

- [x] Advertise bounded evaluation start, status, and persisted-report tools.
- [x] Validate exclusive application number or exact inbox URL, bounded idempotency key, and UUID run IDs.
- [x] Use only the fixed evaluation API routes and the existing auth/origin helper.
- [x] Allowlist backend fields; report reads require backend status `completed`.
- [x] Run `node --test tests/server.test.mjs` once after edits (22/22 passed).
- [x] Root reviewed and approved the scoped bridge diff.
- [x] Mirror the reviewed source files into the backend feature branch after coordination; this nested repository has no remote, so do not push from it.

Backend agreement: `POST /api/evaluation-runs`, `GET /api/evaluation-runs/{UUID}`, and `GET /api/evaluation-runs/{UUID}/report`. Lifecycle is `queued`, `running`, `committing`, `completed`, `failed`. Report response is `{runId, reportPath, contentType, report}` for completed runs only.

## Source mirror

- Mirrored into `career-ops-vercel-fix/sites/career-ops-mcp` from nested source commit `3474173d77d3b58bf82e811410c8180e9e4e6f4a`.
- Mirrored files: `.gitignore`, `AGENTS.md`, `IMPLEMENTATION-LEDGER.md`, `package.json`, `.openai/hosting.json`, `scripts/build.mjs`, `src/panel.mjs`, `src/server.mjs`, `tests/server.test.mjs`.
- SHA-256 verified for the copied source files against the nested source checkout before this destination ledger annotation was appended.
- No `.git`, `node_modules`, `dist`, environment files, credentials, or runtime secrets were copied.
- The nested checkout has no remote; backend feature branch owns the next reviewed push. Do not publish the new tools until the evaluation API is live.
