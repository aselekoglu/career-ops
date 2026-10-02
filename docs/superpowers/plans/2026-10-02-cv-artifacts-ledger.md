# CV artifact lifecycle ledger

| Date (America/Toronto) | Checkpoint |
|---|---|
| 2026-10-02 | Human explicitly approved the remaining roadmap under the stated boundaries. Existing worktree is `codex/vercel-hobby-fix`; the separate evaluation worker and tracker-management work remains owned elsewhere. |
| 2026-10-02 | Existing completed CV run `451cd973-d7e2-4e76-b1fc-50c32771a9e9` targets the exact Kinaxis `35379` URL. It was generated before the latest master-CV update; metadata will retain its actual timestamp and PDF hash and make no claim that it reflects the current source CV. No new render or live association has been run. |
| 2026-10-02 | Contract review completed: exact report-URL identity, completed-only PDF validation, tracker/pdf-index SHA-CAS, idempotent explicit association, and fixed Basic-auth UUID download. |
| 2026-10-02 | Implemented PDF integrity and exact report URL validation; CV+HTML persistence and render completion use one guarded Neon statement. Association uses one guarded tracker/index/run statement with a division-by-zero assertion so any CAS miss rolls the full statement back. Association failures retain completed render state and expose pending/error for retry. |
| 2026-10-02 | Added fixed metadata/list/associate/UUID-download handlers and routes. Download validates existing base64 PDF bytes against `%PDF` prefix, SHA-256, and byte size; it uses an attachment filename derived only from the run UUID and remains behind the existing Basic-auth proxy. |
| 2026-10-02 | Focused tests pass 10/10: exact identity, invalid PDF, unlinked inbox run, pending on CAS conflict, retry/idempotence, unchanged tracker on failed CAS, latest lookup, and safe fixed download headers. `npm.cmd run typecheck` passes. No full suite/browser run, new render, live association, or deploy. |
| 2026-10-02 | Waiting for root review before commit/push. Proxy allowlisting and Sites owner-authenticated download proxy remain root-owned integration follow-ups. |
