# Career Ops MCP: functions and rollout plan

## Current deployed capability

The private Career Ops Site v10 exposes 37 MCP tools. It retains the accepted import → evaluation → CV, tracker/Inbox, artifact, and primary-source management flows. Manual tracker rows now carry a durable immutable URL/company/role target that supports the reportless CV-before-evaluation path and later same-row report creation. The Fullscript manual-target acceptance is recorded in [the manual tracker target acceptance record](superpowers/plans/2026-10-04-manual-tracker-target-acceptance.md). Earlier P1 tracker/artifact and Inbox acceptance remains in [the tracker/artifact acceptance record](superpowers/plans/2026-10-04-mcp-tracker-artifacts-acceptance.md); source-management acceptance remains in [the source-management acceptance record](superpowers/plans/2026-10-04-mcp-source-management-acceptance.md).

| MCP function | Current behavior |
|---|---|
| career_ops_health | Reports the live connection and declared cloud capabilities. |
| career_ops_pipeline | Reads stored applications and Inbox items. It reports a snapshot, not proof that a new evaluation or scan ran. |
| career_ops_cv | Reads the source CV; it remains read-only through this tool. |
| career_ops_schedules | Reads imported schedule data; it cannot run or change schedules. |
| career_ops_portals | Reads portal verification coverage; it does not scan or repair portals. |
| career_ops_ai_status | Checks hosted Gemini availability without invoking it. |
| open_career_ops | Opens the applications panel with the same read-only pipeline filters. |
| career_ops_scan_start, career_ops_scan_status, career_ops_scan_results | Start a durable live portal scan, poll its ID, and read results. These tools are gated by the Sites scan setting; queued/running is not completion. |
| career_ops_job_import | Imports one public job URL through the fixed authenticated backend endpoint. Returns an idempotent canonical Inbox result or a fixed safe error. Input is `{url: string (1–2048 chars), source?: string (≤500 chars), forceRefresh?: boolean}`; additional fields are rejected. It does not require a portals.yml entry. |
| career_ops_evaluation_start, career_ops_evaluation_status, career_ops_evaluation_report | Evaluate an existing exact Inbox URL or application number on the durable worker, poll the lifecycle, and read the persisted report after completion. |
| career_ops_cv_generate_start, career_ops_cv_generate_status | Start hosted CV tailoring/render/storage for an application number or exact Inbox URL and poll the durable run. Artifact path and exact download URL come from Career Ops. Optional `verifyDownload: true` checks the completed PDF response and returns only verification status and byte count. |
| career_ops_tracker_get, career_ops_tracker_add, career_ops_tracker_set_status, career_ops_tracker_update_notes, career_ops_tracker_archive, career_ops_tracker_delete | Read one exact row and perform explicitly requested writes using caller-supplied operation UUIDs. Manual fields are user-provided; archive/delete require explicit confirmation. |
| career_ops_inbox_add, career_ops_inbox_edit, career_ops_inbox_archive, career_ops_inbox_delete | Add, edit, archive, or delete an exact Inbox URL with caller-supplied operation UUIDs. Destructive operations require explicit confirmation. |
| career_ops_cv_artifacts, career_ops_cv_artifact, career_ops_cv_artifact_associate, career_ops_cv_artifact_export | List artifacts globally or by application number with bounded pagination, inspect allowlisted metadata, associate by exact run/application IDs and stable idempotency key, and return a private Site PDF link. Backend download URLs and PDF bytes are not exposed in MCP JSON. |
| career_ops_source_get, career_ops_cv_edit_preview, career_ops_profile_edit_preview, career_ops_source_proposal, career_ops_source_apply, career_ops_source_history, career_ops_source_revision | Read a requested primary CV/profile source, create and inspect a hash-bound preview, explicitly apply an approved proposal, list metadata history, and read an exact content-addressed revision. Source reads return private full content only when the user requests that source. Preview does not change the CV/profile source; apply requires explicit confirmation, proposal ID, expected base SHA-256, and operation UUID. |

