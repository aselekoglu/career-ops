# Task 4: Hosted Explore AI — implementation report

## Outcome

Hosted Explore AI now uses the existing Gemini hosted service with Google Search grounding, preserves the existing plain-text offer event stream, and leaves local CLI discovery on its existing code path. The authenticated known-URL endpoint reads only the Neon scan-history and pipeline snapshots. The returned canonical URL set is used in the browser parser for post-generation dedup and is never included in the Gemini request. Hosted AI results expose no pipeline-add or evaluation actions, including after switching Explore modes.

## TDD evidence

- RED: `node --test tests/lib/hosted-explore.test.mjs` failed on the missing hosted handler assertion before implementation. The parser URL and local dedup checks already passed.
- RED: after adding malformed `https://` as a case, the offer parser accepted it; the test reported two offers instead of one.
- RED: the mocked Neon snapshot test failed on the missing known-URL adapter assertion before that adapter was implemented.
- GREEN: focused Explore coverage passed: 8 tests, 0 failures. It covers strict HTTP(S) offer parsing, the existing unconfirmed offer shape, client dedup from known URLs, hosted read-only behavior, prompt-injection/action-envelope handling, query/history-only model input, known-URL exclusion from Gemini input, and the two-file Neon adapter contract.
- GREEN: focused gate coverage passed: 6 tests, 0 failures. It confirms readiness, method, Gemini availability, and same-origin enforcement.

## Verification

- `node --test tests/lib/hosted-explore.test.mjs tests/lib/cloud-ai-gate.test.mjs` — 14 tests passed across both focused files.
- `npm test` — 205 passed, 0 failed, 0 skipped.
- `npm run typecheck` — passed.
- `npm run build` — passed; `/api/explore/ai` and `/api/explore/ai/known` are included as dynamic routes.
- `git diff --check` and staged diff check — passed.
- Staged diff scan found no common API key or token literals.

No live Gemini, Neon, or Vercel calls were made. The Neon adapter was verified with an injected in-memory document reader.

## Scope and privacy

The hosted model receives the explicit query and validated ordinary user/assistant chat turns only. The server ignores any `knownUrls` request field. The Neon reader is restricted to `data/scan-history.tsv` and `data/pipeline.md`; its output is sent to the browser endpoint and used only for parser dedup. The hosted prompt treats grounded pages as untrusted data and limits the model to Google Search grounding. The parser recognizes offer envelopes only, validates HTTP(S) URLs, and retains `verification: "unconfirmed"`.

The Explore provider detects hosted and ready status from `/api/ai/status`. An unavailable hosted provider disables the search control and returns a clear unavailable state. Hosted `ai-search` results stay read-only even when the user changes the selected Explore mode. The provider also guards `addToPipeline` against those offers. Local CLI behavior continues to include its existing add/evaluate actions.

`cloud-ai-gate.mjs` already enforced per-handler readiness, HTTP method, Gemini readiness, and same-origin checks. Its logic remains unchanged; tests now cover the enabled Explore and known-URL flags. Its outdated file comment was corrected in the follow-up commit.

## Files changed

- `web/src/app/api/explore/ai/route.ts`
- `web/src/app/api/explore/ai/known/route.ts`
- `web/src/lib/ai/hosted-explore-handler.mjs`
- `web/src/lib/ai/hosted-explore-known.mjs`
- `web/src/lib/ai/cloud-ai-gate.mjs` (comment only)
- `web/src/lib/explore-ai.ts`
- `web/src/lib/explore-readonly.mjs`
- `web/src/proxy.ts`
- `web/src/components/explore/ai-search-box.tsx`
- `web/src/components/explore/discovery-card.tsx`
- `web/src/components/explore/explore-provider.tsx`
- `web/src/components/explore/explorer-view.tsx`
- `web/src/components/explore/results-list.tsx`
- `web/tests/lib/cloud-ai-gate.test.mjs`
- `web/tests/lib/hosted-explore.test.mjs`

## Commits

- `a6f6625cb0d34ea52eeb17076b307d0135aa9e6d` — `feat: enable hosted Explore AI with Neon URL dedup`
- `4003638dfe97619d344061303d1266ee3b85380c` — `docs: clarify hosted AI gate readiness`

## Concerns and limits

- Live credentials, Neon connectivity, deployment protection, and deployed route behavior remain unverified by design; this task explicitly prohibited provider calls.
- Direct Node tests importing the TypeScript offer parser emit Node's `MODULE_TYPELESS_PACKAGE_JSON` performance warning. Test outcomes are successful; no package-wide module-type change was made as part of this task.

## Fix round 1 — fail-closed execution status and review follow-ups

### Change

`/api/ai/status` now establishes Explore execution mode only after an OK response with boolean `hosted`, `ready`, and `geminiConfigured` fields. Failed fetches, non-OK responses, invalid JSON, missing/wrongly typed fields, and inconsistent local/hosted values remain `unknown`. AI search cannot start in `unknown`; the UI disables the search button and explains the unavailable status. `addToPipeline`, batch add controls, and card-level add/evaluate controls use the validated mode. Unknown or hosted modes keep AI-origin offers view-only even after switching to Scan. Confirmed local mode preserves the prior CLI request path. Confirmed hosted mode requires both readiness booleans.

The injection test now asserts the full parsed event sequence is exactly narration plus offer, with the action-like envelope retained only as narration. The cloud gate mutation test explicitly covers `/api/explore/add`. Hosted handler validation coverage now checks malformed JSON, invalid history role/content/count, oversized query, and oversized streamed request body; each case asserts the provider is never called.

### RED/GREEN and verification

- RED: before the status-state fix, the restored `ai-search` result test failed because `isHostedExploreReadOnly("unknown", "scan", "ai-search")` returned false. The status-reader availability assertion also failed while its module was absent.
- GREEN: `node --test tests/lib/hosted-explore.test.mjs tests/lib/cloud-ai-gate.test.mjs` — 18 passed, 0 failed, 0 skipped.
- GREEN: `npm test` — 209 passed, 0 failed, 0 skipped.
- GREEN: `npm run typecheck` — passed.
- GREEN: `npm run build` — passed; hosted Explore routes remain included.
- The test suite verifies network rejection, non-OK status, malformed JSON, and malformed boolean status all remain unknown and preserve view-only behavior for restored AI-source offers. Well-formed local, hosted-ready, and hosted-unavailable states are also covered.
- Fix commit: `80a445534a65e3223c84ecab815bc362bca0415b` — `fix: fail closed on unknown Explore execution mode`.

### Files changed in this round

- `web/src/lib/explore-execution-status.mjs` (new validated status reader)
- `web/src/lib/explore-readonly.mjs`
- `web/src/components/explore/explore-provider.tsx`
- `web/src/components/explore/explorer-view.tsx`
- `web/src/components/explore/ai-search-box.tsx`
- `web/src/components/explore/results-list.tsx`
- `web/src/components/explore/discovery-card.tsx`
- `web/tests/lib/hosted-explore.test.mjs`
- `web/tests/lib/cloud-ai-gate.test.mjs`

No live Gemini, Neon, or Vercel calls were made. Server-side proxy policy remains the write boundary.
