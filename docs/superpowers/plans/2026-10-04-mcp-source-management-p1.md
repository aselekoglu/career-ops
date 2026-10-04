# MCP Source Management P1 Implementation Plan

> **For agentic workers:** Implement the approved contract task-by-task. The source preview is review-only; only an explicit, hash-bound confirmation may apply it.

**Goal:** Add authenticated cloud read, proposal, confirmation, and immutable history operations for the primary CV and profile documents.

**Architecture:** A new cloud source service reads only fixed primary-document paths from the existing Neon document store. It persists immutable proposals, then applies a confirmed proposal with a single CAS-gated Neon statement that updates the source, creates/reuses content-addressed revisions, records an operation receipt, and writes an idempotency marker. Local file-backed CV/profile routes remain unchanged.

**Tech Stack:** Next.js Node route handlers, TypeScript/ESM, Neon SQL documents, YAML parser, Node test runner.

**Spec:** Root-approved P1 source management contract in the implementation task.

## Global constraints

- Sources are only `cv` (`cv.md`) and `profile` (`config/profile.yml`); no template seeding or missing-document creation.
- Preview never writes either source document. Apply requires explicit `confirm: true`, the proposal ID, expected base SHA, and operation UUID.
- Proposal previews preserve exact base/new hashes and the reviewed change details; stale, expired, altered, or unconfirmed proposals fail closed.
- Existing profile YAML keys outside the typed patch remain unchanged; malformed YAML is never overwritten.
- CV edits are ordered bounded exact replacements; each old string must occur exactly once at its step.
- Primary-source annotations must name an allowlisted logical path, current SHA-256, and exact snippet. Direct user-statement annotations remain explicit and reviewable.
- Source contents, annotations, credentials, and stack traces never enter logs. No live CV/profile mutation is part of implementation or tests.

## Review focus

- Source changed between preview and apply: reject on SHA mismatch and write no revision/receipt.
- Same operation ID and payload after a committed apply: return the receipt before checking the now-stale source SHA.
- Same operation ID with different payload: return idempotency conflict.
- Failure of any document CAS in the atomic statement: source, proposal/revision links, receipt, and mutation marker must all roll back.
- Warm serverless cache after apply: editable primary document reads must fetch fresh Neon content.

---

### Task 1: Source service contracts and preview

**Files:** Create `web/src/lib/cloud-source-management.mjs`; create `web/tests/lib/cloud-source-management.test.mjs`.

**Interfaces:**

- `createCloudSourceManagement({sql, now?})` returns `readSource(source)`, `createProposal(source,input)`, `getProposal(source,proposalId)`, `applyProposal(source,input)`, `listHistory(source,{limit,offset})`, and `getRevision(source,sha256)`.
- `source` is exactly `cv` or `profile`; map it to `cv.md` or `config/profile.yml` internally.
- Primary source and annotation text is capped at 200,000 UTF-8 bytes. Serialized proposal/revision records have a separate 2,000,000-byte cap so a valid maximum-size source plus exact reviewed diff and JSON escaping fits. SQL `CASE`/`octet_length` projections return content only under the corresponding cap and expose an oversize sentinel; JavaScript also checks returned byte length before hashing, parsing, or annotation processing. Oversize source returns `SOURCE_TOO_LARGE`; oversize stored records return `SOURCE_RECORD_TOO_LARGE`, never truncation.
- CV preview input: `{source:"cv",expectedSha256,operationId,edits:[{oldText,newText,sourceAnnotation:{kind:"user_statement"|"primary_source",reference:string}}]}`. Allow an empty `edits` array as an unchanged preview. Limit edits to 20, each replacement text to 20,000 characters, and resulting CV to 200,000 UTF-8 bytes.
- Primary-source `reference` grammar is `logical/path#<64-char current SHA-256>#<exact snippet>`; paths are `cv.md`, `article-digest.md`, `config/profile.yml`, `modes/_profile.md`, or one safe Markdown filename directly under `writing-samples/`. Verify the source path hash and exact snippet (at least 24 characters) against Neon before accepting the annotation. Operational `portals.yml` and procedural `modes/_custom.md` cannot support factual claims.
- Profile preview input: `{source:"profile",expectedSha256,operationId,patch:{name?,email?,location?,roles?,compMin?,compMax?,currency?,remote?},sourceAnnotations:{field:{kind,reference}}}`. Patch keys and annotation keys are closed; annotations cover each supplied field. `compMin` and `compMax` must be provided together and form a nonnegative ordered range.
- Preview returns `{proposalId,source,status:"preview",baseSha256,proposedSha256,diff,expiresAt}` and stores that exact preview under `data/source-proposals/<operationId>.json` through the existing idempotency/CAS mechanism. It does not write the source. Source and revision reads recompute SHA-256 over UTF-8 content and fail closed if stored hash metadata disagrees.
- CV diff entries carry exact `oldText`, `newText`, and annotation. Profile diff entries carry the logical profile field plus before/after values and annotation. Proposal lifetime is 24 hours.

