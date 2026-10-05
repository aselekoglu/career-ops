# Blacklist management P1 slice

## Goal and boundary

Expose fixed, authenticated read and mutation operations for the single canonical user document `data/blacklist.md`. This is a blacklist-only slice; portal configuration writes remain out of scope. Reads must not create a missing blacklist document. Mutations never initiate a scan, evaluation, or application submission.

## Contract

- `GET /api/blacklist?limit=25&offset=0` returns `{present, sha256, entries, pagination:{limit, offset, nextOffset}}`; list bounds are 1–100 and 0–10000. A missing file is `{present:false, sha256:null, entries:[]}`.
- `GET /api/blacklist/entry?company=…&scope=company|domain` performs an exact key lookup and returns `{present:true, sha256, entry}`; missing entries return fixed `BLACKLIST_ENTRY_NOT_FOUND`/404.
- `POST /api/blacklist/commands` accepts only a closed object with a caller UUID, operation, `expectedSha256`, `confirm:true`, and the operation's exact selector/entry fields. Add uses null SHA for the absent document; update/delete require the current SHA. Success is `{ok:true, operation, replayed, sha256, entry}`; delete uses `entry:null`.
- Company rows use the existing local `Company | Since | Scope | Reason` table. Reads preserve legacy `domain` scope metadata, but this API accepts writes only with `scope: "company"`: the authoritative cloud scan/evaluation gates currently match company labels only. Company normalization uses the shared Unicode-safe `normalizeTextKey`. Domain-aware cloud enforcement remains future work; this slice does not imply hostname matching.
- Writes use fixed document path, allowlisted fields and canonical table serialization while preserving unrelated lines/comments. Exact SHA compare-and-swap and stable UUID replay/conflict semantics follow tracker/source mutation patterns. Every mutation requires explicit confirmation.

## Implementation and verification

Implemented `web/src/lib/cloud-blacklist-management.mjs`, three fixed API route handlers under `web/src/app/api/blacklist/`, and exact path/method rules in `web/src/proxy.ts`. The service validates document/body bounds before parsing or writing, rejects extra table columns rather than dropping them, and scopes parsing to the canonical blacklist table. Its command API supports confirmed company-only add/update/delete, read-only legacy domain entries, expected-SHA compare-and-swap and UUID replay/conflict handling. Focused tests use a synthetic in-memory SQL/document adapter; no production data or live network writes occur. The evaluation blacklist gate now uses the shared Unicode-safe company key.

Focused verification: `node --test web/tests/lib/cloud-blacklist-management.test.mjs web/tests/lib/cloud-evaluation-runs.test.mjs`. The tests cover missing-document reads, pagination, exact lookup, later-table preservation, malformed extra-column rows and headers (rejected without writes), confirmation/scope/duplicate checks, CRUD preservation, replay/payload conflict, stale SHA, rollback after a write race, JSON content type, and Unicode blacklist matching. No production database write was run.

Hosted evaluation reads `data/blacklist.md` and blocks a matching company through the shared Unicode-safe company key before generation. Cloud scan input persistence currently includes the blacklist file, but enforcement in the authoritative scan path remains unproven and pending. This management slice does not dispatch scans/evaluations; new writes affect future evaluation gates only. Domain-aware scan/evaluation enforcement remains pending.
