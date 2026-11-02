# Job import acceptance — 2026-10-03

## Deployment under test

- Backend: production READY deployment `dpl_2sCsg2raXgXWz5Fe5uR9yRRETM2d`
- Backend SHA: `3e6f36a17b763286c77ebbda7189be215f06182f`
- Backend alias: https://career-ops-aselekoglu.vercel.app
- Private Sites app: `appgdep_6ac1a6cd75e08191abeca44093e0518c`
- Sites project: `appgprj_6abe754d3d74819186a62551b11dd7c6`
- Sites version: 7, confirmed through the native version read; its archive contains 2 files.
- Sites source: `65f4d9d95523ee62be953bcbc41f3090165b257f`
- Sites environment revision: `5`
- Sites URL: https://career-ops-chatgpt.aselekoglu.chatgpt.site
- The private Site exposes 16 MCP tools; job import was added and the prior 15 tools remain.
- Backend commits `592b4950`, `1e23a86a`, and `3e6f36a1` are pushed to `codex/vercel-hobby-fix`; they are not merged to `main`.

## Contract and persistence

Native MCP tool `career_ops_job_import` accepts only:

```json
{"url":"https://…","source":"LinkedIn","forceRefresh":false}
```

`url` is required and 1–2,048 characters; `source` is optional and at most 500 characters; `forceRefresh` is optional boolean. Unknown keys are rejected. The bridge calls only authenticated `POST /api/job-import`. The route uses Node.js, a 30-second platform limit, no-store responses, and a 4,096-byte streamed JSON cap. Existing Site user authentication and backend Basic authentication remain in front of the route.

The importer accepts public HTTP(S) URLs independently of `portals.yml`. It validates and pins public DNS results on every request and redirect; rejects private/reserved addresses; follows at most four redirects; has a 12-second total network deadline, a 1 MB response cap, and a 24,000-character extracted-description cap. It uses fixed ATS adapters (Lever, Greenhouse, Ashby, Workday), JSON-LD, and conservative generic page evidence. Lever `/apply` and known tracking data normalize away; job-identifying parameters such as `gh_jid` remain.

The canonical pipeline row and top-level JSON record at `data/job-imports/<sha256(normalizedUrl)>.json` are written atomically through existing Neon `career_ops_documents` and the tracker mutation/CAS flow; redirect aliases use the same existing document model. This feature adds no table/schema. Duplicate identities return the stable Inbox ID. Refresh cannot reset checked/evaluated rows or overwrite good stored evidence after a failed fetch.

Evaluation and URL-based CV tailoring use the sidecar only when top-level `normalizedUrl` equals the exact canonical Inbox URL. A matched long description is bounded by the consumer without refetching. Missing, malformed, or mismatched sidecars keep the existing fetch fallback. Inbox `discoveredAt` falls back to a calendar-valid `imported` label only after a valid explicit `discovered` label; ATS `posted` remains independent.

## Example MCP call sequence

Illustrative only; these calls are not being replayed. Use the imported canonical URL for the exact Inbox match:

1. `career_ops_job_import({url: "https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329/apply?source=LinkedIn", source: "LinkedIn"})`.
2. If the result has an existing `applicationNumber`, skip evaluation and use that number for CV generation. Otherwise call `career_ops_evaluation_start({url: imported.normalizedUrl, idempotencyKey: "magnet-454d7903-import-20261003-v1"})`; keep the key stable for retries of this target.
3. Poll `career_ops_evaluation_status({runId: evaluation.runId})` until `status` is `completed`; read the report with `career_ops_evaluation_report({runId: evaluation.runId})`.
4. Call `career_ops_cv_generate_start({applicationNumber: evaluation.applicationNumber, pageFormat: "letter"})` (or the existing number from step 2).
5. Poll `career_ops_cv_generate_status({runId: cv.runId, verifyDownload: true})` until `status` is `completed` and `downloadVerified` is `true`. Return the exact `downloadUrl` from the response.

The CV status input is a closed object; `verifyDownload` is optional and defaults to `false`:

```json
{"type":"object","additionalProperties":false,"required":["runId"],"properties":{"runId":{"type":"string","format":"uuid"},"verifyDownload":{"type":"boolean","default":false}}}
```

## Historical failure and resolution

The first live v6 attempt failed with `DATABASE_WRITE_FAILED`; the pipeline remained empty and no application was created. Diagnosis found an unrelated malformed legacy Inbox checkbox: the old `parseInbox` threw `INVALID_URL` while reading that line before it could save a new posting.

