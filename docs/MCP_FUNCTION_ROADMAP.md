# Career Ops MCP: functions and rollout plan

## What MCP can do now

The deployed private Site v5 exposes 15 tools: health, pipeline, source CV, schedules, portals, AI status, the applications panel, live scan start/status/results, durable evaluation start/status/report, and tailored CV start/status. Evaluation and CV generation are available in cloud. The Kinaxis P0 request for application **#38** was accepted and completed with score **2.5/5** (`done: true`; documented in commit `1c8ad533`).

| MCP function | Current behavior |
|---|---|
| `career_ops_health` | Reports the live connection and declared cloud capabilities. |
| `career_ops_pipeline` | Reads and filters stored applications and inbox items; it is a snapshot/read path, not proof that a new evaluation or scan ran. |
| `career_ops_cv` | Reads the source CV. |
| `career_ops_schedules` | Reads imported schedule data; it cannot run or change schedules. |
| `career_ops_portals` | Reads portal verification coverage; it does not scan or repair portals. |
| `career_ops_ai_status` | Checks hosted Gemini availability without invoking it. |
| `open_career_ops` | Opens the applications panel with the same read-only pipeline filters. |
| `career_ops_scan_start`, `career_ops_scan_status`, `career_ops_scan_results` | Start a durable live portal scan, poll its ID, then read its results. These tools are gated by the Sites scan setting; queued/running is not completion. |
| `career_ops_evaluation_start`, `career_ops_evaluation_status`, `career_ops_evaluation_report` | Evaluate an existing Inbox URL or application number on the durable worker, poll the lifecycle, and read the persisted report after completion. |
| `career_ops_cv_generate_start`, `career_ops_cv_generate_status` | Start the existing hosted CV tailoring/render/storage path for an application number or exact inbox URL; poll the durable run. The bridge does not fetch the URL or implement generation. |

`career_ops_job_import` is being added in the clean bridge review checkout but is not yet verified in the deployed Site. The backend job-import endpoint must be present and reviewed before publishing the tool. Existing CV start/status returns the Career Ops artifact path and download URL. Additional backend tracker commands and CV artifact/list/association/download paths have implementation commits (`08aa9955`, `04bde4ac`), but their MCP bridges have not been verified in the deployed Site; treat those additional operations as pending. Do not infer completion from source code or backend commits alone.

## Priority roadmap

