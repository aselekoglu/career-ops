# Hosted AI Providers Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable protected, server-side Gemini-first AI chat and discovery in the Vercel app, with OpenAI fallback and no provider keys in browser code.

**Architecture:** A server-only provider adapter normalizes Gemini Interactions and OpenAI Responses into text/source events. Assistant and Explore AI consume that adapter through their current streaming contracts; hosted actions stay read-only. Evaluation, CV/PDF generation, scheduled jobs, and data mutations remain disabled until a separate durable-worker design is approved.

**Tech Stack:** Next.js 16.3.4, React 19.2.5, Node.js 22+, Neon serverless driver, official Google GenAI and OpenAI Node SDKs, Node built-in test runner.

**Spec:** docs/superpowers/specs/2026-09-29-hosted-ai-provider-design.md

## Global Constraints

- All implementation commits go to codex/vercel-hobby-fix; never write to codex/scheduled-scans-pr.
- Read only GEMINI_API_KEY and OPENAI_API_KEY on the server; never use NEXT_PUBLIC variables, localStorage, response bodies, prompts, or logs for secrets.
- Gemini is primary. Retry once with OpenAI only for retryable provider errors before the first text event; never retry invalid credentials, refusals, or a stream after output begins.
- Set provider-side conversation storage off where supported.
- Hosted Assistant exposes only navigate and filterPipeline actions. Hosted Explore AI displays results but cannot add them to the pipeline.
- Keep /api/run, file writes, CV/PDF generation, evaluation, tracker/profile/portal writes, and scheduled scan execution blocked in cloud mode.
- Vercel Preview and Production require their own secrets. Do not ask the user to paste secret values into chat.

## Review Focus

- Missing keys or invalid credentials must give a clear status without disclosing values; test the missing-key and 401/403 cases in Task 1.
- Gemini outages may fall back once before output; test rate-limit, 5xx, network failure, and no-fallback-after-first-text in Task 1.
- A model may emit an unsupported action envelope; test rejection of every hosted action except navigate and filterPipeline in Task 3.
- A job posting or search result may contain prompt injection; test that discovered content cannot widen tools or actions in Task 4.
- Oversized histories, page context, and queries can consume unbounded tokens; test input and output caps in Task 1.

---

### Task 1: Provider adapter and status contract

**Files:**
- Create: web/src/lib/ai/hosted-ai.mjs
- Create: web/src/lib/ai/hosted-ai.d.ts
- Create: web/tests/lib/hosted-ai.test.mjs
- Modify: web/package.json
- Modify: web/package-lock.json

**Interfaces:**
- getHostedAiStatus(env = process.env) returns { geminiConfigured, openaiConfigured, ready, primary }, where primary is gemini, openai, or null.
- createHostedAiService(options) returns { status(), stream(input) }; options injects environment and mockable provider clients.
- HostedAiInput is { task: assistant | explore; system: string; messages: Array<{ role: user | assistant; content: string }>; webSearch: boolean; signal?: AbortSignal }.
- HostedAiEvent is { type: text; text: string } or { type: source; url: string; title?: string }.

- [ ] Step 1: Write Node tests for missing keys, Gemini primary, OpenAI-only readiness, one fallback before first text on retryable errors, no fallback on invalid credentials/refusal, no fallback after text, store=false, and request/output bounds.
- [ ] Step 2: Run node --test tests/lib/hosted-ai.test.mjs from web and confirm the new tests fail.
- [ ] Step 3: Add the official Google GenAI and OpenAI SDK dependencies, pin their resolved versions in package-lock.json, and implement provider adapters with injectable clients for tests.
- [ ] Step 4: Run node --test tests/lib/hosted-ai.test.mjs from web and confirm all provider-policy tests pass.

### Task 2: Cloud capability status, Config UI, and request gate

**Files:**
- Create: web/src/app/api/ai/status/route.ts
- Create: web/tests/lib/hosted-ai-status.test.mjs
- Modify: web/src/proxy.ts
- Modify: web/src/components/config-form.tsx
- Modify: web/README.md

**Interfaces:**
- GET /api/ai/status returns only { hosted, ready, geminiConfigured, openaiConfigured, primary }. It never returns key values.
- Cloud POST allowlist includes only authenticated same-origin /api/assistant and /api/explore/ai requests. Cloud GET allowlist adds /api/ai/status and /api/explore/ai/known. Other cloud write/worker routes remain blocked.

