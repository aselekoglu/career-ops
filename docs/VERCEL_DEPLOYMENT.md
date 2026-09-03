# Vercel deployment boundary

The current Career Ops web UI is **local-first**. It reads the same user-layer
files as the CLI and, for some actions, starts local Node, Playwright, CLI, and
Windows Task Scheduler processes. A Vercel function has neither a durable local
filesystem nor a reliable long-running process, so a direct lift-and-shift would
lose data and could expose application-assistance capabilities.

This repository is therefore Vercel-preview-ready as a protected cloud shell,
not as a cloud scanner. In Vercel, `web/src/proxy.ts` requires credentials on
every request and rejects all file-backed/mutating/worker API routes with
`501 CLOUD_EXECUTION_DISABLED`. `/api/health` and `/api/version` remain safe,
non-mutating deployment checks. The local dashboard is unchanged.

## Preview setup (no production deploy)

1. Create or link a Vercel project with **Root Directory = `web`**. Do not add
   `.vercel/` to source control.
2. Turn on Vercel Deployment Protection for previews and production.
3. Add encrypted Preview and Production environment variables:

   ```text
   CAREER_OPS_WEB_AUTH_USER=<private username>
   CAREER_OPS_WEB_AUTH_PASSWORD=<long random secret>
   ```

   These are server-only. Do not use a `NEXT_PUBLIC_` prefix and do not set a
   user CV, API key, `CAREER_OPS_ROOT`, or local path on Vercel.
4. Before any preview deploy, run from `web/`:

   ```powershell
   npm ci
   npm run typecheck
   npm test
   npm run build
   ```

5. After a preview deployment, verify the authenticated UI, then call
   `/api/health`. Confirm its `runtime` is `vercel` and its `execution` is
   `disabled-pending-worker`.

No `VERCEL_TOKEN`, `VERCEL_ORG_ID`, or `VERCEL_PROJECT_ID` belongs in the repo.
If CI is later used for prebuilt deployments, keep those values only in the CI
secret store.

## Required cloud architecture before execution is enabled

Choose one durable backend boundary before exposing data or any action API:

```text
Browser (protected) -> short Vercel API -> durable database + audit log
                                         -> durable queue -> separate Node worker
                                                         -> ATS/portal providers
```

The worker must run outside a request lifecycle. Vercel Cron may only enqueue
or dispatch short due-job checks; it must not perform a full ATS sweep itself.
The database and queue need atomic job claims so duplicate cron invocations do
not overlap.

The existing scheduler behavior is the acceptance contract for that adapter:

- store browser timezone, start time, and a minimum 15-minute cadence;
- persist queue/runs/history; retry a failed trigger three times, then create
  an in-app failure notification and wait for the next cadence;
- pausing blocks future triggers and cancels queued-but-not-started work while
  a running job finishes; stopping a running job is a separate confirmed action;
- preserve history/logs after a schedule is deleted; record actor, timestamp,
  request ID, and before/after data for every write;
- keep application submission disabled. Any draft/prefill action needs its own
  explicit confirmation/audit policy after authentication is in place.

Use a managed Postgres plus a durable queue/worker service selected by the
account owner. This repository does not create paid resources or assume a
vendor/credential. Once a provider is selected, add a single repository-backed
adapter behind the existing scheduled-jobs store rather than a parallel model.

## Production gate

Do not promote a preview until all of the following are true:

- an account owner selected the persistence + queue/worker provider and created
  its secrets outside Git;
- an authenticated, audited data adapter replaced the Vercel file-backed path;
- the queue semantics above have focused tests, including pause/delete/stop and
  three retries;
- Vercel Deployment Protection is enabled, the Basic credentials are present,
  and no user data or credential is embedded in the build;
- `npm run typecheck`, `npm test`, `npm run build`, and the required repository
  test gate pass; and
- an authenticated preview smoke test proves cloud execution remains disabled
  until the external worker is deliberately enabled.
