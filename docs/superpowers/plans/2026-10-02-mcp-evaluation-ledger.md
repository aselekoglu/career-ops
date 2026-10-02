# Execution ledger — durable MCP evaluation run

| Date (America/Toronto) | Checkpoint |
|---|---|
| 2026-10-02 | Assigned clean worktree verified at `codex/vercel-hobby-fix` / `47da69ae8512dad111257c79cbf42a31a7dbbe87`; repo instructions read. Update check reported 1.26.0 → 1.35.0; branch stayed on production-derived 1.26.0 per root direction. |
| 2026-10-02 | Implemented durable evaluation API/store, authenticated worker, canonical hosted evaluator assets, proxy/health gates, GitHub trigger, and mirrored Sites MCP source. Source CV/profile remain in Neon; report, tracker, and inbox writes are validated and SHA-guarded. |
| 2026-10-02 | First feature checks: focused tests 21/21; `npm run typecheck`, worker syntax, and diff checks passed. Commit `c08293e1321d05121c9a4977cd9dc1a0725003ac` was pushed to `origin/codex/vercel-hobby-fix`; local and remote SHA matched. |
| 2026-10-02 | Production preview exposed Turbopack rejecting `../../../tracker-parse.mjs` outside `web/`. Switched to `./tracker-table.mjs`, its `n` and `raw` row shape, and preloaded aliases from Neon. |
| 2026-10-02 | Corrected the alias document path to `data/tracker-aliases.json`, matching `migrate-to-neon.mjs`'s `TEXT_FILES`. |
| 2026-10-02 | After the import-boundary repair, `node --test tests/lib/cloud-evaluation-runs.test.mjs` passed 9/9 and `npm run build` succeeded with Turbopack; TypeScript and all four evaluation routes passed the build. Root approved the follow-up parser-boundary fix commit/push; no main merge or deployment. |
