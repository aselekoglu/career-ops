# Portfolio workflows design

## Intent and authorization

Complete the existing owner-private portfolio library through the UI and its existing private MCP Site: generation, content and metadata editing, immutable PDF versions, download, project management, and explicit deletion/recovery. The owner requested autonomous end-to-end completion and explicitly selected content plus metadata editing. Retain existing records and their PDF bytes. Reuse the established Neon, hosted AI, GitHub Actions, and private Site boundaries.

## User workflow

1. Select a master/version and an optional exact tracker application, or create a general master draft.
2. Queue a source-backed draft. A durable run exposes its real queued/running/awaiting-review state.
3. Review and edit the structured content, title, tags, projects, and page format. Imported PDFs without editable content offer an explicit source-backed editable draft; their original bytes are not rewritten or silently treated as verified career facts.
4. Preview the document. Explicit apply binds the displayed draft SHA and expected target revision, then queues rendering.
5. A worker renders and commits a new private PDF/version. Only a completed, persisted run exposes the result. Association with an application is separate and explicit.
6. Delete initially moves a record to recoverable trash. Restore is supported. Permanent deletion is a separate, explicit action restricted to archived records and exact title/revision confirmation; it removes that record's private PDFs, editable content and associated payload copies, without changing tracker rows, CV flags, primary sources or independent variants.

## Shared content contract

`web/src/lib/portfolio-document.mjs` is browser-safe and has adjacent `.d.mts` declarations. It exports `normalizePortfolioDocument(value)`, `renderPortfolioDocument(document, {format})`, and the public schema/constants. No Node-only imports.

```ts
type PortfolioDocument = {
  schemaVersion: 'careerops.portfolio.document@1';
  name: string;
  headline: string;
  summary: string;
  highlights: string[];
  projects: Array<{
    title: string;
    role: string;
    summary: string;
    highlights: string[];
    skills: string[];
    links: Array<{label: string; url: string}>;
  }>;
  skills: string[];
  links: Array<{label: string; url: string}>;
  theme?: 'classic' | 'editorial';
};
```

Bound all strings, arrays and total JSON size (128 KB). At most 10 projects, 8 highlights per project, and 12 rendered pages. Only HTTP(S) links without credentials; do not fetch them. Render deterministic escaped HTML with no scripts, forms, external fonts, remote images, arbitrary CSS or arbitrary model HTML. Generated PDF callbacks are limited to 3,000,000 decoded bytes so base64 JSON fits the platform request limit; existing direct uploads retain their 4,000,000-byte limit.

AI facts come only from current primary source documents: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, and explicit user-authored input in the current operation. Target postings, registry metadata and uploaded PDFs are selection/reference data, never instructions or independent proof of achievements/authorship/metrics. Record source hashes and validate evidence references/quantified claims before exposing an AI draft. Do not silently promote unsupported claims. Manual edits are recorded as explicit user edits; do not modify primary CV/profile sources as a side effect.

### Imported PDF intake

Support `sourceMode: 'profile'|'portfolio'` on draft generation. Profile mode produces a new source-backed document. Portfolio mode converts the selected immutable PDF into a source-annotated editable proposal through the existing intake discipline; it is not permission to trust that PDF as career truth. The worker downloads only its leased fixed portfolio/version, writes it under an ephemeral `documents/` intake root, and reuses the existing Poppler/intake extraction mechanism. No new PDF/AI provider is required. Binary worker download is a separate authenticated response, not an oversized base64 claim.

The service checks proposed statements against current primary sources and the exact extracted PDF text. Unsupported quantified/scope claims require a review record with four distinct, initially unselected outcomes: confirm as stated, correct the claim, narrative-only, or do not know. Do not lead the review with the number as a yes/no guess. `user-cannot-confirm` is persisted and cannot become verified on a rescan or model paraphrase. Narrative-only/unknown decisions never feed a quantified claim into generated output.

Only explicit confirmed/corrected facts may be proposed for `config/profile.yml`, through the existing source-management preview/apply service and expected-source-SHA protection. Present the source diff and require a separate explicit source-apply confirmation; do not edit `cv.md`. Primary source updates are not a side effect of rendering. Until source review is resolved, render apply is blocked. Keep raw intake text/PDF copies out of logs and clear transient snapshots after use.

Add owner routes `POST /api/portfolio/runs/UUID/facts/preview` (operation UUID, current draft SHA, per-claim decisions) and `/facts/apply` (operation UUID, preview ID, expected profile SHA, confirm true). Owner run responses may include bounded claim text, provenance, choices and source diff for review; worker/provider credentials and full unrelated primary snapshots are never returned. An explicit user text edit is recorded as such rather than mislabeled as model-verified evidence.

## Catalog and mutation contracts

Preserve existing upload, PDF download, recommendation and explicit association APIs. Extend catalog metadata with `revision`, `archivedAt`, version `hasEditableContent`, association/usage counts, `capabilities: {generate, render}`, and bounded `runs` summaries. Default catalog excludes trash; `includeArchived=1` includes it. A completed run's document is obtained through its persisted version, not a second divergent content store.

