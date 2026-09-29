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
- Produces getHostedAiStatus(env = process.env): { geminiConfigured: boolean; openaiConfigured: boolean; ready: boolean; primary: "gemini" | "openai" | null }.
- Produces streamHostedAi(input, dependencies?): AsyncIterable<HostedAiEvent>.
- HostedAiInput is { task: "assistant" | "explore"; system: string; messages: Array<{ role: "user" | "assistant"; content: string }>; webSearch: boolean; signal?: AbortSignal }.
- HostedAiEvent is { type: "text"; text: string } or { type: "source"; url: string; title?: string }.

- [ ] Step 1: Write Node tests for missing keys, Gemini primary, OpenAI-only readiness, one fallback before first text on retryable errors, no fallback on invalid credentials/refusal, no fallback after text, store=false, and request/output bounds.
- [ ] Step 2: Run npm test -- --test-name-pattern="hosted-ai" from web and confirm the new tests fail.
- [ ] Step 3: Add the official Google GenAI and OpenAI SDK dependencies, pin the resolved versions in package-lock.json, and implement the provider adapters with injectable client factories for tests.
- [ ] Step 4: Run npm test -- --test-name-pattern="hosted-ai" from web and confirm all provider-policy tests pass.

### Task 2: Cloud capability status and Config UI

**Files:**
- Create: web/src/app/api/ai/status/route.ts
- Modify: web/src/proxy.ts
- Modify: web/src/components/config-form.tsx
- Create: web/tests/lib/hosted-ai-status.test.mjs

**Interfaces:**
- GET /api/ai/status returns only { hosted: boolean; ready: boolean; geminiConfigured: boolean; openaiConfigured: boolean; primary: "gemini" | "openai" | null }.
- No API endpoint accepts or returns a provider key.
- Cloud POST requests to Assistant and Explore AI pass the existing authentication gate and same-origin check; unrelated cloud write routes remain blocked.

- [ ] Step 1: Write tests that inspect status responses for configured/missing keys and assert the response never contains either secret value.
- [ ] Step 2: Run the focused status test and confirm it fails.
- [ ] Step 3: Add the status route, keep the status booleans server-derived, and update the proxy to allow only the specified hosted-AI endpoints and methods.
- [ ] Step 4: Update Config to show provider readiness and Vercel secret names; keep the local CLI selector for local mode and remove the hosted key paste field.
- [ ] Step 5: Run the focused status tests and confirm they pass.

### Task 3: Hosted Assistant

**Files:**
- Modify: web/src/app/api/assistant/route.ts
- Modify: web/src/components/assistant-console.tsx
- Create: web/src/lib/ai/hosted-assistant-actions.mjs
- Create: web/tests/lib/hosted-assistant-actions.test.mjs

**Interfaces:**
- hostedAssistantPrompt(context) returns the hosted system prompt with only navigate and filterPipeline capabilities.
- filterHostedAssistantText(text) preserves ordinary text and those two action envelopes while removing or replacing all worker/write action envelopes.
- The route calls streamHostedAi({ task: "assistant", system, messages, webSearch: false, signal }) and returns the same text stream consumed by assistant-console.

- [ ] Step 1: Write tests for allowed navigation/filter envelopes and blocked evaluate, research, generatePdf, status/profile/portal writes, remember, and apply envelopes.
- [ ] Step 2: Run the focused action-filter test and confirm it fails.
- [ ] Step 3: Add the hosted prompt/action filter and split the Assistant route between local CLI and authenticated hosted-provider mode.
- [ ] Step 4: Update assistant-console to use /api/ai/status, send hosted requests without cliId, and show a clear read-only message if an unsupported action is requested.
- [ ] Step 5: Run the focused tests and verify local CLI mode still uses its existing request contract.

### Task 4: Hosted Explore AI

**Files:**
- Modify: web/src/app/api/explore/ai/route.ts
- Modify: web/src/app/api/explore/ai/known/route.ts
- Modify: web/src/components/explore/explore-provider.tsx
- Modify: web/src/components/explore/explorer-view.tsx
- Modify: web/src/components/explore/schedule-job-action.tsx
- Modify: web/src/proxy.ts
- Create: web/tests/lib/hosted-explore.test.mjs

**Interfaces:**
- The route calls streamHostedAi({ task: "explore", system, messages, webSearch: true, signal }).
- Provider search sources normalize to HostedAiEvent source records.
- Existing offer events and result schema remain unchanged.
- Hosted AI discovery results are view-only; adding them to the pipeline is disabled.

- [ ] Step 1: Write tests for normalized source URLs, offer event parsing, dedup against the Neon snapshot, and read-only hosted results.
- [ ] Step 2: Run the focused Explore tests and confirm they fail.
- [ ] Step 3: Route hosted Explore AI through Gemini Google Search grounding, falling back to OpenAI Responses web_search only under the Task 1 policy.
- [ ] Step 4: Adapt known-URL lookup to the Neon snapshot, preserve the current offer stream contract, and allow only its authenticated GET plus the provider-backed POST.
- [ ] Step 5: Update Explore UI to allow hosted AI without a local cliId and disable pipeline writes in hosted mode.
- [ ] Step 6: Run the focused Explore tests and confirm they pass.

### Task 5: End-to-end verification and Preview handoff

**Files:**
- No secret values or generated environment files are committed.

- [ ] Step 1: Run npm test from web.
- [ ] Step 2: Run npm run typecheck from web.
- [ ] Step 3: Run npm run build from web.
- [ ] Step 4: Verify missing-key errors and authenticated read-only routes without real provider keys.
- [ ] Step 5: Ask the user to add GEMINI_API_KEY and OPENAI_API_KEY to Vercel Preview Environment Variables; never request values in chat.
- [ ] Step 6: After Preview redeploys, verify Assistant streaming, Explore AI sources, fallback behavior, request limits, and that unsupported writes remain blocked.
- [ ] Step 7: Leave Production promotion until Preview passes. Stage 2 requires its own worker design before file-backed AI actions can be enabled.