- [x] Add tests for unique sequential exact replacement, overlapping/duplicate match rejection, stale base SHA, annotation verification/revalidation, and preview-only persistence.
- [x] Add profile tests for closed patch keys, unknown YAML key preservation, malformed YAML and malformed-parent rejection, and no-op byte preservation.
- [x] Implement source read, proposal creation/read, exact diff, 200 KB source/output bounds, source/revision SHA verification, and current/expired/stale proposal status.
- [x] TDD evidence: the initial test run failed because the service module was missing; red runs exposed overlapping-match, inherited-selector, prior-operation-replay, expiry/provenance-revalidation, history-projection, and bound regressions, each now has a focused case.

### Task 2: Confirmed apply, immutable revisions, and history

**Files:** `web/src/lib/cloud-source-management.mjs`; `web/tests/lib/cloud-source-management.test.mjs`.

**Interfaces:**

- Apply input: `{proposalId,expectedSha256,operationId,confirm:true}`. The route source must equal the stored proposal source.
- Successful apply atomically CAS-checks the current source SHA and writes the new source, any absent content-addressed snapshots at `data/source-revisions/<source>/<contentSha256>.json`, and `data/source-receipts/<source>/<operationId>.json`, alongside the `career_ops_tracker_mutations` idempotency marker. Revision records preserve exact source content and its SHA; receipts link proposal, before/after SHA, annotations, operation ID, and timestamps.
- Existing matching content-addressed revisions are reused only after validating their embedded source and content SHA; revision records are never overwritten.
- Check mutation replay before source freshness so a retry of the same committed operation returns its original receipt. Changed payload under the same operation ID is `IDEMPOTENCY_KEY_CONFLICT`; stale base, expired proposal, or missing confirmation writes nothing.
- History listing returns `{history:[metadata],pagination:{limit,offset,nextOffset}}`, with annotation counts and proposal IDs (`limit` 1–100, `offset` 0–10,000); receipts persist `sourceAnnotationCount`, and the UTF-8-filtered limit+1 query projects only receipt metadata, never source annotations or document text. Exact revision reads require the fixed source and a 64-character SHA path; exact proposal reads return the reviewed diff/annotations.

- [x] Test confirmation/expiry/stale SHA, same-operation replay before stale checks, conflicting operation ID, immutable revision reuse, and limit+1 metadata-only history pagination.
- [x] Test CAS miss leaves source, revisions, receipt, and mutation marker unchanged in the transactional SQL test harness; assert the SQL statement gates all writes on CAS and asserts every expected document write.
- [x] Implement atomic apply, revision retrieval, and bounded metadata-only history; history omits source snippets and returns a proposal pointer plus annotation count.

### Task 3: Fixed API paths and cache freshness

**Files:** Create `web/src/app/api/sources/[source]/route.ts`, `web/src/app/api/sources/[source]/proposals/route.ts`, `web/src/app/api/sources/[source]/proposals/[proposalId]/route.ts`, `web/src/app/api/sources/[source]/apply/route.ts`, `web/src/app/api/sources/[source]/history/route.ts`, `web/src/app/api/sources/[source]/history/[sha256]/route.ts`; modify `web/src/proxy.ts` and `web/src/lib/cloud-store.ts`.

**Interfaces:**

- `GET /api/sources/{cv|profile}` returns `{source,content,sha256}` only for an existing UTF-8 document.
- `POST /api/sources/{cv|profile}/proposals` creates the source-specific preview; `GET /api/sources/{cv|profile}/proposals/{proposalId}` reads the exact stored preview.
- `POST /api/sources/{cv|profile}/apply` performs the confirmed apply; `GET /api/sources/{cv|profile}/history` lists metadata; `GET /api/sources/{cv|profile}/history/{sha256}` reads one exact revision.
- Proxy allows only those fixed source names, paths, and methods after the existing Basic-auth gate. No generic path or method dispatch.
- `getCloudDocument` bypasses its warm cache for `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `article-digest.md`, `portals.yml`, and `reports/` paths.

- [x] Add handler tests for fixed source selection, JSON content type, streamed body limits without Content-Length, malformed/duplicate/out-of-range history parameters, and safe errors.
- [x] Add a cache-freshness test showing editable primary-source paths bypass warm document caching.
- [x] Implement fixed routes, exact proxy allows, and fresh source reads.

### Task 4: Integration handoff

**Files:** Update this plan with final focused evidence; no MCP bridge changes in this task.

- [x] Send route schemas to the MCP bridge owner; history returns bounded metadata pagination and proposal reads carry the reviewed diff/annotations.
- [x] Run `node --test tests/lib/cloud-source-management.test.mjs` from `web/`: 23 passed, 0 failed.
- [x] Root integrated Next production build passed (session 33925, exit 0): TypeScript compiled and all six fixed source route paths appeared in the route manifest.
- [ ] Native CV/profile no-op acceptance remains pending deployment of the MCP bridge. No live source apply, browser QA, or broad repository suite was run.
- [ ] Confirm the source-management P1 roadmap remains scoped to this capability; do not mark remaining CV intake, exports, or unrelated P1/P2/P3 work complete.
