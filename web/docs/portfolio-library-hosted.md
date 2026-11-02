# Private hosted portfolio workflows

The integration source is `main`. The release reconciliation brought hosted
Neon/CV support and the v1.37 system into one history; changes belong on main,
not exclusively on the historical `codex/vercel-hobby-fix` deployment branch.
That ref remains configured for existing worker dispatches and follows the
reviewed production commit.

## Owner workflow

Open `/portfolio` with the existing Career Ops Basic login. Import a master
or tailored PDF, retaining each immutable original version. Existing PDFs
have no editable document until an explicit conversion or new source-backed
draft creates one.

Generate from primary CV/profile sources, or convert an exact uploaded PDF
through intake. Intake treats PDF text as reference data and compares it with
primary sources. Unsupported quantified or scope claims require separate
review: confirm as stated, correct, narrative-only, or do not know. Unknown
claims remain unverified. Profile changes require a source preview and a
separate explicit apply; rendering never updates the primary CV implicitly.

Edit structured content and metadata, preview, then explicitly apply the
current draft SHA. Durable run state distinguishes draft generation, review
and rendering. The external worker writes a new private PDF version only
when the reviewed run, lease and target revision still match. Select older
versions to download their unchanged bytes. Application association is a
separate explicit action against the canonical tracker application number;
it does not set CV flags or submit an application.

Delete first moves a portfolio/project to trash. Restore recovers it.
Permanent deletion requires an archived item, its current revision and exact
name confirmation. References and active runs must be resolved explicitly.
Independent variants, tracker entries and primary facts are outside its scope.

## Storage

The library uses the existing `career_ops_documents` artifact store, with
portfolio records, immutable versions, project metadata and explicit
application associations. Compatible migrations add revisions, trash state,
editable structured documents, operation replay records and durable runs.

All portfolio PDF paths begin with `portfolios/`. They must never use
`output/` or the legacy public company-based CV resolver. Client filenames
are display data and never database paths. Logs must omit private PDF bytes,
raw intake text, primary source snapshots and credentials.

## Authentication and limits

Every owner endpoint requires the same existing site Basic credentials.
There is no `X-Career-Ops-Portfolio-Token` credential. The private MCP Site
forces the same Basic upstream authentication for portfolio calls; read-only
tracker tokens cannot authorize private PDFs. Its download resource requires
trusted Site visitor identity and exposes no Basic-authenticated backend URL.
Cross-origin browser writes are rejected.

Direct PDF imports retain the 4,000,000-byte limit. Generated PDF callbacks
have a 3,000,000-byte decoded limit so their base64 request fits the platform.
The structured document is bounded to 128 KB, 10 projects and 12 rendered
pages. Deterministic HTML escapes text, permits credential-free HTTP(S) links
and fetches no arbitrary remote images, fonts or scripts. Imported PDF magic,
EOF, size and SHA checks establish file integrity, not malware sanitization.

## Fixed API surface

| Path | Purpose |
| --- | --- |
| `GET /api/portfolio` | Catalog; `includeArchived=1` includes trash |
| `POST /api/portfolio` | Existing multipart import or immutable version append |
| `GET /api/portfolio/detail` | Exact portfolio/version and optional structured document |
| `POST /api/portfolio/projects` | Project creation |
| `POST /api/portfolio/commands` | Revision-checked metadata/project lifecycle operations |
| `GET /api/portfolio/recommend` | Explainable exact-application role/tag matching |
| `POST /api/portfolio/associate` | Explicit portfolio-version association |
| `GET /api/portfolio/pdf` | Authenticated immutable PDF attachment |
| `POST /api/portfolio/runs` | Generate, content edit or imported-PDF intake |
| `GET /api/portfolio/runs/{uuid}` | Durable progress and review state |
| `POST /api/portfolio/runs/{uuid}/preview` | Validate edited content and return draft SHA |
| `POST /api/portfolio/runs/{uuid}/apply` | Explicit exact-draft render confirmation |
| `POST /api/portfolio/runs/{uuid}/cancel` | Cancel unfinished work |
| `POST /api/portfolio/runs/{uuid}/facts/preview` | Review source-annotated intake claims |
| `POST /api/portfolio/runs/{uuid}/facts/apply` | Separate confirmed profile-source update |
| `POST /api/portfolio/worker` | Dedicated Bearer-authenticated worker callback |

Mutation operation UUIDs are stable across retries. Reusing a UUID with a
changed payload is a conflict. Stale target revisions and stale draft hashes
must produce visible conflicts rather than overwrite newer content.

## Deployment and verification

Reuse the existing Neon, hosted AI provider, GitHub dispatch token and worker
secret. The portfolio workflow must be on the dispatched main/ref before
advertising live generation; callbacks target the deployed fixed service.
No private PDF is uploaded as a public Actions artifact. Vercel request work
must finish within its lifecycle; durable external workers handle rendering.

Run focused lifecycle, source, worker, private-resource and client tests;
then hosted tests, typecheck, production build and the repository gate.
Exercise the rendered UI with synthetic fixtures. After deployment verify
the exact production SHA, native MCP discovery and a reversible synthetic
worker canary. Preserve every pre-existing portfolio and its PDF hashes.
AI drafts containing real career facts remain awaiting owner review.

See the [workflow design](../../docs/superpowers/specs/2026-10-22-portfolio-workflows-design.md)
and [implementation acceptance plan](../../docs/superpowers/plans/2026-10-22-portfolio-workflows.md)
for the full contracts and remaining verification checklist.