- [ ] Step 1: Write tests for status output and assert that serialized output cannot contain either configured key.
- [ ] Step 2: Write request-gate tests that reject cross-origin AI POSTs and continue blocking /api/run and data mutation routes.
- [ ] Step 3: Implement the status route and proxy rules while preserving Vercel Deployment Protection and Basic authentication.
- [ ] Step 4: Update hosted Config to show provider readiness and explain that secrets are configured in Vercel; remove any hosted key-paste UI. Preserve local CLI selection.
- [ ] Step 5: Document the required Preview and Production variables in web/README.md without including values.
- [ ] Step 6: Run node --test tests/lib/hosted-ai-status.test.mjs and confirm status and request-gate tests pass.

### Task 3: Hosted Assistant

**Files:**
- Modify: web/src/app/api/assistant/route.ts
- Modify: web/src/components/assistant-console.tsx
- Create: web/src/lib/ai/hosted-assistant-actions.mjs
- Create: web/tests/lib/hosted-assistant-actions.test.mjs

**Interfaces:**
- hostedAssistantPrompt(context) returns the hosted system prompt with only navigate and filterPipeline capabilities.
- isHostedAssistantActionAllowed(actionId) returns true only for navigate and filterPipeline.
- The route calls streamHostedAi({ task: assistant, system, messages, webSearch: false, signal }) and returns the same text stream consumed by assistant-console.

- [ ] Step 1: Write tests for allowed navigation/filter envelopes and blocked evaluate, research, generatePdf, status/profile/portal writes, remember, and apply envelopes.
- [ ] Step 2: Run node --test tests/lib/hosted-assistant-actions.test.mjs and confirm it fails.
- [ ] Step 3: Add the hosted prompt/action gate and split the Assistant route between local CLI and authenticated hosted-provider mode. In cloud mode, build context from the minimal relevant Neon snapshot instead of local filesystem reads.
- [ ] Step 4: Update assistant-console to read /api/ai/status, allow hosted requests without cliId, and show a read-only explanation when an unsupported action is requested.
- [ ] Step 5: Run the focused action tests and npm run typecheck from web; confirm local CLI mode still uses its existing request contract.

### Task 4: Hosted Explore AI

**Files:**
- Modify: web/src/app/api/explore/ai/route.ts
- Modify: web/src/app/api/explore/ai/known/route.ts
- Modify: web/src/components/explore/explore-provider.tsx
- Modify: web/src/components/explore/explorer-view.tsx
- Create: web/tests/lib/hosted-explore.test.mjs

**Interfaces:**
- The route calls streamHostedAi({ task: explore, system, messages, webSearch: true, signal }).
- Provider search sources normalize to HostedAiEvent source records.
- Existing offer events and result schema remain unchanged.
- Hosted AI discovery results are view-only; adding them to the pipeline is disabled.

- [ ] Step 1: Write tests for normalized source URLs, offer event parsing, dedup against the Neon snapshot, and read-only hosted results.
- [ ] Step 2: Run node --test tests/lib/hosted-explore.test.mjs and confirm it fails.
- [ ] Step 3: Route hosted Explore AI through Gemini Google Search grounding and OpenAI Responses web_search, using the Task 1 fallback policy.
- [ ] Step 4: Adapt known-URL lookup to the Neon snapshot and preserve the current offer stream contract.
- [ ] Step 5: Update ExploreProvider to allow hosted AI without a local cliId and disable pipeline writes in hosted mode.
- [ ] Step 6: Add a prompt-injection case proving discovered page text cannot add tools or write actions; run the focused Explore tests and confirm they pass.

### Task 5: Verification and Preview handoff

**Files:**
- No secret values or generated environment files are committed.

- [ ] Step 1: Run npm test from web.
- [ ] Step 2: Run npm run typecheck from web.
- [ ] Step 3: Run npm run build from web.
- [ ] Step 4: Verify missing-key errors and authenticated read-only routes without real provider keys.
- [ ] Step 5: Ask the user to add GEMINI_API_KEY and OPENAI_API_KEY to Vercel Preview Environment Variables; never request values in chat.
- [ ] Step 6: After Preview redeploys, verify Assistant streaming, Explore AI source URLs, fallback behavior, request limits, and that unsupported writes remain blocked.
- [ ] Step 7: Leave Production promotion until Preview passes. Stage 2 requires its own worker design before file-backed AI actions can be enabled.