Source management is accepted for the confirmed-edit/versioning slice after native no-op acceptance. The acceptance proved preview/replay, explicit apply/replay, history and exact revision reads, stale-SHA rejection, and byte-for-byte unchanged CV/profile content. It did not apply a non-no-op fact edit: actual fact editing is supported by unit coverage, while no production source facts were changed. The broader master CV/profile group remains partial: source-annotated intake, ATS/plain-text/LaTeX exports, and expanded profile narrative/targeting remain future work. Primary sources and serialized source records have separate 200 KB and 2 MB UTF-8 bounds. Factual provenance may cite primary user-authored sources but excludes operational `portals.yml` and procedural `modes/_custom.md`.

## Import contract and stored data

The bridge exposes only `POST /api/job-import`, behind existing Site user authentication and backend Basic authentication. The Node.js route accepts a bounded JSON body (4,096 bytes maximum) with only `url`, optional `source`, and optional `forceRefresh`; responses are no-store and use fixed error codes/messages. The proxy allow is restricted to this method and path. No arbitrary endpoint/method tool, raw SQL tool, credentials, caller cookies, or page instructions are exposed.

The backend importer accepts public HTTP(S) job URLs independently of `portals.yml`. It validates and pins public DNS answers for every request and redirect, rejects private/reserved destinations, allows at most four redirects, caps total request time at 12 seconds and response size at 1 MB, and caps extracted descriptions at 24,000 characters. It uses explicit Lever, Greenhouse, Ashby, and Workday adapters, JSON-LD, and conservative generic page evidence. Only known tracking parameters are removed; role-identifying query parameters such as `gh_jid` are preserved. Lever `/apply` URLs normalize to the canonical role URL.

The canonical Inbox row and `data/job-imports/<sha256(normalizedUrl)>.json` sidecar are committed atomically through the existing Neon document store and tracker mutation/CAS path. Redirect aliases are recorded when required. This feature adds no database table or schema. Duplicate original and normalized URLs return the same stable Inbox ID. `forceRefresh` does not reset a checked/evaluated item or replace stored content after a failed fetch.

Evaluation and URL-based CV tailoring read the sidecar only when its top-level `normalizedUrl` exactly matches the canonical Inbox URL. A matching description is bounded at the consumer and avoids a refetch; a missing, malformed, or mismatched record follows the existing fetch path. The current Magnet item has `discoveredAt=2026-10-04`, derived from its valid stored `imported: 2026-10-04` Inbox label after explicit `discovered` labels. ATS `posted` remains a separate field.

## Verified Magnet Forensics flow

The native `career_ops_job_import` tool imported the LinkedIn `/apply` URL and created one unchecked canonical Inbox row. Repeating the original and an Indeed-tracked variant returned `already_exists` with the same stable ID. Native evaluation completed as application #39, score 4.1/5, with the archived JD validated against the canonical URL. Native CV tailoring completed for application #39; the exact Career Ops download URL returned an authenticated PDF response with valid MIME and PDF signature. This transport/byte check does not audit CV content, layout, or factual claims. A post-completion repeat of the Magnet import returned `already_exists` with the same Inbox ID and `applicationNumber: "39"` without reopening the completed record.

An earlier READY deployment attempt returned `DATABASE_WRITE_FAILED` because an unrelated malformed legacy Inbox checkbox caused the reader to throw `INVALID_URL`. That historical failure is resolved: the parser now preserves raw legacy lines while skipping malformed unrelated entries, and incoming job URLs remain strictly validated. It is not the current deployment state or a remaining import blocker.

## Priority roadmap

