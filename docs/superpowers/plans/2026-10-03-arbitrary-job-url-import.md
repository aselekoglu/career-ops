# Arbitrary Job URL Import Implementation Plan

> This ledger records implementation and acceptance evidence. The feature is complete for the scoped import → evaluation → CV flow; other MCP roadmap work remains separate.

**Goal:** Import one safely fetched public job posting into the canonical Career Ops Inbox and make its stored description available to evaluation and URL-based CV tailoring.

**Architecture:** A Node.js-only import service validates and canonicalizes the supplied URL, pins every request to DNS-validated public addresses, extracts ATS/JSON-LD/page data, and hands the result to the existing Neon document mutation path. The canonical `data/pipeline.md` row and hash-keyed imported-posting document commit together through the current CAS/idempotency writer. Evaluation and URL-based CV tailoring may consume the saved description only when its exact normalized URL matches the canonical Inbox URL.

**Tech stack:** Next.js route handler, TypeScript/ESM, Node `http`/`https`/`dns`/`net`, existing Neon document store, Node test runner.

**Spec:** `C:\Users\asele\.codex\attachments\6c883e1d-c940-4bf1-bdb9-16f58ffec97d\Pasted text.txt`

## Global constraints

- Accept public HTTP and HTTPS posting URLs independently of `portals.yml`.
- Never submit an application, contact an employer, execute page scripts, or obey page instructions.
- Reject private, local, reserved, multicast, and malformed destinations; validate every redirect and pin the socket lookup to validated DNS results.
- Bound redirects, response bytes, and total request time; send no caller cookies or credentials.
- Preserve the canonical Inbox lifecycle and exact evaluation URL guard.
- Do not infer company, title, location, salary, or other missing posting fields.
- Persist the canonical pipeline row and extracted posting atomically; duplicate imports are idempotent.
- `forceRefresh` must not resurrect evaluated/archived items or replace good saved content with a failed fetch.
- Keep unrelated tracker/CV metadata unchanged; never repair state with direct database writes.

## Implementation and evidence

### Task 1: Safe URL normalization, fetch, and extraction — complete

Files: `web/src/lib/job-import.mjs`, `web/tests/lib/job-import.test.mjs`.

- [x] Tests cover Lever `/apply` and tracking normalization, identity query preservation, invalid/private/mapped addresses, redirects, DNS pinning, timeout/byte limits, ATS/JSON-LD extraction, ambiguous/expired pages, and absent fields.
- [x] Implement pinned bounded requests, fixed Lever/Greenhouse/Ashby/Workday adapters, redirect canonicalization, exact/unique JSON-LD selection, and conservative generic HTML extraction.
- [x] Focused importer/store tests passed 33/33; parser hardening for malformed unrelated legacy Inbox rows passed 19/19.
- [x] Read-only pinned-fetch canaries parsed Magnet Forensics with 7,911 JD characters and Datadog with 3,743 characters, preserving `gh_jid`. Datadog was not written to the Inbox.

### Task 2: Atomic Neon Inbox import and API — complete

Files: `web/src/lib/cloud-tracker-management.mjs`, `web/src/lib/cloud-job-import.mjs`, `web/src/app/api/job-import/route.ts`, `web/src/proxy.ts`, `web/tests/lib/cloud-tracker-management.test.mjs`, `web/tests/lib/job-import-handler.test.mjs`.

- [x] Implement `findImport({originalUrl,normalizedUrl,source?,forceRefresh?})` and `importPosting({originalUrl,normalizedUrl,requestedNormalizedUrl?,source?,forceRefresh?,posting})`.
- [x] Commit the canonical pipeline row and top-level `data/job-imports/<sha256(normalizedUrl)>.json` record through existing Neon document and tracker mutation/CAS paths. No new table/schema is introduced.
- [x] Add fixed `POST /api/job-import`: URL 1–2,048 characters; optional source up to 500 characters; optional boolean `forceRefresh`; reject unknown fields; streamed JSON cap 4,096 bytes; Node runtime and no-store responses.
- [x] Restrict the proxy allow to this exact method/path behind existing Basic auth. Fail closed when `DATABASE_URL` is absent. Look up duplicates before network fetch and pass forceRefresh through to the existing lifecycle guard.
- [x] Return fixed safe error codes/messages; internal logs contain only the fixed event, stage, allowlisted error name, and safe internal code/SQLSTATE. Never log URLs, posting data, credentials, stack, or arbitrary exception text.
- [x] Focused tracker/store tests: 19 passed; malformed unrelated legacy row regression included. Safe logger regression: 1 passed.

### Task 3: Exact-URL stored JD consumers — complete

Files: `web/src/lib/cloud-evaluation-runs.mjs`, `web/src/lib/cloud-cv-runs.mjs`, `web/src/lib/cloud-career-ops.ts`, `web/tests/lib/cloud-evaluation-runs.test.mjs`, `web/tests/lib/cloud-job-import.test.mjs`.

- [x] Evaluation and URL-based CV tailoring use the imported sidecar only when top-level `normalizedUrl` exactly equals the canonical Inbox URL. Existing Inbox checks are unchanged.
- [x] Matched descriptions are bounded at the consumer without triggering an unpinned network refetch. Missing, malformed, and mismatched sidecars keep the previous fetch fallback.
- [x] Set Inbox `discoveredAt` from a valid explicit `discovered` label first, then a valid `imported` label; ATS `posted` remains a separate field.
- [x] Producer-shaped evaluation test proves a matching sidecar avoids network fetch. Focused API/consumer/evaluation tests passed 28/28.

### Task 4: Live acceptance and deployment — complete for this feature

- [x] Backend production READY: deployment `dpl_2sCsg2raXgXWz5Fe5uR9yRRETM2d`, SHA `3e6f36a17b763286c77ebbda7189be215f06182f`, alias https://career-ops-aselekoglu.vercel.app.
- [x] Private Sites v7: source `65f4d9d95523ee62be953bcbc41f3090165b257f`, environment revision 5, URL https://career-ops-chatgpt.aselekoglu.chatgpt.site, 16 MCP tools with import added and prior 15 preserved.
- [x] Full native Magnet import → duplicate checks → evaluation/report validation → CV generation → exact authenticated PDF download completed. Detailed calls, timestamps, and results: `docs/superpowers/plans/2026-10-03-job-import-acceptance.md`.
- [x] Final MCP bridge focused tests passed 28/28. Next production build passed with TypeScript and the `/api/job-import` route manifest; final date-reader TypeScript check passed.
- [x] The initial v6 `DATABASE_WRITE_FAILED` caused by malformed unrelated legacy Inbox input is resolved by commit `1e23a86a`; it is historical, not a current blocker.
- [ ] Tracker PDF marker/association remains pending: the generated PDF is downloaded and verified, but the tracker cell is still ❌. Do not manually alter Neon.
- [ ] Remaining P1/P2/P3 MCP roadmap work is outside this feature and is not marked complete here.
