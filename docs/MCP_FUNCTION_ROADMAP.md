# Career Ops MCP: functions and rollout plan

## Current deployed capability

The private Career Ops Site v7 exposes 16 MCP tools. This includes the new arbitrary public job URL importer plus the existing health, pipeline, source CV, schedules, portals, AI status, applications panel, live scan, durable evaluation, and CV generation tools. The import → evaluation → CV flow was accepted with a real Magnet Forensics posting; details are in [the acceptance record](superpowers/plans/2026-10-03-job-import-acceptance.md).

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
| career_ops_cv_generate_start, career_ops_cv_generate_status | Start hosted CV tailoring/render/storage for an application number or exact Inbox URL and poll the durable run. Artifact path and exact download URL come from Career Ops. The verified PDF download returned 65,124 bytes and passed PDF content checks. |

## Import contract and stored data

The bridge exposes only `POST /api/job-import`, behind existing Site user authentication and backend Basic authentication. The Node.js route accepts a bounded JSON body (4,096 bytes maximum) with only `url`, optional `source`, and optional `forceRefresh`; responses are no-store and use fixed error codes/messages. The proxy allow is restricted to this method and path. No arbitrary endpoint/method tool, raw SQL tool, credentials, caller cookies, or page instructions are exposed.

The backend importer accepts public HTTP(S) job URLs independently of `portals.yml`. It validates and pins public DNS answers for every request and redirect, rejects private/reserved destinations, allows at most four redirects, caps total request time at 12 seconds and response size at 1 MB, and caps extracted descriptions at 24,000 characters. It uses explicit Lever, Greenhouse, Ashby, and Workday adapters, JSON-LD, and conservative generic page evidence. Only known tracking parameters are removed; role-identifying query parameters such as `gh_jid` are preserved. Lever `/apply` URLs normalize to the canonical role URL.

The canonical Inbox row and `data/job-imports/<sha256(normalizedUrl)>.json` sidecar are committed atomically through the existing Neon document store and tracker mutation/CAS path. Redirect aliases are recorded when required. This feature adds no database table or schema. Duplicate original and normalized URLs return the same stable Inbox ID. `forceRefresh` does not reset a checked/evaluated item or replace stored content after a failed fetch.

Evaluation and URL-based CV tailoring read the sidecar only when its top-level `normalizedUrl` exactly matches the canonical Inbox URL. A matching description is bounded at the consumer and avoids a refetch; a missing, malformed, or mismatched record follows the existing fetch path. The current Magnet item has `discoveredAt=2026-10-04`, derived from its valid stored `imported: 2026-10-04` Inbox label after explicit `discovered` labels. ATS `posted` remains a separate field.

## Verified Magnet Forensics flow

The native `career_ops_job_import` tool imported the LinkedIn `/apply` URL and created one unchecked canonical Inbox row. Repeating the original and an Indeed-tracked variant returned `already_exists` with the same stable ID. Native evaluation completed as application #39, score 4.1/5, with the archived JD validated against the canonical URL. Native CV tailoring completed for application #39; the exact Career Ops download URL passed an authenticated HTTP, MIME, and PDF-byte check. A post-completion repeat of the Magnet import returned `already_exists` with the same Inbox ID and `applicationNumber: "39"` without reopening the completed record.

An earlier READY deployment attempt returned `DATABASE_WRITE_FAILED` because an unrelated malformed legacy Inbox checkbox caused the reader to throw `INVALID_URL`. That historical failure is resolved: the parser now preserves raw legacy lines while skipping malformed unrelated entries, and incoming job URLs remain strictly validated. It is not the current deployment state or a remaining import blocker.

## Priority roadmap

