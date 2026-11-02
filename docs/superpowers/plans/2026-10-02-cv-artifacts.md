# Durable CV artifact association

## Scope

Link a completed hosted CV PDF to an existing application only by its explicit application number or an exact match between the CV run URL and that application's persisted report URL. Persist artifact metadata, tracker PDF readiness, and `data/pdf-index.tsv` through a fenced Neon write. Expose fixed metadata, association, and secured download routes.

## Implementation sequence

1. [x] Validate persisted PDF encoding, prefix, SHA-256, size, URL identity, tracker row, and canonical report/PDF-index paths in a web-local module.
2. [x] Extend CV run completion to atomically persist rendered HTML/PDF and completed render state, then attempt application linkage. Surface link failures as completed render plus pending association/error.
3. [x] Implement application/run metadata lookup, explicit idempotent association, and UUID-only Basic-auth download endpoints.
4. [x] Add focused tests for identity, malformed PDF, tracker/index row preservation, premature readiness, CAS conflict, idempotent replay, and latest lookup; update this ledger.
5. [ ] Wait for root review before commit/push. Do not generate a new CV, deploy, or change the Sites MCP in this slice.

## Contract decisions

- `GET /api/cv-artifacts?applicationNumber=N` returns matching artifact metadata and the newest record by `completedAt`.
- `GET /api/cv-artifacts/{UUID}` returns render status separately from association status.
- `POST /api/cv-artifacts/{UUID}/associate` accepts only `{applicationNumber,idempotencyKey}`.
- `GET /api/cv-artifacts/{UUID}/download` streams only a completed, hash/size/prefix-validated persisted PDF; normal Vercel Basic auth remains in force.
- URL-based CV runs remain unlinked until explicit association. Application-targeted runs auto-link after render and may expose a retryable pending association if the tracker CAS loses a race.
- Matching compares the exact run request URL to the selected report's `**URL:**` value. Company and role are never identity keys.
- New application-number CV requests also persist the selected report path and exact report URL. Legacy runs without that identity cannot be associated by application number alone.
- The existing PDF manifest schema is `report#\tpdf\thtml\tformat\tdate`; keep unrelated rows byte-for-byte where possible.