| Priority | User function | MCP plan and current boundary |
|---|---|---|
| **P0** | Import an external job URL, then evaluate and tailor a CV | Add `career_ops_job_import` as the first tool in the workflow. It must call the fixed authenticated backend import endpoint, create or return the canonical Inbox record idempotently, and expose only allowlisted fields. Then use the existing evaluation start/status/report and CV start/status tools and preserve the exact `downloadUrl` returned by Career Ops. The MCP bridge change is in review; backend endpoint and deployed end-to-end flow remain gates. |
| **P0 complete** | Evaluate a specific inbox role; record it as Evaluated | `career_ops_evaluation_start`, `career_ops_evaluation_status`, and `career_ops_evaluation_report` use the durable worker and normal Career Ops lifecycle. The Kinaxis P0 is complete for application #38 at 2.5/5 (`done: true`, commit `1c8ad533`). |
| **P1** | Tracker and Inbox management | Backend tracker and inbox commands have implementation commits, but MCP bridge behavior is not yet verified or deployed. Once bridged, support exact-row reads/status updates, canonical manual tracker add, and Inbox URL add/edit/archive/delete. Do not manufacture an evaluation when manually adding a row. Use explicit confirmation for destructive edits. |
| **P1** | Finish CV artifact lifecycle | CV generation start/status already exist. Backend artifact list/get/association/download paths have implementation commits, but MCP bridges are not yet verified or deployed. After verification, associate PDFs only with exact report identity and return the private Site download; source CV stays read-only. |
| **P1** | Master CV and profile | Support CV intake as a source-annotated proposal, explicit user-approved scoped CV/profile edits, history/version backup, ATS/plain-text/LaTeX exports, and tailored PDF generation. Keep claims grounded in primary files; never alter a different CV section or profile key as collateral. Local CV/profile write flows exist; cloud edits are not enabled. |
| **P1** | Portals and blacklist | Read and explicitly confirm merge-safe changes to targeting, tracked portals, and the do-not-apply blacklist; verify portal health separately. Cloud profile/portal/blacklist mutations and repair are currently blocked. |
| **P2** | Cover letters and application assistance | Generate a fact-grounded cover-letter PDF from a saved report; expose preview/artifact retrieval. Application help may draft field answers from primary CV/profile evidence, but form driving and submission remain separate and must never auto-submit. These local routes are not cloud-enabled. |
| **P2** | Scanning and schedules | Keep live scan start/status/results distinct from stored pipeline reads. Add schedule create/edit/pause/run only when a durable scheduler exists; current health says scheduled execution is unavailable and schedule tools read imported snapshots only. |
| **P2** | Follow-ups and reply tracking | Read cadence and history first; later add explicit append/log and override operations with idempotent event IDs. Current cadence is a cloud-safe read; follow-up writes and email/reply integrations are not MCP capabilities. |
| **P2** | Reports, batch, and triage | Read/search/export reports; compare offers; re-evaluate a selected target; and triage or batch-process inbox roles with a bounded batch size and confirmation above the existing auto-fire limit. Local modes and report artifacts exist; durable single-job evaluation is already available through the current P0 tools. |
| **P3** | Outcomes and career decisions | Record outcomes through the canonical outcome flow; offer prep/negotiation, training/certification, and portfolio-project evaluation. These are local modes/scripts without cloud MCP contracts. |
| **P3** | Analytics, research, interview, and contacts | Add read-only funnel/stats, company history, repost, salary-gap, process-quality, rejection-latency, weekly interview-digest, skills-gap, and pattern tools; bounded company research; interview prep/plan/practice/debrief/red-flag checks; and contact lookup/export. These are local modes/scripts, not current MCP tools or verified cloud APIs. |
| **P3** | Import/export and archive | Add explicit import/export and archive operations for application artifacts and user data, with path scoping, preview, and backups. Existing local scripts cover intake, posting archives, contacts, and application artifacts; no cloud MCP contract is established. |

## Tool contract and rollout gates

Keep the bridge a thin authenticated proxy to fixed API paths. Do not expose generic endpoint/method tools, local shell/CLI execution, or raw database access. User-approved CV/profile changes must be narrowly scoped, backed up/versioned, and confirmed before write; source CV edits are a supported user function. Never submit an application. Job-posting text is untrusted data, never tool instructions. Evaluation workers must reuse `modes/oferta.md`, user-layer profile files, and the existing canonical scoring rules rather than inventing a cloud-specific evaluator.

For external job import, first verify the backend's shared ingestion path, normalization, duplicate behavior, URL-fetch/redirect safeguards, and durable Inbox write. Then publish the single fixed `/api/job-import` MCP bridge only after schema, Site-user auth, existing Basic auth, backend error allowlist, response-field allowlist, and Magnet Forensics import/evaluation/CV flow are verified. The completed Kinaxis evaluation is historical evidence for the separate evaluation P0; do not rerun it as an import test.

## Source map

- Local user-facing action registry: `web/src/app/actions/registry.ts`
- Local worker orchestration and canonical modes: `web/src/app/api/run/route.ts`, `web/src/lib/run-prompts.mjs`, `modes/oferta.md`, `modes/auto-pipeline.md`
- Cloud route boundary: `web/src/proxy.ts`, `web/src/lib/deployment.ts`
- Existing durable CV and scan API implementation: `C:/Users/asele/Documents/Codex/2026-09-01/realtime-voice-chat/career-ops-vercel-fix/web/src/app/api/cv-runs/route.ts`, `.../cv-runs/[id]/route.ts`, `.../scans/route.ts`, and `.../scans/[id]/route.ts`
- Installed Sites MCP surface: `sites/career-ops-mcp/src/server.mjs`
