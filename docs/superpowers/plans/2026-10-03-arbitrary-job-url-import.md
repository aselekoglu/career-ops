# Arbitrary Job URL Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import one safely fetched public job posting into the canonical Career Ops Inbox and make its stored description available to evaluation and URL-based CV tailoring.

**Architecture:** A Node.js-only import service validates and canonicalizes the supplied URL, pins every request to DNS-validated public addresses, extracts ATS/JSON-LD/page data, and hands the result to the existing Neon document mutation path. The canonical `data/pipeline.md` row and a hash-keyed imported-posting document commit together through the current CAS/idempotency writer; evaluation may consume the saved description only when its exact URL matches.

**Tech Stack:** Next.js 16 route handlers, TypeScript/ESM, Node `http`/`https`/`dns`/`net`, Neon SQL documents, Node test runner.

**Spec:** `C:\Users\asele\.codex\attachments\6c883e1d-c940-4bf1-bdb9-16f58ffec97d\Pasted text.txt`

## Global Constraints

- Accept public `http` and `https` posting URLs independently of `portals.yml`.
- Never submit an application, contact an employer, execute page scripts, or obey page instructions.
- Reject private, local, reserved, multicast, and malformed destinations; validate each redirect and pin the socket lookup to validated DNS results.
- Bound redirects, response bytes, and total request time; send no caller cookies or credentials.
- Preserve the canonical Inbox lifecycle and exact evaluation URL guard.
- Do not infer company, title, location, salary, or other missing posting fields.
- Persist the canonical pipeline row and extracted posting atomically; duplicate imports are idempotent.
- `forceRefresh` must not resurrect evaluated/archived items or replace good saved content with a failed fetch.

## Review Focus

- Mixed public/private DNS answers and redirect-to-private targets must fail before connecting; pinning tests prove the actual socket address.
- Concurrent requests for one normalized identity must leave one Inbox row and one matching sidecar.
- Evaluated/archived and tracker-linked exact URLs must be reported as existing and never reset to unchecked.
- Query parameters that can identify a job must survive canonicalization; only known tracking data may be stripped.
- Evaluation may reuse imported text only when the sidecar's normalized URL equals the requested Inbox URL.

---

### Task 1: Safe URL normalization, fetch, and extraction

**Files:**
- Create: `web/src/lib/job-import.mjs`
- Create: `web/tests/lib/job-import.test.mjs`

**Interfaces:**
- Produces `normalizeJobUrl(url)`, `validateJobUrl(url)`, `resolveAtsPosting(url)`, `fetchPublicPosting(url, options?)`, `extractJobPosting(html, url)`, `importedPostingPath(url)`, and `importPosting(url, options?)`.
- Extracted fields are nullable unless explicit in Lever/JSON-LD/page metadata; response data is treated as inert untrusted text.

- [x] Write tests for Lever `/apply` plus tracking normalization, identity query preservation, invalid/private/mapped addresses, redirects, DNS pinning, timeout/byte caps, ATS/JSON-LD extraction, ambiguous/expired pages, and absent fields.
- [x] Run the initial focused tests and confirm feature-related failures.
- [x] Implement pinned bounded requests, fixed-host Lever/Greenhouse/Ashby/Workday adapters, redirect canonicalization, exact/unique JSON-LD selection, and positive-evidence generic HTML extraction.
- [x] Re-run `node --test tests/lib/job-import.test.mjs` from `web/` (15 tests pass).
- [x] Read-only Magnet Forensics fetch parsed company and role with 7,911 description characters.
- [x] Read-only Datadog company-hosted canary parsed company and role, preserved `gh_jid`, with 3,743 description characters.

### Task 2: Atomic Neon Inbox import and API

**Files:**
- Modify: `web/src/lib/cloud-tracker-management.mjs`
- Modify: canonical Inbox add line construction in the same module
- Test: `web/tests/lib/cloud-tracker-management.test.mjs`

**Interfaces:**
- Produces `store.findImport({originalUrl,normalizedUrl,source?,forceRefresh?})` and `store.importPosting({originalUrl,normalizedUrl,requestedNormalizedUrl?,source?,forceRefresh?,posting})`.
- Uses the shared Inbox row formatter; canonical pipeline, hash-keyed posting sidecar, optional redirect alias, and unchanged tracker CAS guard commit through the existing document writer.
- API route/proxy and exact-URL evaluation/CV consumers are integration work.

- [x] Add persistence tests for canonical/report duplicates, concurrent imports, redirect aliases, and refresh preserving checked rows/content.
- [x] Run initial persistence tests and confirm the expected missing-method failures.
- [x] Implement stable IDs, canonical dedup, CAS retries, tracker-report recognition, and concurrent evaluation guards.
- [x] Add `POST /api/job-import` with a bounded closed JSON contract, safe structured errors, and a Basic-authenticated proxy allow for this method/path only.
- [x] Check canonical duplicates before fetching; forward `source` and `forceRefresh` to the Neon CAS-backed importer; fail closed without `DATABASE_URL`.
- [x] Re-run `node --test tests/lib/cloud-tracker-management.test.mjs` from `web/` (18 tests pass).

### Task 3: Evaluation consumes exact-URL imported JD

**Files:**
- Modify: `web/src/lib/cloud-evaluation-runs.mjs`
- Modify: `web/tests/lib/cloud-evaluation-runs.test.mjs`

**Interfaces:**
- Evaluation looks up `data/job-imports/<sha256(normalizedUrl)>.json` and uses its extracted JD only when its embedded normalized URL exactly equals the existing Inbox URL.

- [x] Add a producer-shaped sidecar regression proving evaluation uses an exact-URL imported JD without a network refetch; mismatching/missing/malformed sidecars keep the prior fetch path.
- [x] Implement a shared exact-URL sidecar reader for evaluation and URL-based CV tailoring without changing either existing Inbox guard; bound over-limit matched text at the consumer instead of refetching it.
- [x] Run focused handler/consumer/evaluation tests: 28 passed, 0 failed.

### Task 4: Verification and feature ledger

**Files:**
- Update this plan with completion marks/evidence.

- [x] Integrated verification (parent-owned): backend 33/33; API/consumer 28/28; MCP 26/26 focused tests passed. Next production build passed, including TypeScript and `/api/job-import` route manifest.
- [x] Review owned parser/store changes for SSRF, CAS atomicity, exact URL matching, and lifecycle preservation.
- [x] Read-only Magnet Forensics fetch parsed company and role with 7,911 description characters; this did not exercise the native MCP import/evaluation/CV flow.
- [ ] Complete live Magnet native MCP import → evaluation → CV acceptance in the target cloud environment.
- [ ] Deploy and verify the integrated feature in production.