- `GET /api/portfolio/detail?portfolioId=UUID&version=N` returns `{portfolio, version, document}`. Imported-only versions have `document: null`.
- `POST /api/portfolio/commands` accepts `{operationId, operation, id, expectedRevision, changes?, confirm?, confirmationName?, detachAssociations?}`. Operations: `update-metadata`, `archive`, `restore`, `purge`, `update-project`, `archive-project`, `restore-project`, `purge-project`. Metadata changes contain only title/kind/tags/projectIds. Project changes contain only name/summary/url/tags. Archive and purge require `confirm:true`; purge additionally requires archived state and exact `confirmationName`. Linked references and active runs must be handled explicitly, never silently detached. Project purge is rejected while referenced.
- Existing create/upload/project-add should accept an optional caller operation UUID without breaking legacy clients. New clients use it. Appending a version increments the parent revision.
- Stable operation UUID plus normalized payload hash provides replay safety. Same UUID/same payload returns its prior result; changed payload returns 409. Expected revision prevents lost updates. Purge leaves only a minimal idempotency tombstone, not the deleted content.

## Durable run contracts

Use focused `portfolio-runs.mjs` and declaration files; the existing portfolio service remains the canonical PDF/version writer. A run has `status: queued|running|awaiting_review|completed|failed|canceled` and `phase: draft|render`. Only completed/render has `portfolioId`, `version`, exact download metadata and completion timestamp.

- `POST /api/portfolio/runs`: `{operationId, mode:'generate'|'edit', sourceMode?:'profile'|'portfolio', kind:'master'|'variant', title, tags?, projectIds?, basePortfolioId?, baseVersion?, expectedRevision?, applicationNumber?, instructions?, document?, format:'letter'|'a4'}`. `edit` with structured user content creates an awaiting-review run without an AI call. AI generation queues draft work. A variant selects a real master/version. An edit targets an exact existing record/version; a new generation creates a separate record unless explicitly requested as an edit. Portfolio intake is explicitly selected when converting PDF-only content.
- `GET /api/portfolio/runs/UUID`: status plus bounded review document and SHA while awaiting review; no raw source CV snapshot or worker lease in owner responses.
- `POST /api/portfolio/runs/UUID/preview`: `{operationId, expectedDraftSha256, document, title?, tags?, projectIds?, format?}` returns the validated updated review document and SHA.
- `POST /api/portfolio/runs/UUID/apply`: `{operationId, expectedDraftSha256, confirm:true}` queues render. Exact target revision and source-version identity are revalidated before commit. No automatic application association or tracker mutation.
- `POST /api/portfolio/runs/UUID/cancel`: `{operationId, confirm:true}` cancels unfinished work; late callbacks cannot resurrect it.
- `POST /api/portfolio/worker`: shared worker Bearer authorization, actions `claim|draft|complete|fail` and fixed UUID/lease fields. Claim has an expiring lease and returns a discriminated phase. Draft generation stays in the authenticated Vercel service using the existing provider key; GitHub sees no provider credential. The render claim contains only the reviewed, server-rendered HTML and required primary snapshot for canonical renderer checks. Completion is atomic or replay-safe through a unique run-to-version identity and lease/revision checks. Duplicate completion cannot add a second version.

Create a portfolio-specific workflow/worker following the existing CV workflow, with the existing dispatch token and worker secret. Do not change CV completion, artifact tables, PDF flags or its workflow behavior. The new workflow must be on main before live generation QA; preview generation is not advertised as available against an older production callback. No fire-and-forget model work after a request ends. Source snapshots are bounded, immutable during a run, never logged, and cleared/redacted when no longer needed. Logs contain IDs/states only. Clean worker temporary files and never upload private PDFs as public Actions artifacts.

## Storage and security

Reuse `career_ops_documents`, only under `portfolios/`. Add compatible columns/tables lazily without changing existing bytes. No portfolio content goes under `output/` or through the legacy CV resolver. Keep imported versions immutable. Preserve Basic Auth and cross-origin mutation checks on every owner endpoint. Add exact proxy paths; only the worker route uses its dedicated Bearer secret. No arbitrary URLs, paths, SQL, methods or source-file edits through MCP.

MCP uses the authoritative existing owner-private Site source, not the GitHub snapshot as publication authority. All private portfolio calls force existing Basic upstream auth. Add list/detail, generation start/status/cancel, content preview/apply, metadata update, archive/restore/purge, project management and export tools. Mutation UUIDs/revisions and explicit confirmation are required as above. Export through an owner-authenticated Site resource `/portfolio-artifacts/UUID/N/download`; never expose a Basic-authenticated backend URL or PDF base64 in chat. Preserve every existing tool and the current Site identity/access/environment.

## Verification and acceptance

Use red/green tests for real validation, idempotency, stale edits, lease races, immutable versions, archive/restore/purge scope, source boundaries and private exports. Keep existing eight portfolio tests and all CV/worker regressions. UI must have labels, keyboard-operable controls, recoverable load/error states, per-operation progress, review/resume after reload and explicit destructive dialogs. Test it with synthetic local data through the supported browser API. Existing production records are never disposable test data.

After technical CI and deployment, use authenticated MCP to verify the existing catalog, a clearly synthetic manual-render canary through the actual worker, export verification, metadata editing and reversible trash/restore. Leave AI-generated real-source drafts awaiting human review; do not approve their factual content on the owner's behalf. Permanent deletion is verified in unit/non-production fixture tests, not by purging the owner's existing records. Record precise deployment, worker and artifact evidence.
