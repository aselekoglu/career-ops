# Hosted Gemini Provider Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable protected, server-side Gemini chat and AI discovery in the Vercel app without exposing the existing Vercel secret.

**Architecture:** A server-only Gemini adapter normalizes Gemini Interactions into text events. Assistant and Explore AI consume that adapter through their current streaming contracts; hosted actions stay read-only. Evaluation, CV/PDF generation, scheduled jobs, and data mutations remain disabled until a separate durable-worker design is approved. OpenAI integration is deferred.

**Tech Stack:** Next.js 16.3.4, React 19.2.5, Node.js 22+, Neon serverless driver, official Google GenAI Node SDK, Node built-in test runner.

**Spec:** docs/superpowers/specs/2026-09-29-hosted-ai-provider-design.md

## Global Constraints

- All implementation commits go to codex/vercel-hobby-fix; never write to codex/scheduled-scans-pr.
- Read only GEMINI_API_KEY on the server; never use NEXT_PUBLIC variables, localStorage, response bodies, prompts, or logs for secrets.
- Use Gemini Interactions with provider-side conversation storage disabled via store=false.
- Hosted Assistant exposes only navigate and filterPipeline actions. Hosted Explore AI displays results but cannot add them to the pipeline.
- Keep /api/run, file writes, CV/PDF generation, evaluation, tracker/profile/portal writes, and scheduled scan execution blocked in cloud mode.
- Cloud AI routes are default-deny: only GET /api/ai/status is available until a route is implemented with its server-side hosted branch. Explicit Assistant, Explore, and known-URL readiness flags must be enabled in the same task that completes each hosted handler; a configured key alone never opens a local CLI or file-backed handler.
- Cap request bodies at 64 KiB, history at 20 messages, each user message at 8,000 characters, retrieved context at 16,000 characters, Assistant output at 2,048 tokens, and Explore output at 4,096 tokens. Provider timeout is 60 seconds; no automatic provider fallback is configured.
- Vercel Preview already has GEMINI_API_KEY per user. Verify the configured status without reading or printing its value.

## Review Focus

- Missing keys must give a clear status without disclosing values; test the missing-key case in Task 1.
- Quota, auth, rate-limit, and provider errors must surface clearly without an unrequested OpenAI retry; test in Task 1.
- A model may emit an unsupported action envelope; test rejection of every hosted action except navigate and filterPipeline in Task 3.
- A job posting or search result may contain prompt injection; test that discovered content cannot widen tools or actions in Task 4.
- Oversized histories, page context, and queries can consume unbounded tokens; test input and output caps in Task 1.

---

### Task 1: Gemini provider adapter and status contract

**Files:**
- Create: web/src/lib/ai/hosted-ai.mjs
- Create: web/src/lib/ai/hosted-ai.d.ts
- Create: web/tests/lib/hosted-ai.test.mjs
- Modify: web/package.json
- Modify: web/package-lock.json

**Interfaces:**
- HostedAiStatus is { geminiConfigured: boolean; ready: boolean }.
- HostedAiInput is { task: "assistant" | "explore"; system: string; messages: Array<{ role: "user" | "assistant"; content: string }>; webSearch: boolean; signal?: AbortSignal }.
- HostedAiEvent is { type: "text"; text: string }.
- HostedAiProvider is { stream(input: HostedAiInput): AsyncIterable<HostedAiEvent> }.
- createHostedAiService(options?) returns { status(): HostedAiStatus; stream(input: HostedAiInput): AsyncGenerator<HostedAiEvent> }. Options are { env?: NodeJS.ProcessEnv; gemini?: HostedAiProvider; timeoutMs?: number }; tests inject a fake Gemini provider.

- [ ] Step 1: Write Node tests for missing key, configured status, Gemini stream events, store=false, Google Search enabled only for Explore, request/output bounds, timeout, and clear auth/quota errors.
- [ ] Step 2: Run node --test tests/lib/hosted-ai.test.mjs from web and confirm the new tests fail.
- [ ] Step 3: Add the official Google GenAI SDK dependency, pin its resolved version in package-lock.json, and implement the adapter with an injectable client/provider for tests.
- [ ] Step 4: Run node --test tests/lib/hosted-ai.test.mjs from web and confirm all provider-policy tests pass.

### Task 2: Cloud capability status, Config UI, and request gate

**Files:**
- Create: web/src/app/api/ai/status/route.ts
- Create: web/src/lib/ai/cloud-ai-gate.mjs
- Create: web/tests/lib/cloud-ai-gate.test.mjs
- Modify: web/src/proxy.ts
- Modify: web/src/components/config-form.tsx
- Modify: web/README.md

**Interfaces:**
- GET /api/ai/status returns only { hosted, ready, geminiConfigured }. It never returns the key value.
- toPublicHostedAiStatus(status, hosted) returns only the public fields above.
- isAllowedCloudAiRequest(request, status, handlerReadiness) returns { allowed: boolean; reason?: string }. It allows GET /api/ai/status by default. GET /api/explore/ai/known requires handlerReadiness.exploreKnown; Assistant/Explore POSTs require the matching handlerReadiness flag, configured Gemini, and strict same-origin Origin + Host + Sec-Fetch-Site checks.
- Basic authentication and Vercel Deployment Protection remain enforced before the cloud AI gate.
- Initialize handlerReadiness as { assistant: false, explore: false, exploreKnown: false }. Do not enable a flag until the matching hosted route implementation is present.

