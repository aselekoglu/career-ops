# Job import acceptance — 2026-10-03

## Deployment under test
- Backend: READY deployment `dpl_GFK2P8mWoyGFpMBP7K6F7Y3ouNv`
- Backend SHA: `592b4950985c0de883081e3d42b484daf2e98901`
- Alias: https://career-ops-aselekoglu.vercel.app
- Sites app: `appgdep_6ac15a9d8d40819192f208876e6c44f1`
- Sites project: `projectappgprj_6abe754d3d74819186a62551b11dd7c6`
- Sites URL: https://career-ops-chatgpt.aselekoglu.chatgpt.site
- Sites source: `c5f6a45126a7379af3dfd90ead9c5a77a7dd9906`
- Sites env revision: `5`
- Focused checks reported by deployment owner: backend 33, API consumer 28, bridge 26; TypeScript build passed.
- Native pipeline tool was available in this session.

## Live acceptance attempt
At 2026-10-03 19:44 UTC, called native `career_ops_job_import` with:
- URL: `https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329/apply?source=LinkedIn`
- Source: `LinkedIn`

Exact result fields:
- `status=failed`
- `error.code=DATABASE_WRITE_FAILED`
- `error.message=Career Ops could not save the imported job posting.`
- Tool envelope also contained `error_code=INVALID_ARGUMENT`.

A subsequent read-only native `career_ops_pipeline({company:"Magnet Forensics",limit:20})` at `2026-10-03T19:44:44.740Z` returned source `https://career-ops-aselekoglu.vercel.app`, storage `stored-neon-pipeline`, `applications=[]`, `inbox=[]`, totals 0/0. No imported record or application was created.

## Acceptance status
Blocked at the first import write. Per canary stop condition, no duplicate-source checks, invalid URL probes, evaluation, report read, or CV generation were run. No fallback API, browser, raw database write, or separate artifact generation was used. Stable Inbox ID, normalized URL, evaluation run ID, application number, score, report/archive checks, CV run ID, artifact path, and download URL are unavailable because import did not succeed.
## Diagnosed cause and fix verification
The import failed during read-before-write validation because an unrelated malformed legacy Inbox checkbox was parsed as a job URL; `parseInbox` then failed `INVALID_URL` before the new posting could be saved.

The root's staged parser fix skips malformed/non-job lines while preserving their raw text, and incoming job URL validation remains strict. Reported local verification: parser regression cases 19/19, targeted blank-metadata case 1/1, and safe stage/code-only logging check 1/1. This is staging verification only; no new production READY SHA or successful live import is recorded.
