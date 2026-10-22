# Vercel deployment boundary

The hosted application combines short authenticated Next.js requests, durable
Neon records and external GitHub Actions workers. Local CLI workflows still
resolve user-layer files through path-resolver.mjs; the hosted application
does not depend on a writable Vercel filesystem.

## Source and deployment

main is the integration and production source. The v1.37.0 reconciliation
was merged in PR #8 at d00068f0b9c8797045327c958236d67263a5e26e.
The existing codex/vercel-hobby-fix ref is retained for configured worker
dispatches and must be fast-forwarded to the reviewed production commit.
Do not develop or merge changes only into that historical branch.

The Vercel project uses web as its root directory. Confirm the deployment's
exact Git SHA, target and alias after a merge. A READY build proves packaging;
authenticated UI, database and worker checks establish runtime behavior.

## Authentication and credentials

Owner routes require the existing server-only CAREER_OPS_WEB_AUTH_USER and
CAREER_OPS_WEB_AUTH_PASSWORD. The proxy and private route handlers enforce
Basic authentication; mutations also reject cross-origin requests. Worker
callbacks use their dedicated shared Bearer secret rather than owner login.
The proxy contains explicit method/path exceptions, not a general API bypass.

Keep deployment credentials, database URLs, provider keys and dispatch tokens
in the platform secret stores. Never prefix them with NEXT_PUBLIC_, commit
them or print decrypted environment values. No new portfolio credential is
required. Preserve the existing private MCP Site's identity and owner access.

## Hosted execution

```text
Authenticated browser / private MCP Site
  -> fixed Next.js API
  -> durable Neon data and run state
  -> GitHub Actions worker
  -> authenticated callback -> private artifact version
```

Hosted scan, evaluation and CV workflows use their existing explicit adapters.
File-backed APIs without a durable hosted implementation remain behind
CLOUD_EXECUTION_DISABLED. Hosted capability responses describe actual
configuration; local readiness is not evidence of hosted readiness.
Do not start long-lived subprocesses or leave model work running after a
Vercel request ends. Logs contain operational IDs and safe errors, never user
source snapshots, private PDFs or credentials.

Portfolio workflow contracts and acceptance criteria are documented in
[the portfolio guide](../web/docs/portfolio-library-hosted.md)
and the portfolio implementation plan. Keep unfinished capabilities disabled
until their workflow and callback code are deployed together.

## Verification and rollout

Before merging, run focused regression tests, the hosted web tests,
typecheck, production build and the applicable repository gate. Verify
authentication, source boundaries, retries and durable worker completion.
Do not change real application state or discard existing user artifacts as a
smoke test; use clearly synthetic fixtures and reversible canaries.

After merging, confirm production's SHA and alias, fast-forward the configured
worker ref, and verify authenticated health and the actual end-to-end action.
Publish private MCP changes separately from their authoritative Site source;
a backend deployment does not update the Site tool registry. Preserve the
previous deployment identity for rollback and report any unverified boundary.
