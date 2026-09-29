# Hosted AI Providers for Career Ops

Status: Draft for user review  
Date: 2026-09-29  
Branch: codex/vercel-hobby-fix

## Decision requested

Career Ops should support server-side Gemini and OpenAI API keys in its Vercel deployment. Gemini is the primary provider; OpenAI is the secondary provider. Keys belong in Vercel Environment Variables and must never enter browser storage, API responses, prompts, or logs.

This design is split into two stages because model access and execution of Career Ops jobs are different capabilities.

## Current state

The web app is local-first. /api/assistant, /api/explore/ai, and /api/run resolve a local CLI and start it with child_process.spawn. The /config key mode is marked “Coming soon”; its key exists only in component state and is not consumed. The cloud proxy currently returns CLOUD_AI_UNAVAILABLE for these actions.

The /api/run path also reads and writes local files, runs Career Ops scripts, and renders PDFs. Neon currently contains an imported document snapshot; it is not a job queue or a transactional write adapter. Adding provider keys alone cannot safely turn those operations on.

## Stage 1: hosted model access

Add a server-only provider adapter used by the read-oriented Assistant and Explore AI flows.

- Read GEMINI_API_KEY and OPENAI_API_KEY only on the server.
- Use Gemini first. If Gemini fails before any response content is sent because of a retryable transport, rate-limit, or service-availability error, retry once with OpenAI. Do not fall back for invalid credentials, permission errors, or model refusals. Never switch providers after streaming has begun.
- Keep the current assistant response/action-envelope format and Explore offer stream contract. Cloud-side actions remain limited to the existing allowlist and user-confirmation flow; the model cannot invoke shell commands, arbitrary routes, SQL, or file paths.
- Read only the specific user context needed for a request from the existing Neon snapshot. Treat retrieved pages and model output as untrusted data.
- Add an authenticated status endpoint that reveals only whether each provider key is configured. It must never return a key or its contents.
- Keep the local CLI mode unchanged. In hosted mode, Config should show provider readiness and explain that keys are managed in Vercel, not pasted into the browser.
- Bound request size, output tokens, duration, and fallback attempts. Do not log prompts, CV contents, provider keys, or generated responses.
- Disable provider-side conversation storage where supported. Gemini Interactions supports stateless requests with store=false; OpenAI Responses supports store=false.

Vercel secrets:

| Variable | Purpose | Exposure |
| --- | --- | --- |
| GEMINI_API_KEY | Primary Gemini credential | Server only |
| OPENAI_API_KEY | Secondary OpenAI credential | Server only |

Both secrets should be set for Preview and Production after the provider code is ready. Model IDs are non-secret configuration; their defaults will be verified against current provider documentation during implementation.

For current Gemini work, prefer the Interactions API recommended for new agentic applications. Use OpenAI's Responses API for the OpenAI adapter. The server adapter will normalize both providers into the stream contracts already consumed by Career Ops. References: [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview), [Gemini API reference](https://ai.google.dev/api/interactions-api), [OpenAI API quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request).

## Stage 2: durable Career Ops jobs

Do not enable evaluation, CV/PDF generation, tracker/profile/portal writes, or scheduled scan execution in Vercel merely because model keys exist. These operations need durable writes and work that survives a short-lived request.

A separate design is required for a Neon-backed job record, idempotent claims and results, durable artifact storage, a worker runtime, retry/cancellation rules, and the user's existing confirmation gates. The codex/scheduled-scans-pr branch remains out of scope and must not be modified.

## Privacy and cost boundaries

Sending a request to Gemini or OpenAI sends the selected Career Ops context to that provider. Requests should include only the CV, application, or pipeline information needed for the specific task. Provider keys stay in Vercel's encrypted environment-variable store and are never exposed to the client.

The APIs are usage-billed. Stage 1 must cap request size and output tokens and use at most one fallback. It must surface provider configuration and quota errors clearly rather than retrying indefinitely.

## Acceptance criteria

1. A missing provider key produces a clear status/error without exposing credentials.
2. A configured Gemini key serves Assistant and Explore AI from Vercel; OpenAI is used only under the specified fallback conditions.
3. Streaming output remains compatible with the current Assistant and Explore UI.
4. Model-generated action envelopes continue through the existing client-side allowlist and confirmations.
5. No local CLI/process or file-backed write route is enabled in cloud mode by this change.
6. Automated tests use mocked provider clients; build/typecheck pass without real keys.
7. A protected Preview deployment is verified after the user adds Preview secrets. Production secrets are added and promoted only after Preview works.

## Open item for review

Stage 1 is read-oriented model access. Stage 2 is still needed before the existing worker-based evaluation, CV/PDF generation, and data-write actions can run in the hosted deployment.
