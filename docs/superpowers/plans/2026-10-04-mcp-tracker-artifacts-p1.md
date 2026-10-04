# MCP Tracker and CV Artifact P1 Plan

**Goal:** Make hosted tracker commands and CV artifact association work against legacy user documents without weakening exact identity, status, confirmation, idempotency, or CAS safeguards.

**Scope:** `web/src/lib/cloud-tracker-management.mjs`, `web/src/lib/cloud-pdf-artifacts.mjs`, `web/src/lib/cloud-cv-runs.mjs`, focused tests, and a narrow shared alias-data helper only if the existing bundle does not provide one.

**Plan:**

- [x] Reproduce alias-document absence; missing `data/tracker-aliases.json` produced `TRACKER_FORMAT_INVALID` for a legacy `Num` header. Verified the checked-in canonical alias JSON and column detector.
- [x] Add failing regression for tracker CRUD, then cover legacy nine-column tracker/PDF association with no Neon alias document. Existing tests retain wrong-target, replay, and CAS-conflict checks; root read-only evidence confirmed CV requests store `applicationNumber` at the top level.
- [x] Generate the web-bundled alias asset from root `tracker-aliases.json` in `prebuild`; tracker CRUD and PDF association share the resolver. Missing alias docs remain absent from Neon; malformed stored docs still fail closed.
- [x] Confirm the existing CV completion path uses the exact top-level application number and unchanged completed-artifact/report identity fences; no CV-run selector patch was necessary.
- [x] Run four focused alias suites: 34/34 pass; syntax checks and `git diff --check` pass. Root owns final production build and native-MCP canary.
- [x] Report exact causes, changed files, and verification. Commit, push, deployment, and production artifact association remain with root.

**Steered P1 additions:**

- [x] Reuse the strict import URL validator for manual Inbox URLs while preserving the exact stored string; cover IPv6, mapped IPv4, internal host, and numeric alternate IPv4 forms.
- [x] Route evaluation and CV fallback page reads through the DNS-pinned `fetchPublicPosting` transport while retaining the trusted evaluation fetch injection. CV selection now uses the shared tracking-aware normalizer so distinct job-ID query values remain distinct.
- [x] Add optional bounded global CV artifact listing while preserving per-application fields. The SQL page is capped at 101 runs and returns stored PDF metadata only; download and association continue to validate actual bytes.
- [x] Run focused suites: 54/54 pass across tracker, evaluation, sidecar, and CV/PDF artifacts; syntax checks and `git diff --check` pass.
- [ ] Root final build and native-MCP canary remain pending.

**Invariants:** Preserve raw unrelated tracker rows; keep existing ambiguity and exact-URL guards; use canonical lifecycle statuses and source tags; do not infer or alter candidate/user content; never associate a completed PDF to a different report or application.