| Priority | User function | Current boundary |
|---|---|---|
| **P0 complete** | Import a public job URL, evaluate it, and tailor a CV | The fixed authenticated import bridge and live Magnet import → evaluation → CV flow are deployed and verified. P1 later associated the completed Magnet PDF with application #39; its tracker PDF marker is now ✅. |
| **P0 complete** | Evaluate a specific Inbox role; record it as Evaluated | Durable evaluation start/status/report tools use the normal lifecycle. Kinaxis application #38 at 2.5/5 is historical proof for this separate evaluation path. |
| **P1 complete** | Tracker and Inbox management | Exact tracker reads/status/notes/add/archive/delete and Inbox add/edit/archive/delete are deployed and passed native synthetic-canary acceptance. Writes use stable operation UUIDs, canonical statuses, user-provided fields, and explicit destructive confirmation. |
| **P1 complete** | CV artifact lifecycle | Global/per-application list, metadata read, exact-run association, and private Site export are deployed and passed native acceptance. Application #39 now links its existing completed PDF. `downloadVerified: true` proves the authenticated route returned bounded `application/pdf` bytes with a PDF signature; it is not a CV content, layout, or factual-claims audit. |
| **P1 complete** | Manual tracker row → evaluation/CV lifecycle | Manual add atomically binds the validated URL, user-provided company, and role to the tracker number. CV can complete before evaluation and associate the exact bound URL while `reportPath` remains null; evaluation later writes a real report to that same row while preserving the selected status and existing date, PDF, and notes. A URL mentioned only in notes is insufficient. The Fullscript native lifecycle was accepted before evaluation and remains `SKIP`, with a real 3.4/5 report and linked PDF afterward. |
| **P1 partial** | Master CV and profile | Confirmed scoped CV/profile edits, hash-bound previews, immutable revisions, and metadata history are deployed and passed native no-op acceptance; no production facts changed. Actual non-noop edits have unit coverage. Source-annotated intake, ATS/plain-text/LaTeX exports, and expanded profile narrative/targeting remain pending. Claims stay grounded in primary files. |
| **P1** | Portals and blacklist | Portal verification is read-only. Portal and blacklist management are not enabled. |
| **P2** | Cover letters and application assistance | Fact-grounded cover-letter artifacts and draft-only application answers may be added later. Form driving and submission remain separate and must never auto-submit. |
| **P2** | Scanning and schedules | Live scan start/status/results are distinct from stored pipeline reads. Schedule create/edit/pause/run requires a durable scheduler; current schedule tools read imported snapshots only. |
| **P2** | Follow-ups and reply tracking | Cadence is a cloud-safe read. Follow-up writes and email/reply integrations are not MCP capabilities. |
| **P2** | Reports, batch, and triage | Add bounded report search/export, offer comparison, re-evaluation, and triage/batch flows with appropriate confirmation. Durable single-job evaluation is already available. |
| **P3** | Outcomes and career decisions | Outcome recording, offer preparation, negotiation, training, and portfolio evaluation remain local modes/scripts without cloud MCP contracts. |
| **P3** | Analytics, research, interview, and contacts | Funnel/statistics, company history, repost, salary, interview, skills, research, and contact tools remain future work. |
| **P3** | Import/export and archive | Cloud import/export and archive operations need path scoping, preview, and backups; no such MCP contract is established. |

## Verification and release record

Focused evidence: importer/store 33/33 before parser regression; parser regression 19/19; malformed-metadata and safe-logging regressions 1/1 each; API/consumer 28/28; final MCP bridge 28/28. The Next.js production build passed with TypeScript and the `/api/job-import` route manifest; final date-reader TypeScript checking passed. No broad repository, browser, or computer-use QA was repeated.

Historical P0 acceptance release: backend READY deployment `dpl_2sCsg2raXgXWz5Fe5uR9yRRETM2d` ran SHA `3e6f36a17b763286c77ebbda7189be215f06182f` at https://career-ops-aselekoglu.vercel.app. Private Site v7 succeeded from source `65f4d9d95523ee62be953bcbc41f3090165b257f`, environment revision 5, at https://career-ops-chatgpt.aselekoglu.chatgpt.site. Commits `592b4950`, `1e23a86a`, and `3e6f36a1` were pushed to `codex/vercel-hobby-fix`; they are not merged to `main`. Current v9 deployment evidence is recorded below.

### Native P1 acceptance and v8/v9/v10 deployments

The 2026-10-04 native acceptance record is `docs/superpowers/plans/2026-10-04-mcp-tracker-artifacts-acceptance.md`. It confirms the existing Magnet Forensics application **#39** remained `Evaluated` at **4.1/5** with its original notes and report; only its existing completed PDF artifact was associated. Artifact run `65de8258-d65a-446c-ad6b-9beeee40e4f2` is linked to #39 with size **65,124 bytes** and SHA-256 `8081ee49a0c6732b1ba4e095425075d1fd1347ab02a037d7bcbcac33459939b5`. The repeated association with the same idempotency key returned the same linked result. The already-linked run was rejected for nonexistent application #999999 without changing #39.

