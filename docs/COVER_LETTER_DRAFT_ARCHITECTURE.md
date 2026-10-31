# Cover Letter Draft: Incremental Architecture (#21)

**Status: implementation draft; not production-ready.** This document records the code currently present in the incremental cover-letter work. It does not claim that issue #21 is complete or ready to close.

## Current request path

`POST /api/cover-letter` is the only wired route. The live handler first checks the existing owner Basic authentication (`CAREER_OPS_WEB_AUTH_USER` / `CAREER_OPS_WEB_AUTH_PASSWORD`) and same-origin write protections, then requires `CAREER_OPS_COVER_LETTER_ENABLED=1`. The handler also requires `DATABASE_URL`, verified hosted source documents, hosted AI, and the in-memory fact gate. Without the explicit opt-in, the route returns disabled.

The request accepts only the `start`, `status`, `edit`, `approve`, and `cancel` actions. Start requests carry application/report numbers and user-confirmed research, keywords, gap decisions, and four answers. They cannot supply candidate source documents or arbitrary source paths. The trusted resolver loads the exact tracker application, follows its numeric report link through a bounded `reports/...` path, checks the report number and exact UTF-8 SHA-256, verifies report company/role identity, requires a substantive archived JD section, then loads canonical CV and profile sources.

The prompt builder treats all supplied blocks as untrusted reference data. Candidate facts must be supported by the canonical CV; company research is limited to company claims, while the profile is positioning context. The live handler runs the generated draft through the fact gate with in-memory CV/article source text and config JSON. A blocking finding rejects the draft.

## Draft review and persistence

Runs are stored in Postgres with application/report binding, request fingerprint, idempotency key, prerequisites, draft text, SHA-256 digests, version, and status. The current states include `draft_pending`, `draft_generating`, `awaiting_review`, `render_pending_dispatch`, `rendering`, `rendered`, and `canceled`.

The generated or edited text is retained as plain text with a SHA-256 digest. Editing requires the caller's expected current digest and updates the digest. Approval likewise requires the reviewed digest to match the stored draft. The store implements an atomic database transaction that changes the run to `render_pending_dispatch`, records the approved SHA, and inserts the durable render outbox intent together. The outbox is keyed by run ID, so the same run cannot acquire multiple intents.

The live composition currently has no render dispatcher. It rejects approval before calling the approve-and-enqueue path. Therefore, the atomic outbox operation exists in the storage layer but is not an active production rendering workflow.

## Generation ambiguity

Generation uses an atomic conditional claim from `draft_pending` to `draft_generating`. Only the request that wins the claim calls the model. A concurrent or repeated start that sees `draft_generating` returns an in-progress-or-unknown response instead of generating again. If the process stops or the model outcome becomes ambiguous after the claim, the run remains `draft_generating`; the current implementation has no lease recovery or automatic retry. The caller must inspect the run status, and must not assume a retry is safe.

## Schema setup

`COVER_LETTER_SCHEMA_SQL` defines the run, render-outbox, and artifact tables, and the store exposes `ensureSchema()`. Schema setup is explicit: the live route does not call it during a request or application startup. This SQL is an initialization prerequisite for an isolated test/development database; it is not a reviewed production migration. Do not enable the feature against production data by manually applying it.

## Work still required

- Implement and review a dispatcher and authenticated worker route that consume the durable outbox idempotently.
- Connect the renderer to a real rendered-PDF flow, then verify stored artifacts and the authenticated download path end to end. The current render/worker modules are injected cores; the live route does not wire them.
- Publish MCP tools and synchronize the current hosted Site source before presenting the feature in that Site.
- Add exact Inbox/URL resolution. The current request requires explicit application and report numbers from the tracker.
- Run real Postgres and authenticated-host integration tests; current coverage is synthetic and uses injected readers, services, and database behavior.
- Keep application submission and cover-letter sending out of scope. The API and prompt only create, review, edit, cancel, and (once rendering is wired) render a draft; they do not submit an application or send a letter.
- Complete a security review of authentication, CSRF/origin protections, source binding, data retention, outbox/worker replay, artifact access, and production schema/deployment boundaries before enabling the feature.

Until those items are complete and verified, this is an opt-in draft implementation only, not a production-ready cover-letter workflow. It makes no issue-closing claim for #21.
