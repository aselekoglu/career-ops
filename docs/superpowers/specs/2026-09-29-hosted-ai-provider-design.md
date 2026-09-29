# Hosted Gemini Provider for Career Ops

Status: Draft for user review  
Date: 2026-09-29  
Branch: codex/vercel-hobby-fix

## Decision

Enable server-side Gemini API access in the Vercel deployment using the existing GEMINI_API_KEY environment variable. The user confirmed GEMINI_API_KEY is already configured for Preview and Production. OpenAI integration is deferred until Gemini has been validated; this phase does not require OPENAI_API_KEY.

The key must never enter browser storage, API responses, prompts, logs, or the repository.

## Current state

The web app is local-first. /api/assistant, /api/explore/ai, and /api/run resolve a local CLI and start it with child_process.spawn. The /config key mode is marked Coming soon; its key exists only in component state and is not consumed. The cloud proxy currently returns CLOUD_AI_UNAVAILABLE for these actions.

The /api/run path also reads and writes local files, runs Career Ops scripts, and renders PDFs. Neon currently contains an imported document snapshot; it is not a job queue or a transactional write adapter. Adding a Gemini key alone cannot safely turn those operations on.

## Stage 1: hosted Gemini model access

Add a server-only Gemini adapter for read-oriented Assistant and Explore AI requests.

- Read GEMINI_API_KEY only on the server.
- Use the Gemini Interactions API. Keep requests stateless with store=false. Explore AI may use Google Search grounding and returns candidate posting URLs marked unconfirmed.
- Keep the existing Assistant response/action-envelope and Explore offer-stream contracts. In hosted mode, the Assistant may emit only navigate and filterPipeline actions. Worker actions and data mutations (evaluate, research, PDF generation, status/profile/portal writes, remember, and apply actions) stay disabled. Explore AI may show results; adding results to the pipeline stays disabled until Stage 2.
- Read only the specific user context needed for a request from the existing Neon snapshot. Treat retrieved pages and model output as untrusted data. Validate action IDs and arguments in application code; never execute model output as shell commands, SQL, arbitrary routes, or file paths.
- Add an authenticated status endpoint that reveals only whether GEMINI_API_KEY is configured. It must never return the key or its contents.
- Keep the local CLI mode unchanged. In hosted mode, Config should show Gemini readiness and explain that the key is managed in Vercel, not pasted into the browser.
- Bound request size, output tokens, duration, and request count. Do not log prompts, CV contents, the provider key, or generated responses.
- Do not silently route to another provider. Surface missing-key, quota, rate-limit, and provider errors clearly.

Vercel secret:

| Variable | Purpose | Exposure |
| --- | --- | --- |
| GEMINI_API_KEY | Gemini credential, already configured for Preview and Production per user | Server only |

Model ID is non-secret configuration; its default will be verified against current provider documentation during implementation. No key values are copied into code or chat.

Google recommends the Interactions API for new agentic applications; it supports stateless requests and Google Search grounding. References: [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview), [Gemini API reference](https://ai.google.dev/api/interactions-api).

## Stage 2: durable Career Ops jobs

Do not enable evaluation, CV/PDF generation, tracker/profile/portal writes, pipeline additions, or scheduled scan execution in Vercel merely because the Gemini key exists. These operations need durable writes and work that survives a short-lived request.

A separate design is required for a Neon-backed job record, idempotent claims and results, durable artifact storage, a worker runtime, retry/cancellation rules, and the user's existing confirmation gates. The codex/scheduled-scans-pr branch remains out of scope and must not be modified.

## Privacy and cost boundaries

Sending a request to Gemini sends the selected Career Ops context to Google. Requests should include only the CV, application, or pipeline information needed for the specific task. The provider key stays in Vercel's encrypted environment-variable store and is never exposed to the client. Set Gemini-side conversation storage off for each request.

The Gemini API is usage-billed. Stage 1 must cap request size and output tokens, enforce a request limit, and surface provider/quota errors clearly rather than retrying indefinitely.

## Acceptance criteria

1. Missing GEMINI_API_KEY produces a clear status/error without exposing credential values.
2. With the existing Preview key, Assistant streams a response and Explore AI returns sourced candidate URLs without requiring a local CLI.
3. Hosted Assistant actions are limited to navigation and filtering; no worker or data mutation executes from cloud mode.
4. Explore results are viewable while pipeline additions remain disabled until Stage 2.
5. No local CLI/process or file-backed write route is enabled in cloud mode by this change.
6. Automated tests use mocked Gemini clients; build/typecheck pass without the real key.
7. A protected Preview deployment is verified using the existing Preview key before any Production promotion.

## Deferred

OpenAI support is postponed. The existing worker-based evaluation, CV/PDF generation, and data-write actions remain unavailable in the hosted deployment until Stage 2 is designed and implemented.
