# Cloud tracker and inbox management

## Fixed API contract

- `GET /api/tracker/{applicationId}` reads one unpadded canonical tracker number.
- `POST /api/tracker/commands` supports `add`, `set-status`, `update-notes`, `archive`, and `delete`.
- `POST /api/inbox/commands` supports exact-URL `add`, `edit`, `archive`, and `delete`.
- Every write carries a UUID `operationId`; duplicate requests replay their saved result, changed payloads conflict. Destructive operations require `confirm: true`.

## Persistence and source rules

- Mutations use fixed Neon document paths and SHA-CAS in one transaction, including tracker, status-log, follow-up seed, or inbox documents involved in the operation.
- The tracker parser preserves existing 9/10/11-column rows and aliases. Manual adds require a canonical explicit status, accept only user-supplied optional scores, and leave report/PDF metadata blank.
- Canonical status labels/aliases are bundled from `templates/states.yml` because system templates are not imported into Neon. Status-log `source` values remain the canonical closed set.
- Applied follow-up seed date priority is explicit date, then a valid `Applied YYYY-MM-DD` note, then today; profile cadence is used when available.

## Verification

- `node --test tests/lib/cloud-tracker-management.test.mjs tests/lib/cloud-evaluation-runs.test.mjs` — 25 passed, including shared report-number allocation and P0 tracker integration.
- `npm run build` — Turbopack and TypeScript passed; `/api/tracker/[applicationId]`, `/api/tracker/commands`, `/api/inbox/commands`, and the CV artifact routes appeared in the production route manifest.
