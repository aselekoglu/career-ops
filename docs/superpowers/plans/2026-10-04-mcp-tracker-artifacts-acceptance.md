# Career Ops native MCP P1 acceptance — 2026-10-04

## Scope and environment

Live native Career Ops MCP acceptance only. No implementation, browser/computer QA, AI generation, raw DB writes, fake auth, service bypass, external emails/applications, secrets, or new resources were used. Native tools came from the fresh ALL_TOOLS catalog. The tested deployment context supplied for this run was backend READY at 5fd719ff6cfad84bfdb9d93ef37176c98676a8f6 (dpl_8Hp3FpLncvNWyyfgyu7n7Xev8N3H, https://career-ops-aselekoglu.vercel.app) and Site v8 SUCCEEDED (appgdep_6ac1d1af95e4819182da958bd03decaa, source 09cd02e21226e7cb895fa6e39df96ca4f2646302, https://career-ops-chatgpt.aselekoglu.chatgpt.site).

## CV artifact association and export

- tracker_get(applicationId="39") baseline: Magnet Forensics, AI & Automation Engineer (Enterprise), score 4.1/5, status Evaluated, PDF ❌, report [39](../reports/039-magnet-forensics-2026-10-04.md), notes Evaluated from exact inbox URL: https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329.
- Global artifact list (limit=2), app 39 list, and run metadata confirmed existing run 65de8258-d65a-446c-ad6b-9beeee40e4f2: completed, pending, CV_ARTIFACT_TRACKER_INVALID, target 39, 65,124-byte PDF, SHA-256 8081ee49a0c6732b1ba4e095425075d1fd1347ab02a037d7bcbcac33459939b5.
- Associated that existing artifact to application 39 with idempotency key p1-magnet-39-associate-v1. Result: linked, pending false, error null, application 39, report path reports/039-magnet-forensics-2026-10-04.md.
- Repeated with the same key and inputs; received the same linked result.
- Attempted the already-linked artifact against nonexistent application 999999 with key p1-magnet-39-associate-nonexistent-v1; native call rejected with CV_ARTIFACT_ALREADY_ASSOCIATED (INVALID_ARGUMENT). Follow-up reads showed app 39 unchanged beyond the intended PDF link.
- Verified app 39 via tracker get and pipeline: PDF ✅; score 4.1/5, status Evaluated, notes, company, role, and report remained unchanged. App 39 artifact listing shows the run linked.
- cv_artifact_export(runId=...) returned a private Site resource_link at /artifacts/65de8258-d65a-446c-ad6b-9beeee40e4f2/download, downloadVerified: true, downloadBytes: 65124, contentType: application/pdf. It did not return PDF bytes in JSON.

## Tracker CRUD canary

Canary identity: operation UUID 3f42c5b6-3a3b-4b2d-93b6-70fe06ae51de; created application ID 40; company Career Ops MCP acceptance canary; role No actual application - 2026-10-04-3f42c5b6; URL https://example.com/career-ops-mcp-canary/3f42c5b6-3a3b-4b2d-93b6-70fe06ae51de.

- Added with status SKIP, date 2026-10-04, and no score. Response showed score: null, report: null.
- Exact replay using the same operation UUID returned replayed: true and ID 40.
- Changed-payload replay with the same UUID rejected as IDEMPOTENCY_KEY_CONFLICT (INVALID_ARGUMENT).
- Read through tracker get and pipeline; canary had no score/report and remained SKIP.
- Updated notes with operation UUID 60c79f7b-67ca-4e5f-92c8-1f6fc967f5b3; set status SKIP with UUID 7961e779-b190-4f21-b2a8-0b40ab7945c5; both returned ok: true.
- Archived only canary ID 40 with confirmation and operation UUID 334e8a9d-2df4-428f-ae56-521a0f64a45f; deleted only canary ID 40 with confirmation and UUID a13b468a-598f-4e4d-bade-3e76773598e6. Both returned ok: true.

## Inbox CRUD canary

- Added only https://example.com/career-ops-inbox-canary/cbf79360-2a9d-4d0c-866c-e8ea1c3be190 with operation UUID cbf79360-2a9d-4d0c-866c-e8ea1c3be190, company Career Ops MCP Inbox canary, role No actual job - 2026-10-04, location MCP test only.
- Edited with UUID eaf45f43-463d-4650-9ded-ef01fad88a18 to URL ending -edited, role No actual job - edited MCP canary, location Edited MCP test only. Pipeline confirmed all replacement fields.
- Archived the exact edited URL with confirmation and UUID 4767f6e6-1137-4f3d-92a6-5f17de7f55f8; deleted the exact edited URL with confirmation and UUID 3d598514-2390-44ad-9e6f-9651305d0934. Both returned ok: true.
- Final exact-canary pipeline query returned zero applications and zero inbox rows.

## Final bounded data check

- Magnet app 39 remained present with score 4.1/5, status Evaluated, PDF ✅, original report and exact notes; its original Inbox row remained present.
- Kinaxis rows remained present in the pipeline. The existing Kinaxis CV run a6593705-81c4-4b34-bac6-df312c19606f remained completed and unlinked; no Kinaxis status or artifact association was changed.
- Final artifact metadata lists run 65de8258-d65a-446c-ad6b-9beeee40e4f2 linked to 39 and preserves its 65,124-byte size and SHA-256.

## Result

Native P1 acceptance passed for the requested tracker/artifact and Inbox paths. The sole intended real-user-data mutation was linking the existing completed Magnet CV PDF to application 39. Both test canaries were cleaned up.