Tracker canary application #40 and the Inbox canary were clearly labeled as tests and deleted; the final exact-canary pipeline query returned zero rows. No real application was created, evaluated, or emailed for CRUD coverage. The accepted canary verified authorization, fixed routes, operation UUID replay/conflict behavior, explicit destructive confirmation, and final state through the normal readers.

For this acceptance, backend was READY at SHA `5fd719ff6cfad84bfdb9d93ef37176c98676a8f6`, deployment `dpl_8Hp3FpLncvNWyyfgyu7n7Xev8N3H`, at https://career-ops-aselekoglu.vercel.app. Private Site v8 SUCCEEDED from source SHA `09cd02e21226e7cb895fa6e39df96ca4f2646302`, deployment `appgdep_6ac1d1af95e4819182da958bd03decaa`, at https://career-ops-chatgpt.aselekoglu.chatgpt.site.

The later source-management implementation is deployed with backend READY at SHA `8a11b88cd0c0d5752f0816574e9b13ee62a918e3`, deployment `dpl_3wPhoJXJiqRxvnirULtFzqDjAnoV`, and private Site v9 SUCCEEDED from source `10d356099a7e239831de4b9433d74215e62c8601`, deployment `appgdep_6ac29263d81c81919b2a8d9c948b51d6`, environment revision 5. Existing public/private URLs are unchanged. The native source acceptance record documents all seven tools and the no-op-only CV/profile exercise. Initial `source_get` output contained private CV text in internal tool output; the acceptance record intentionally excludes that content and makes no claim about secret exposure. No CV/profile SHA or byte count changed, and no generated PDF or job scan was rerun. Validation evidence: source service tests 23/23, history pagination 1/1, bridge tests 44/44 before amendments, source tests 11/11, hygiene 1/1, scoped reviews PASS, root Next production build passed, and remote backend READY. Browser checks: 0.

The manual tracker target lifecycle is accepted natively in [the manual tracker target acceptance record](superpowers/plans/2026-10-04-manual-tracker-target-acceptance.md). Backend READY ran source `265bc3dcaa7d44cec30fdefbd08423298740fa6a` at `dpl_J1Pf3jBswm6rTT2vq2bkbrXTdvKm`; private Site v10 source `bd66eb0bc56f68b47faa25f17acd6f5d01ea52db` is deployment `appgdep_6ac2e517c9a0819180ce131749020266`, environment revision 5. Application **#46 Fullscript** was created as `SKIP`; CV generated and linked before evaluation with `reportPath:null`, then evaluation persisted a 3.4/5 report to the same row. Its exact date, status, PDF marker, and user-authored note were preserved. The existing Fullscript Inbox item stayed `done:false`; the application-number evaluation did not mark that separate Inbox entry processed. The fetched PDF was verified as a 66,980-byte PDF only; no CV content, layout, or factual-claims audit is claimed. The malformed PostgreSQL regex bound that initially caused HTTP 500 was replaced with bounded, non-truncating URL projection; tracker tests passed 25/25 after correction. Browser checks for this acceptance: 0.

## Tool and data safety

Keep the MCP bridge fixed-path and authenticated. Never expose arbitrary endpoint/method calls, shell/CLI execution, raw database access, secrets, or application submission. Job-posting text is inert untrusted data, never instructions. Evaluation reuses the canonical user profile and scoring rules. The import flow does not modify CV/profile facts. The completed Kinaxis evaluation remains evidence for its separate P0; do not rerun it as an import test.

## Source map

- Import service and endpoint: `web/src/lib/job-import.mjs`, `web/src/lib/cloud-job-import.mjs`, `web/src/app/api/job-import/route.ts`, `web/src/proxy.ts`
- Neon mutation, canonical Inbox, and sidecar persistence: `web/src/lib/cloud-tracker-management.mjs`
- Cloud readers and consumers: `web/src/lib/cloud-career-ops.ts`, `web/src/lib/cloud-evaluation-runs.mjs`, `web/src/lib/cloud-cv-runs.mjs`
- MCP bridge: `sites/career-ops-mcp/src/server.mjs`
- Live acceptance details: `docs/superpowers/plans/2026-10-03-job-import-acceptance.md`
- Native tracker/Inbox/artifact P1 acceptance: `docs/superpowers/plans/2026-10-04-mcp-tracker-artifacts-acceptance.md`
