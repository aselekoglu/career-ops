# Durable MCP evaluation run — implementation plan

## Objective
Expose a durable, asynchronous exact-inbox-URL evaluation path for the Sites MCP client. A run reaches `completed` only after a real canonical offer evaluation is validated and its report, tracker `Evaluated` row, and inbox completion are persisted atomically in Neon.

## Contract
- `POST /api/evaluation-runs`: JSON must contain exactly one of `url` (exact URL in `data/pipeline.md`) or `applicationNumber` (existing tracker ID for explicit rerun); optional bounded `idempotencyKey`.
- `GET /api/evaluation-runs/{UUID}`: safe durable fields only: `runId,status,company,role,applicationNumber,reportPath,score,requestedAt,startedAt,completedAt,errorCode,errorMessage`.
- `GET /api/evaluation-runs/{UUID}/report`: completed report text and safe metadata.
- Worker callback uses existing `CAREER_OPS_SCAN_WORKER_SECRET`, bearer auth, run UUID plus fenced lease; GitHub dispatch uses existing `CAREER_OPS_SCAN_DISPATCH_TOKEN` and `codex/vercel-hobby-fix` workflow ref.
- Lifecycle: `queued → running → committing → completed`, with terminal `failed`. Exact duplicate requests resolve to the existing run. Failed runs do not auto-retry; caller must explicitly resubmit.

## Implementation checklist
1. Inspect repo guidance, cloud scan/CV stores, hosted Gemini helpers, canonical `oferta` + shared rules, run prompts, tracker parsing/merge, report-number reservation, worker workflows, proxy/health, and current tests.
2. Record preflight findings and set the narrow API + persistence design before implementation.
3. Add focused contract/evaluator/persistence modules, Neon durable run store, run/report routes, authenticated fenced worker callback, and default-branch workflow; keep Gemini secret in hosted backend and run external work through the bounded worker.
4. Validate worker receipts before committing. Transaction/CAS must persist report document, canonical tracker row (`Evaluated`), exact inbox URL completion, and run completion together. Use exact URL identity, collision-safe report numbering, and idempotency fencing.
5. Add narrow proxy/health exposure only as required. Preserve existing basic auth and callback-only scope of worker secret.
6. Add focused tests for exact identity, durable state, atomic commit/persist failure, duplicate/idempotency, and auth/lease fencing. No full suite or browser tests.
7. Review the diff, run only meaningful focused tests, update the ledger, then wait for root's review before commit/push.

## Scope boundaries
Backend evaluation modules/routes/workflow/script, narrow proxy/health changes, focused tests, this plan, and its execution ledger. No user profile/CV edits, new secrets/paid resources, generic MCP shell/DB endpoints, sends, application submission, or unrelated edits.

## Preflight snapshot
| Check | Result |
|---|---|
| Assigned worktree | `career-ops-vercel-fix`, branch `codex/vercel-hobby-fix`, clean at `47da69ae8512dad111257c79cbf42a31a7dbbe87` |
| Existing backend pattern | Neon `career_ops_documents`; durable cloud scan/CV run rows; externally dispatched GitHub workers and bearer-fenced callbacks |
| Existing secrets | `CAREER_OPS_SCAN_WORKER_SECRET` for callbacks; `CAREER_OPS_SCAN_DISPATCH_TOKEN` for repository workflow dispatch |
| Required route | `/api/evaluation-runs`, `/api/evaluation-runs/{UUID}`, `/api/evaluation-runs/{UUID}/report`, `/api/evaluation-worker` |
| Update check | `node update-system.mjs check` => update available 1.26.0 → 1.35.0; branch intentionally remains at production-derived 1.26.0 per root direction |
| User data | CV/profile and tracker inputs remain read-only; evaluation output is limited to durable report/tracker/inbox writes after validated result |