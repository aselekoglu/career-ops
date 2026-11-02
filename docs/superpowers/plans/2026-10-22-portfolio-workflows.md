# Portfolio Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete private portfolio generation, editable content/metadata, versioning, deletion/recovery and MCP/UI parity without changing existing uploaded PDF bytes.

**Architecture:** Extend the existing Neon portfolio library and canonical private version writer. Use source-backed structured drafts and an explicit review/apply boundary, then a portfolio-specific GitHub Actions worker following the existing hosted CV pattern. Keep the authoritative owner-private Site as a fixed-path proxy and authenticated resource exporter.

**Tech Stack:** Existing Next 16.3.8/React, Node 24, Neon serverless SQL, hosted Gemini/OpenAI service, canonical PDF renderer, GitHub Actions, private Sites MCP.

**Spec:** `docs/superpowers/specs/2026-10-22-portfolio-workflows-design.md`

## Global Constraints

- Active worktree is `tmp/career-ops-main`, branch `codex/portfolio-workflows`, based on deployed main `d00068f0`.
- Existing uploaded records, versions and primary source files are preserved. Test destructive operations only on synthetic fixtures; production canaries are reversible.
- New private PDFs use `portfolios/` only. No public CV resolver, arbitrary upstream URL, new credential, model provider, blob store or public Site.
- Explicit stable operation UUIDs, revision checks, draft SHA confirmation and worker leases are contracts, not UI-only checks.
- Models use primary facts; content and metadata editing is the owner-selected scope. Unsupported uploaded-PDF claims are not silently promoted.
- Keep CV/evaluation/scanner contracts unchanged. No new source-CV/profile edits or inferred tracker status/PDF/association changes.
- Use actual installed Next docs where needed. Windows commands use `npm.cmd`; heavy checks require the correct elevated environment, process-local Git Bash and bounded test concurrency. Capture logs outside committed source.

## Review Focus

- A callback retry or stale lease must not duplicate a PDF version or resurrect a canceled/purged target.
- Two editors must get a visible stale-revision conflict rather than silently overwrite content/metadata.
- PDF-only imports must retain original bytes and visibly explain how an editable version is created.
- Archive/purge of linked records must preserve independent artifacts and never touch CV/tracker data.
- An unauthenticated resource request or alternate URL/path must not expose a private PDF or source snapshot.

### Task 1: Canonical document and portfolio lifecycle

**Owner:** backend Luna worker (all backend/storage modules, routes, proxy and workflow boundaries).

**Files:** `web/src/lib/portfolio-cloud.mjs`, `.d.mts`, new `portfolio-document.mjs`/`.d.mts`, focused lifecycle tests, portfolio detail/commands routes. Update existing upload/project contracts compatibly.

**Interfaces:** Produce the shared document functions/types and spec catalog/commands contracts before UI/MCP integration. Preserve the existing `createPortfolioStore(sql)` injection boundary; expose a single validated canonical generated-version writer with unique run identity and revision/lease protection.

- [ ] Write and observe failing tests for document escaping/bounds, metadata CAS, operation replay/conflict, immutable versions, trash/restore, scoped purge and linked-project protection.
- [ ] Implement compatible schema changes and the single private version writer.
- [ ] Run existing and new lifecycle suites; send actual exported types/routes to the other workers.
- [ ] Commit the independently verified slice with no user/test artifacts.

### Task 2: Durable draft/review/render workflow

**Owner:** same backend Luna worker; may delegate a narrow renderer/test task when a slot is free, preserving ownership boundaries.

**Files:** new `web/src/lib/portfolio-runs.mjs`/`.d.mts`, `/api/portfolio/runs` and exact run-action routes, `/api/portfolio/worker`, `web/scripts/cloud-portfolio-worker.mjs`, `.github/workflows/career-ops-portfolio-render.yml`, proxy/health readiness and focused run/worker tests.

**Interfaces:** Consume canonical document and portfolio writer; expose the run contracts in the spec. Reuse existing hosted AI/source readers, dispatch token, branch/ref conventions, worker secret and canonical renderer.

- [ ] Write failing lifecycle tests for generate/edit review states, source-only facts, no early PDF write, stale draft/target, cancellation, claim leases, duplicate completion, render bounds and safe errors.
- [ ] Implement the service and worker with IDs-only logs, temporary cleanup, authenticated callbacks and no public artifact upload.
- [ ] Add explicit imported-PDF intake using the existing extractor, source-annotated claims, four-outcome unverified-claim review, durable unknown markers and existing profile source preview/apply. Test no automatic promotion or primary-source write.
- [ ] Verify rendering a synthetic document and all existing CV worker regressions without real-user writes or model calls.
- [ ] Commit after focused checks and hand the exact API surface to UI/MCP workers.

### Task 3: Complete the existing portfolio UI

**Owner:** UI Luna worker; owns `portfolio-view.tsx` and focused portfolio UI/client/editor components/helpers/tests only.

**Interfaces:** Consume shared document/types and fixed API contracts. Do not reimplement server validation, persistence, rendering or AI. Use the existing visual system.

- [ ] Add explicit loading/empty/retry, accessible labels, per-operation pending/error states and catalog run recovery.
- [ ] Add generate, structured editor/preview/apply, immutable result selection/download, metadata/project editing, trash/restore and explicit permanent-delete confirmation.
- [ ] Preserve stable mutation UUIDs for retries and show actionable stale-revision/source conflicts.
- [ ] Verify meaningful client parsing/state tests and rendered interactions in synthetic local QA; no new tests that merely mirror markup.

### Task 4: Private MCP parity and resources

**Owner:** MCP Luna worker; owns authoritative `tmp/career-ops-mcp-authoritative/src/server.mjs`/tests/panel if necessary. Root owns native Site calls, source helper, secrets and publication.

- [ ] Add the fixed tools/schemas/response allowlists from the spec, with Basic-only upstream auth and caller-stable operation keys.
- [ ] Add exact private resource export/download route and trusted-owner header enforcement. Preserve all existing tools.
- [ ] Red/green tests: unauthenticated denial, fixed paths, invalid IDs/unknown fields, replay args, preview/apply confirmation, archive versus purge, resource scope and no secret/byte exposure.
- [ ] Run all bridge tests and Worker build; root reviews and publishes through the official source helper to the unchanged private project.

### Task 5: Integration, documentation and live acceptance

**Owner:** root orchestrator plus fresh Luna reviewer/verification tasks.

- [ ] Independently review storage/lease/source/private-export boundaries and fix validated findings.
- [ ] Update hosted portfolio/deployment docs to main's actual architecture, current Basic Auth and full workflow. Remove stale branch/token instructions and private application examples.
- [ ] Run focused tests, full hosted tests, typecheck, build and appropriate full root gate once changes settle. Use logs and exact candidate tree.
- [ ] Create/attach PR, pass applicable technical CI, merge main and fast-forward the worker branch; confirm exact production SHA/alias.
- [ ] Publish the existing private MCP Site through its authoritative source/helper and verify tool/resource discovery.
- [ ] Verify actual catalog plus synthetic manual-render canary/export/metadata/trash/restore through native MCP; preserve all pre-existing records. AI drafts remain awaiting human review.
- [ ] Record final evidence, keep main clean and remove only finished disposable feature branch/worktree state; preserve unfinished work and ignored user data.
