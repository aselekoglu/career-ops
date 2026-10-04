# Manual Tracker URL Targets P1 Plan

**Goal:** Let manually tracked applications use their validated job URL for evaluation and CV generation without inventing an evaluation report or rebinding identity.

**Scope:** `cloud-tracker-management.mjs`, `cloud-evaluation-runs.mjs`, `cloud-cv-runs.mjs`, `cloud-pdf-artifacts.mjs` only if needed, a pure `cloud-tracker-targets.mjs` helper, and focused tests.

**Contracts:**

- Persist `data/tracker-targets.json` as `{version:1,targets:{[applicationNumber]:{url,company,role}}}`. URLs are canonicalized through `normalizeJobUrl`; names must match the tracker row. Missing map means an empty v1 map; malformed/unknown versions fail closed.
- `cloud-tracker-targets.mjs` exports pure `parseTrackerTargets(content)`, `bindTrackerTarget(map,target)`, and `resolveTrackerTarget({applicationNumber,application,reportUrl,targets})`. Resolution uses a bound URL when present, otherwise an exact legacy report URL. A binding/report mismatch, duplicate URL ownership, or unbound reportless application fails with a specific error. Notes are never parsed as target evidence.
- Tracker manual `add` atomically writes the tracker row, status log, and target map through the existing SHA/CAS + operation-UUID mutation writer. Notes-only/status changes preserve the map; delete removes only that application's binding; archive preserves it.
- Evaluation by application number may proceed without a prior report when a binding exists. The successful report updates the same tracker row's score/report only; status, notes, date, PDF, and advanced lifecycle fields remain intact. Failed evaluation writes no report or user-data row.
- CV by application number may use the binding URL with the existing safe JD loader. Artifact association without a report is allowed only when the artifact request URL exactly equals the immutable binding for that existing application. Existing report-backed exact URL/path identity remains unchanged.

**Invariants:** No guessed target URLs, no report fabricated before a successful evaluation, no URL rebind/steal, no application changes outside the requested fields, strict confirmation for delete/archive, atomic logs/map/tracker updates, and exact report/PDF identity.

**Tasks:**

- [x] Add focused tests for map validation/uniqueness, atomic tracker add, delete cleanup, report duplicate detection, and exact legacy report fallback.
- [x] Implement the versioned target map helper and atomic tracker binding lifecycle. Add/status/notes/archive preserve identity; confirmed delete removes only its own binding through the same CAS mutation.
- [x] Add evaluation coverage for reportless manual start/process, same-row report commit with `Offer`/date/PDF/notes preserved, and existing report-backed reevaluation.
- [x] Implement application-number evaluation through a binding while keeping URL-target Inbox membership exact and failures report-free.
- [x] Add artifact coverage for reportless exact-URL association, wrong-URL rejection, nullable report path, and no fabricated PDF-index row; legacy report-backed association remains covered.
- [x] Implement CV target resolution through the bounded map and existing durable JD loader; CV request retains application number and bound URL. Node's direct loader cannot import this Next module's pre-existing extensionless imports, so root's integrated Next typecheck/build remains the final compile check.
- [x] Run focused owned tests and syntax checks. Root owns the final production build and live canary.

**Verification:** `node --test web/tests/lib/cloud-tracker-targets.test.mjs web/tests/lib/cloud-tracker-management.test.mjs web/tests/lib/cloud-evaluation-runs.test.mjs web/tests/lib/cloud-cv-artifact-lifecycle.test.mjs` — 55/55 passed, including a no-binding evaluation rejection before dispatch or document writes, a successful same-row `Offer` evaluation preserving the row's date/PDF/notes, exact reportless artifact URL matching, and no report/index fabrication. `node --check` passed for all five owned `.mjs` modules. `git diff --check` passed. No live application rows or profile/CV facts were changed. Root owns the integrated Next build and live canary.

**Review follow-up:** New manual rows now start with PDF `❌`, which represents no file yet and allows the normal validated association transition. Added one cross-module regression that creates the row through the real tracker mutation store, then associates a rendered PDF using its saved binding while keeping `reportPath:null` and leaving `data/pdf-index.tsv` untouched. Legacy report-backed matching remains scoped to application number + exact report URL/path regardless of presentation label changes; company/role equality remains required only for no-report binding association. The legacy report scan rejects 10,001 raw rows before filtering to linked tracker reports.

**Review-fix verification:** `node --check web/src/lib/cloud-tracker-management.mjs; node --check web/src/lib/cloud-pdf-artifacts.mjs` passed. `node --test web/tests/lib/cloud-tracker-management.test.mjs web/tests/lib/cloud-cv-artifact-lifecycle.test.mjs` — 35/35 passed. `git diff --check` passed.
