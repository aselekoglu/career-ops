# MCP evaluation P0 production acceptance

## P0 checklist

- [x] Start evaluation for the exact Kinaxis inbox URL and persist a durable run.
- [x] Complete canonical A–G evaluation, Risk Summary, Machine Summary, and verbatim job archive.
- [x] Read back the same report/application number/score from the tracker and mark the exact inbox item processed.
- [x] Repeat the same idempotent start and receive the original completed run without another AI evaluation.

## Verified run

- Exact URL: `https://careers-kinaxis.icims.com/jobs/35379/co-op-intern-forward-deployed-engineer/job`
- Run ID: `f19af444-97cf-4506-a3ed-9a4071f5fbbb`
- Lifecycle: `queued` at 2026-10-02 14:56:00 UTC, `running` at 14:56:14 UTC, `completed` at 14:56:31 UTC.
- Result: application number `38`, score `2.5/5`, report `reports/038-kinaxis-2026-10-02.md` (17,940 characters). Root verified all A–G sections, Risk Summary, Machine Summary, and the verbatim posting archive.
- Tracker: row `38` is `Evaluated` at `2.5/5`, linked to the report for the exact requisition URL.
- Inbox: that exact URL is marked done. Other tracker statuses remained unchanged: 26 Evaluated, 17 Applied, and 13 Discarded.
- Duplicate start with idempotency key `kinaxis-35379-20261002-complete-output-v1` returned run `f19af444-97cf-4506-a3ed-9a4071f5fbbb`, still `completed`, application `38`; no second AI call ran.

## Production and Sites evidence

- Production source: `7d56fae0a8aa48468169e778a7b00f7e1d2c4e94`; deployment `dpl_CK2rrM6gnoQknW4U1n4uaUbSyUGddjce` is READY at `https://career-ops-aselekoglu.vercel.app`. `/api/health` reports `evaluations.available: true`.
- Sites MCP version 5 is saved under the same private plugin environment (revision 5). Deployment `appgdep_6abf88aa97788191b432a40189e3ee25` succeeded at `https://career-ops-chatgpt.aselekoglu.chatgpt.site`.
- Three earlier failed evaluation attempts created no report/application and did not mark the inbox done.

## Remaining scope

This verifies P0 evaluation acceptance only; the broader MCP roadmap remains active for P1/P2/P3. Default no-key start after successful completion remains unverified. The probe returned `UPSTREAM_HTTP_502` twice; the first stored response metadata omitted its body, and the second captured response still carried the upstream error. This does not establish a source-logic failure. Do not change default-key lookup until transient/upstream behavior is confirmed. Explicit-key replay is verified.
