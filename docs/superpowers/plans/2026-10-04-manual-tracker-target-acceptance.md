# Manual tracker target acceptance — 2026-10-04/05

## Final result

**Native manual-target acceptance completed after the backend correction.** A real tracker row was created, its immutable URL binding survived a notes edit, the real CV worker generated and linked a PDF, and the real evaluation worker persisted a report. The tracker status remains `SKIP`; no application was submitted. Source CV/profile files were not edited.

## Initial runtime failure

At 2026-10-04 23:50:12 UTC, the live pipeline returned zero applications and one matching Fullscript Inbox item with `done: false`. The first `career_ops_tracker_add` attempt returned `isError: true`, `error_code: INVALID_ARGUMENT`, and `TRACKER_REQUEST_FAILED`. A fresh pipeline read at 23:50:30 UTC showed no application row and the same Inbox item still `done: false`. This was a runtime failure, not a completed operation.

## Successful tracker acceptance

After the root confirmed the corrected native deployment READY (deployment `dpl_J1Pf3jBswm6rTT2vq2bkbrXTdvKm`, correction `265bc3dcaa7d44cec30fdefbd08423298740fa6a`), the exact original request was replayed with its original operation ID `cf0c0f80-5b22-4ad6-9206-8762bb81627a`:

- Company: `Fullscript`
- Role: `Senior Developer, Fullstack - Warehouse Management Systems (WMS)`
- URL: `https://jobs.lever.co/fullscript/e1de472c-c22b-4f29-9299-3253f0444711`
- Source: `Career Ops MCP manual-target validation (existing Inbox posting)`
- Status: `SKIP`; date and score omitted

The native response created application `#46`, with null score and report. Replaying the same operation ID returned `replayed: true` and the same row. A fresh operation ID `8f3432c2-d3c6-4f10-b424-f632b78943c0` with the same URL returned `TRACKER_TARGET_URL_CONFLICT`; no second row appeared. The exact note `Manual target validation: URL identity remains bound after notes edit; no application submitted.` was written with operation ID `fb2c0a85-e6d8-4ad3-8f4c-5d8ff685f39b`; a fresh read preserved application `#46`, company, role, date, and `SKIP` status.

## CV artifact

Before evaluation, native CV generation for application `#46` with `pageFormat: letter` returned run ID `9a25c762-1951-43d8-995b-21d1eb814579`. It completed with `applicationNumber: 46`, `reportPath: null`, and `associationStatus: linked`. The persisted artifact metadata identifies the same target application `#46`, type `application/pdf`, size 66,980 bytes, and SHA-256 `9ead62547ec8783c8995a53a69644e1f0a40f037a2543bdc2e7799efbb93652f`. The private authenticated artifact export verified the PDF and returned the same 66,980-byte count. No private download URL or PDF content is recorded here.

## Evaluation and final readback

Native evaluation run `a966697c-96e8-4ebb-97b3-bd447689fff8` completed for application `#46` with score `3.4` and persisted report path `reports/046-fullscript-2026-10-05-rerun-a966697c.md`. The report tool confirmed the same run/path; report content is intentionally omitted from this evidence note. Final tracker read showed date `2026-10-05`, score `3.4/5`, status still `SKIP`, PDF `✅`, the report link, and the exact note above. The Fullscript Inbox item remained present with `done: false`. The row has a real report and PDF now; no status transition to Evaluated or Applied was made.