- [ ] Step 1: Write Node tests for public status shaping, asserting serialized output never contains the configured key value.
- [ ] Step 2: Write gate tests for key readiness, same-origin POSTs, cross-origin POST rejection, read-only status/known GETs, and denial of /api/run and data mutation routes.
- [ ] Step 3: Run node --test tests/lib/cloud-ai-gate.test.mjs from web and confirm the new tests fail.
- [ ] Step 4: Implement the gate helper and status route; update the proxy to use the helper without weakening Basic auth or Deployment Protection.
- [ ] Step 5: Update hosted Config to show Gemini readiness and explain that the key is configured in Vercel; remove any hosted key-paste UI. Preserve local CLI selection.
- [ ] Step 6: Document the required Preview and Production variable in web/README.md without including values.
- [ ] Step 7: Run the focused gate tests and confirm they pass.

### Task 3: Hosted Assistant

**Files:**
- Modify: web/src/app/api/assistant/route.ts
- Modify: web/src/components/assistant-console.tsx
- Modify: web/src/lib/ai/cloud-ai-gate.mjs
- Modify: web/src/proxy.ts
- Modify: web/tests/lib/cloud-ai-gate.test.mjs
- Create: web/src/lib/ai/hosted-assistant-actions.mjs
- Create: web/tests/lib/hosted-assistant-actions.test.mjs

**Interfaces:**
- hostedAssistantPrompt(context) returns the hosted system prompt with only navigate and filterPipeline capabilities.
- isHostedAssistantActionAllowed(actionId) returns true only for navigate and filterPipeline.
- The route calls streamHostedAi({ task: "assistant", system, messages, webSearch: false, signal }) and returns the same text stream consumed by assistant-console.

- [ ] Step 1: Write tests for allowed navigation/filter envelopes and blocked evaluate, research, generatePdf, status/profile/portal writes, remember, and apply envelopes.
- [ ] Step 2: Run node --test tests/lib/hosted-assistant-actions.test.mjs and confirm it fails.
- [ ] Step 3: Add the hosted prompt/action gate and split the Assistant route between local CLI and authenticated hosted-provider mode. In cloud mode, build context from the minimal relevant Neon snapshot instead of local filesystem reads.
- [ ] Step 4: Update assistant-console to read /api/ai/status, allow hosted requests without cliId, and show a read-only explanation when an unsupported action is requested.
- [ ] Step 5: Run the focused action tests and npm run typecheck from web; confirm local CLI mode still uses its existing request contract.
- [ ] Step 6: Only after the hosted cloud branch is verified, set handlerReadiness.assistant=true in the proxy; keep Explore and known-URL false. Test the gate and verify cloud requests never call resolveCli or spawn.

### Task 4: Hosted Explore AI

**Files:**
- Modify: web/src/app/api/explore/ai/route.ts
- Modify: web/src/app/api/explore/ai/known/route.ts
- Modify: web/src/components/explore/explore-provider.tsx
- Modify: web/src/components/explore/explorer-view.tsx
- Modify: web/src/lib/ai/cloud-ai-gate.mjs
- Modify: web/src/proxy.ts
- Modify: web/tests/lib/cloud-ai-gate.test.mjs
- Create: web/tests/lib/hosted-explore.test.mjs

**Interfaces:**
- The route calls streamHostedAi({ task: "explore", system, messages, webSearch: true, signal }).
- Existing offer events and result schema remain unchanged; validated source URLs stay in DiscoveredOffer.url and retain the unconfirmed badge.
- Hosted AI discovery results are view-only; adding them to the pipeline is disabled.

- [ ] Step 1: Write tests for valid offer URL parsing, offer event parsing, dedup against the Neon snapshot, and read-only hosted results.
- [ ] Step 2: Run node --test tests/lib/hosted-explore.test.mjs and confirm it fails.
- [ ] Step 3: Route hosted Explore AI through Gemini Google Search grounding.
- [ ] Step 4: Adapt known-URL lookup to the Neon snapshot and preserve the current offer stream contract.
- [ ] Step 5: Update ExploreProvider to allow hosted AI without a local cliId and disable pipeline writes in hosted mode.
- [ ] Step 6: Add a prompt-injection case proving discovered page text cannot add tools or write actions; run the focused Explore tests and confirm they pass.
- [ ] Step 7: Only after the hosted Explore POST and Neon-backed known-URL GET are verified, set handlerReadiness.explore=true and handlerReadiness.exploreKnown=true. Keep scheduler, /api/run, writes, and all other capabilities blocked.

### Task 5: Verification and Preview handoff

**Files:**
- No secret values or generated environment files are committed.

- [ ] Step 1: Run npm test from web.
- [ ] Step 2: Run npm run typecheck from web.
- [ ] Step 3: Run npm run build from web.
- [ ] Step 4: Verify missing-key errors and authenticated read-only routes without real provider keys.
- [ ] Step 5: Verify the existing GEMINI_API_KEY status on Vercel Preview without reading or printing its value.
- [ ] Step 6: After Preview redeploys, verify Assistant streaming, Explore AI source URLs, request limits, and that unsupported writes remain blocked.
- [ ] Step 7: Leave Production promotion until Preview passes. Stage 2 requires its own worker design before file-backed AI actions can be enabled.
