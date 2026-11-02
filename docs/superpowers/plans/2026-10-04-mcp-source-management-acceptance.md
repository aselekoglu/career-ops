# Career Ops MCP source-management acceptance

Date: 2026-10-04
Scope: Native connected Career Ops MCP tools only. No source facts were edited.

## Live tool catalog

All seven source-management tools were present in the live catalog:
- career_ops_source_get
- career_ops_cv_edit_preview
- career_ops_profile_edit_preview
- career_ops_source_proposal
- career_ops_source_apply
- career_ops_source_history
- career_ops_source_revision

## Private source baselines

The initial source-get tool call accidentally emitted its structured result in internal tool output, which included private CV source text. This evidence file does not reproduce CV content. No claim is made about secret exposure.

| Source | SHA-256 | UTF-8 bytes |
|---|---|---:|
| cv | 4ee43eb87be4edeedec7a70def29b78dd471a0661e471921ce089dc9b9ee2203 | 10849 |
| profile | 6a9047fda8cd89bd942cf991e9f416316b466dbff80951e58ea2fbbdd609fdde | 1546 |

## No-op preview and replay

CV preview operation ID: ec87516a-b526-44a3-ba27-bd1e65320546
Profile preview operation ID: 3b91cf98-aa2f-4106-91f9-5e43b511b40c

Both previews returned status unchanged, empty diff, and proposed SHA equal to base SHA. Replaying each preview with the same operation ID and payload returned the same proposal ID and unchanged result.

CV proposal ID: ec87516a-b526-44a3-ba27-bd1e65320546
Profile proposal ID: 3b91cf98-aa2f-4106-91f9-5e43b511b40c

Exact proposal reads returned empty diffs for both sources.

## No-op apply and replay

Both exact saved no-op proposals were applied with the original expected SHA, fresh operation IDs, and explicit confirm=true.

| Source | Apply operation ID | Status | Before SHA = after SHA |
|---|---|---|---|
| cv | 7a220805-68cb-4df4-bdbd-91259120516a | unchanged | yes |
| profile | 5e9b806f-d7e1-4dea-9011-f9625b3b44e3 | unchanged | yes |

Replaying both apply calls with identical payloads returned the same receipt metadata and unchanged status.

## History, revision, and final source verification

History(limit=2) included each acceptance receipt. Exact-SHA revision reads matched the initial source bytes privately. Final source reads matched each initial SHA and UTF-8 byte count exactly.

| Source | Final SHA-256 | Final UTF-8 bytes | Exact match |
|---|---|---:|---|
| cv | 4ee43eb87be4edeedec7a70def29b78dd471a0661e471921ce089dc9b9ee2203 | 10849 | yes |
| profile | 6a9047fda8cd89bd942cf991e9f416316b466dbff80951e58ea2fbbdd609fdde | 1546 | yes |

Receipt paths:
- data/source-receipts/cv/7a220805-68cb-4df4-bdbd-91259120516a.json
- data/source-receipts/profile/5e9b806f-d7e1-4dea-9011-f9625b3b44e3.json

## Safe negative checks

- Empty CV preview with a mismatched SHA was rejected with INVALID_ARGUMENT / SOURCE_STALE.
- Read of a nonexistent proposal UUID was rejected with INVALID_ARGUMENT / PROPOSAL_NOT_FOUND.
- The native apply schema requires confirm=true, so a missing-confirm request cannot be represented through this connected tool interface; it was not attempted outside the native schema.

## Deployment metadata

The task handoff supplied backend deployment dpl_3wPhoJXJiqRxvnirULtFzqDjAnoV (SHA 8a11b88cd0c0d5752f0816574e9b13ee62a918e3) and Site deployment appgdep_6ac29263d81c81919b2a8d9c948b51d6 (source 10d356099a7e239831de4b9433d74215e62c8601, env revision 5), with URLs https://career-ops-aselekoglu.vercel.app and https://career-ops-chatgpt.aselekoglu.chatgpt.site. These deployment details were supplied by the parent task and were not independently verified during this acceptance run.
