# Career Ops MCP CV Generation Contract

## Goal

Expose the existing Career Ops CV-tailoring/PDF workflow to ChatGPT without bypassing the source CV, canonical `modes/pdf.md` rules, HTML template, ATS normalization, page budget, or durable cloud storage.

The MCP bridge remains a thin authenticated proxy. Generation and rendering are owned by Career Ops.

## MCP tools

### career_ops_cv_generate_start

Starts one durable CV-generation run.

Input:

```json
{
  "applicationNumber": "17",
  "pageFormat": "letter"
}
```

or:

```json
{
  "url": "https://careers.example.com/jobs/123/job",
  "pageFormat": "letter"
}
```

Rules:

- Exactly one of `applicationNumber` or `url` is required.
- `applicationNumber` must resolve to an existing Career Ops application and evaluation report.
- `url` must normalize to an exact URL already stored in the Career Ops inbox. This prevents the MCP surface from becoming an arbitrary fetch proxy.
- `pageFormat` is optional and is `letter` by default; `a4` is also accepted.
- The tool never submits an application or contacts an employer.

Success response:

```json
{
  "runId": "uuid",
  "status": "generating|queued|running|completed|failed",
  "company": "Kinaxis",
  "role": "Co-op/Intern Forward Deployed Engineer",
  "format": "letter",
  "artifactPath": null,
  "downloadUrl": null,
  "requestedAt": "ISO-8601",
  "startedAt": null,
  "completedAt": null,
  "errorCode": null
}
```

HTTP mapping: `POST /api/cv-runs`.

### career_ops_cv_generate_status

Reads exactly one durable run by its returned UUID.

Input:

```json
{ "runId": "uuid" }
```

Completed response additionally contains:

```json
{
  "status": "completed",
  "artifactPath": "output/cv-kinaxis-co-op-intern-forward-deployed-engineer-....pdf",
  "downloadUrl": "https://career-ops-aselekoglu.vercel.app/api/cv-pdf?artifact=..."
}
```

HTTP mapping: `GET /api/cv-runs/{runId}`.

Callers must keep polling while state is `generating`, `queued`, or `running`. A queued run must never be reported as completed.

## Career Ops execution path

1. Resolve the target from the stored application/report or exact inbox URL.
2. Read the stored source `cv.md` and `config/profile.yml`.
3. Use hosted Gemini with a dedicated `cv` task and web search disabled.
4. Apply the complete canonical `modes/pdf.md` instructions and `templates/cv-template.html`.
5. Parse the existing `<<cv-html format="...">> ... <</cv-html>>` envelope and fail closed on malformed output.
6. Reject unsafe or unfilled HTML.
7. Persist a durable run in Neon and dispatch the existing GitHub worker pattern.
8. The worker materializes the source CV/profile in an ephemeral checkout and runs the repository's existing `generate-pdf.mjs` renderer, preserving ATS normalization, theme tokens, local-only rendering, and the two-page budget.
9. Store the exact HTML and PDF in `career_ops_documents`.
10. Return an exact artifact URL instead of a company-name "latest PDF" lookup.

## Security and privacy

- Basic Auth continues to protect user-facing Vercel routes.
- Worker callbacks require `CAREER_OPS_SCAN_WORKER_SECRET`.
- GitHub dispatch reuses `CAREER_OPS_SCAN_DISPATCH_TOKEN`.
- The worker logs run metadata only; generated CV HTML is not printed.
- Job URLs are accepted only when already present in the user's inbox and use HTTP(S) public hosts.
- Posting fetches are size- and time-bounded.
- Hosted Gemini receives source CV/profile and target evidence but cannot browse, call tools, submit applications, or mutate other Career Ops records.
- Generated HTML rejects scriptable/active elements and unresolved template placeholders.
- PDF rendering uses the repository's existing Playwright renderer, which disables JavaScript and blocks non-local resource requests.

## Thin MCP bridge

The installed Career Ops MCP server only needs to add two proxy tools. Pseudocode:

```js
server.tool("career_ops_cv_generate_start", startSchema, async (args) =>
  requestCareerOps("/api/cv-runs", {
    method: "POST",
    body: JSON.stringify(args),
  })
);

server.tool("career_ops_cv_generate_status", statusSchema, async ({ runId }) =>
  requestCareerOps("/api/cv-runs/" + encodeURIComponent(runId))
);
```

The bridge should forward the existing authenticated Career Ops credentials, return the API JSON verbatim, and must not itself generate, tailor, render, or store CV content.