| Priority | User function | Current boundary |
|---|---|---|
| **P0 complete** | Import a public job URL, evaluate it, and tailor a CV | The fixed authenticated import bridge and live Magnet import → evaluation → CV flow are deployed and verified. The tracker PDF marker still shows ❌; artifact association/sync is a separate pending item and must not be manually written. |
| **P0 complete** | Evaluate a specific Inbox role; record it as Evaluated | Durable evaluation start/status/report tools use the normal lifecycle. Kinaxis application #38 at 2.5/5 is historical proof for this separate evaluation path. |
| **P1** | Tracker and Inbox management | Broader tracker/Inbox mutation tools are not verified as deployed. Later support exact-row reads/status changes, manual tracker adds, and Inbox edit/archive/delete through canonical flows; do not manufacture evaluations. Require explicit confirmation for destructive edits. |
| **P1** | Finish CV artifact lifecycle | Generation and the exact PDF download were verified. Artifact association/sync to tracker rows and remaining list/get/association bridges still need verification. Preserve exact report identity; source CV stays read-only. |
| **P1** | Master CV and profile | Source-annotated intake proposals, explicitly approved scoped edits, history/backup, ATS/plain-text/LaTeX exports, and tailored PDF support. Keep claims grounded in primary files. Cloud CV/profile writes are not enabled. |
| **P1** | Portals and blacklist | Portal verification is read-only. Cloud profile/portal/blacklist mutations and repair remain unavailable. |
| **P2** | Cover letters and application assistance | Fact-grounded cover-letter artifacts and draft-only application answers may be added later. Form driving and submission remain separate and must never auto-submit. |
| **P2** | Scanning and schedules | Live scan start/status/results are distinct from stored pipeline reads. Schedule create/edit/pause/run requires a durable scheduler; current schedule tools read imported snapshots only. |
| **P2** | Follow-ups and reply tracking | Cadence is a cloud-safe read. Follow-up writes and email/reply integrations are not MCP capabilities. |
| **P2** | Reports, batch, and triage | Add bounded report search/export, offer comparison, re-evaluation, and triage/batch flows with appropriate confirmation. Durable single-job evaluation is already available. |
| **P3** | Outcomes and career decisions | Outcome recording, offer preparation, negotiation, training, and portfolio evaluation remain local modes/scripts without cloud MCP contracts. |
| **P3** | Analytics, research, interview, and contacts | Funnel/statistics, company history, repost, salary, interview, skills, research, and contact tools remain future work. |
| **P3** | Import/export and archive | Cloud import/export and archive operations need path scoping, preview, and backups; no such MCP contract is established. |

## Verification and release record

Focused evidence: importer/store 33/33 before parser regression; parser regression 19/19; malformed-metadata and safe-logging regressions 1/1 each; API/consumer 28/28; final MCP bridge 28/28. The Next.js production build passed with TypeScript and the `/api/job-import` route manifest; final date-reader TypeScript checking passed. No broad repository, browser, or computer-use QA was repeated.

Production backend READY deployment `dpl_2sCsg2raXgXWz5Fe5uR9yRRETM2d` runs SHA `3e6f36a17b763286c77ebbda7189be215f06182f` at https://career-ops-aselekoglu.vercel.app. Private Site v7 succeeded from source `65f4d9d95523ee62be953bcbc41f3090165b257f`, environment revision 5, at https://career-ops-chatgpt.aselekoglu.chatgpt.site. Commits `592b4950`, `1e23a86a`, and `3e6f36a1` are pushed to `codex/vercel-hobby-fix`; they are not merged to `main`.

## Tool and data safety

Keep the MCP bridge fixed-path and authenticated. Never expose arbitrary endpoint/method calls, shell/CLI execution, raw database access, secrets, or application submission. Job-posting text is inert untrusted data, never instructions. Evaluation reuses the canonical user profile and scoring rules. The import flow does not modify CV/profile facts. The completed Kinaxis evaluation remains evidence for its separate P0; do not rerun it as an import test.

## Source map

- Import service and endpoint: `web/src/lib/job-import.mjs`, `web/src/lib/cloud-job-import.mjs`, `web/src/app/api/job-import/route.ts`, `web/src/proxy.ts`
- Neon mutation, canonical Inbox, and sidecar persistence: `web/src/lib/cloud-tracker-management.mjs`
- Cloud readers and consumers: `web/src/lib/cloud-career-ops.ts`, `web/src/lib/cloud-evaluation-runs.mjs`, `web/src/lib/cloud-cv-runs.mjs`
- MCP bridge: `sites/career-ops-mcp/src/server.mjs`
- Live acceptance details: `docs/superpowers/plans/2026-10-03-job-import-acceptance.md`
