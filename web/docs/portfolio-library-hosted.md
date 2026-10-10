# Hosted Portfolio Library — using the existing CV PDF store

**Implementation base:** `codex/vercel-hobby-fix` (the code deployed to
`career-ops-aselekoglu.vercel.app` in October 2026). This branch diverges from
`main`, which currently lacks the hosted CV/Neon artifact implementation.
Merge this PR into the *hosted branch*, not the older local-first `main`,
until those histories are reconciled.

## Features

- Portfolio sidebar page at `/portfolio` (desktop and mobile).
- Master or role-focused variant PDF upload; immutable PDF version history.
- Reuses `career_ops_documents` for Base64 + SHA-256 + byte-size storage,
  precisely as `cloud-pdf-artifacts.mjs` does for tailored CVs.
- New normalized metadata tables for portfolios, versions, project registry
  (title, summary, HTTPS evidence URL, tags) and explicit application links.
- Deterministic, explainable role/tag matching using the *actual tracker
  application number* and role; no invented match score and no auto-attachment.
- Downloads via authenticated API as attachments; no public PDF links.
- Existing CV workflows, routes, `career_ops_cv_runs`, PDF flags, and tracker
  entries are untouched.

## One-time owner setup

1. Ensure `DATABASE_URL` is already configured (used by current CV workflow).
2. In Vercel project settings, add `CAREER_OPS_PORTFOLIO_TOKEN` as a **secret
   random value of at least 32 characters**. Do not commit the token. Assign
   it only to intended environments; redeploy after configuring.
3. Visit `/portfolio`, paste the token into the owner access field, click
   **Unlock library**. The token lives only in in-memory React state, not
   localStorage or cookies. All portfolio endpoints require a secondary owner-secret header (in addition to existing site Basic Auth),
   including PDFs. Missing configuration fails closed with 503.
4. Import the PDF previously created for Brookfield as a `variant` and tag it
   `business analyst, automation, system integration`. Upload a separate
   general master once you have reviewed and removed role-specific wording.
5. Enter Career Ops application `54`, inspect the role match, and explicitly
   click Attach to link the selected immutable version. Linking neither
   edits your tracker PDF flag nor submits an application.

The existing Brookfield PDF is *not* committed here or uploaded to Neon by
this PR; uploading private PDF bytes into the public Git repository is unsafe.
Use the owner-protected upload UI **after merging/deploying**.

## Data contracts

New tables created lazily/idempotently on first authenticated request:

- `career_ops_portfolios` — ID, title, kind (`master|variant`), tags, project IDs.
- `career_ops_portfolio_versions` — immutable version, exact document path,
   SHA-256, bytes.
- `career_ops_portfolio_projects` — approved project descriptions and URLs.
- `career_ops_portfolio_applications` — 1 explicit portfolio version per
   canonical tracker number; reassignment requires user action.

Document paths are random, e.g. `portfolios/{id}-{uuid}.pdf`. A PDF\nnever enters the existing CV-specific `cv-` namespace, so it will not appear
as a tailored CV or be accidentally associated with a company-slug search.

## Security and limits

- Owner-only `X-Career-Ops-Portfolio-Token` on **every** route (constant-time compare).
- Cross-origin write rejection; requests never use ambient cookie credentials.
- Max **4,000,000 bytes per PDF** to fit Vercel Hobby request limits.
- PDF magic, EOF marker, exact byte length, SHA-256 and base64 canonicalization.
- PDFs download with `Content-Disposition: attachment`, no-store and nosniff.
- Project URLs must be HTTPS with no embedded credentials.
- Client filename is never used as a storage key.
- DB write CTEs prevent orphan metadata when uploads fail.
- Simple header/EOF checks are **not malware scanning or PDF sanitization**:
  treat imported PDFs as trusted user files, download (not inline render) them.
- One long-lived owner token protects this MVP; rotation and true per-user
  sessions are recommended before multi-user access. Don't put the token in a URL.

## API

`GET /api/portfolio` — metadata and versions, projects, associations

`POST /api/portfolio` — multipart file/title/kind/tags/projectIds, or
file/portfolioId for new immutable version

`POST /api/portfolio/projects` — JSON project data

`GET /api/portfolio/recommend?applicationNumber=54` — exact tracker lookup,
keyword recommendation; no writes

`POST /api/portfolio/associate` — JSON applicationNumber/portfolioId/version

`GET /api/portfolio/pdf?portfolioId=<uuid>&version=N` — authenticated bytes

All routes require `X-Career-Ops-Portfolio-Token <owner-secret>`.

## Verification

```bash
cd web
npm ci
npm test
npm run typecheck
npm run build
```

Additional migration rehearsal should be performed against a **non-production**
Neon branch prior to merge. Do not change the current CV records.

## Deferred

AI-based selection, PDF layout generation, project screenshot acquisition,
multi-user accounts / JWT auth, screenshot image storage, and bulk historical
import. The current feature reuses completed PDFs rather than claiming to
regenerate them.

## Operational notes

Production is currently deployed from `codex/vercel-hobby-fix`. Its hosted
artifact store is distinct from the local-first `main` branch, which was
rebased/diverged. This PR intentionally targets the actual deployed code.

## CV endpoint isolation

Portfolio documents deliberately use the `portfolios/` path prefix, **outside** `output/`. The existing, unauthenticated `/api/cv-pdf?company=` legacy scanner enumerates `output/` PDFs. Using `output/portfolio-` would leak private portfolio PDFs through that route, so that prefix is forbidden. The only portfolio PDF reader is the owner-authorized `/api/portfolio/pdf` endpoint.

### Existing hosted Basic Auth integration

The Next.js `proxy.ts` validates the site's HTTP Basic authentication before route dispatch. The portfolio owner token is sent separately as `X-Career-Ops-Portfolio-Token`, because overwriting `Authorization` with `Bearer` would otherwise cause a 401 at the proxy. The proxy allowlists only the explicit portfolio route/method pairs; the route handlers enforce the secondary secret and deny all other requests by default.