Commit `1e23a86a` fixed the reader to preserve raw legacy lines while skipping unrelated malformed/non-job rows. New incoming URL validation remains strict. Parser regression tests passed 19/19, the targeted malformed-metadata check passed 1/1, and the safe stage/code-only logging regression passed 1/1. This earlier error is resolved and is not the current acceptance result.

## Successful native import

At `2026-10-04T00:49:17.721Z` (October 3 in Toronto), native `career_ops_job_import` received:

- URL: https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329/apply?source=LinkedIn
- Source: LinkedIn

It returned `status=imported`, Inbox ID `inb_042d4e4049251e3f972d1f95d3e23a2e`, company `Magnet Forensics`, role `AI & Automation Engineer (Enterprise)`, and canonical URL https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329. Repeating the original URL and an Indeed-tracked variant returned `already_exists` with the same Inbox ID. Invalid `not-a-url` returned `INVALID_URL`; `127.0.0.1` returned `PRIVATE_NETWORK_BLOCKED`. These rejection probes did not write rows. The native pipeline then showed exactly one canonical Magnet Inbox row with `done=false` and no application before evaluation.

The sidecar stores `jobDescription` at the top level beside `normalizedUrl`, company, and role. Its imported date is `2026-10-04` UTC; the live pipeline reader now reports `discoveredAt=2026-10-04` from that label.

## Evaluation

Native evaluation run `de6cfdf7-0575-4882-b8e0-788e57a3143f` used idempotency key `magnet-454d7903-import-20261003-v1`.

- Requested: `2026-10-04T00:51:10.391Z`
- Started: `2026-10-04T00:51:20.029Z`
- Completed: `2026-10-04T00:51:40.694Z`
- Result: application #39, score 4.1/5, status `Evaluated`
- Report: `reports/039-magnet-forensics-2026-10-04.md`

The native report read returned 30,249 characters. The canonical URL, A–G sections, Risk Summary, Machine Summary, and verbatim archived JD were validated. Final native pipeline read shows application #39 at 4.1/5 and one exact canonical Inbox row with `done=true`.

## CV generation and download

Native CV run `65de8258-d65a-446c-ad6b-9beeee40e4f2` targeted application #39 with `pageFormat=letter`.

- Requested: `2026-10-04T00:53:14.922Z`
- Started: `2026-10-04T00:54:04.320Z`
- Completed: `2026-10-04T00:54:05.157Z`
- Result: `completed`
- Artifact: `output/cv-magnet-forensics-ai-automation-engineer-enterprise-2026-10-04T00-54-05-113Z-65de8258.pdf`
- Exact download URL: https://career-ops-aselekoglu.vercel.app/api/cv-pdf?artifact=output%2Fcv-magnet-forensics-ai-automation-engineer-enterprise-2026-10-04T00-54-05-113Z-65de8258.pdf

Native status reported `verifyDownload=true`. An authenticated HTTP/MIME/PDF-byte check confirmed `downloadVerified=true` and 65,124 bytes. A repeat of the Magnet import after evaluation and CV completion returned `already_exists` with the same Inbox ID and `applicationNumber: "39"` without reopening the completed record. Final pipeline read at `2026-10-04T01:08:30.587Z` showed one application and one Inbox entry, score 4.1/5, and `discoveredAt=2026-10-04`.

The tracker PDF cell remains `❌`. PDF artifact association/synchronization to the tracker is a separate P1 follow-up; do not mark the cell complete or write directly to Neon.

## Verification record

- Import parser/store: 33/33 focused tests; parser/legacy-row fix: 19/19.
- Malformed metadata regression: 1/1; safe internal logging regression: 1/1.
- API/stored-JD consumer tests: 28/28.
- Final MCP bridge tests: 28/28.
- Next.js production build passed, including TypeScript and the `/api/job-import` route manifest.
- Final date-reader TypeScript checking passed.
- Read-only local pinned-fetch canaries also parsed Magnet Forensics (7,911 JD characters) and Datadog (3,743 characters, preserving `gh_jid`). The Datadog canary did not write to the Inbox.
- No broad repository suite, browser/computer QA, or redundant production build was run.

## Acceptance status

**Accepted and deployed for the verified import → evaluation → CV generation/download path.** The earlier parse failure was resolved and is retained above as historical evidence. Broader tracker/Inbox mutations, tracker PDF artifact association, cloud CV/profile writes, and the other roadmap items remain pending.
