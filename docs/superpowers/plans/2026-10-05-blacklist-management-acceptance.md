# Blacklist Management Native MCP Acceptance

**Date:** 2026-10-05  
**Site deployment:** v11 `appgdep_6ac3b5d9608c819198ec0e1938353e30`; source `adc058278be82f8d3a18f2cfe9e494fbd097af2e`; environment set revision 5  
**Career Ops backend:** deployment `dpl_D6LXGpdcaCpNDsi3Gk5gxVieFuZM`; source `1e40a30ed70fdd8521caf5e7d14f8b24704ad68f`  
  
**Scope:** Native Career Ops blacklist MCP tools only. No browser, raw HTTP, SQL, scans, evaluations, applications, or CV/profile operations were used.

## Baseline

Native `career_ops_blacklist_list(limit=5, offset=0)` returned `present=false`, `sha256=null`, and zero entries. No private entries were exposed.

## Canary flow

The only written entry was the explicitly synthetic company canary **Career Ops MCP QA 日本電産 2026-10-05**, scoped to company, dated `2026-10-05`, with a reason stating it was an acceptance canary and not a real employer.

| Check | Result |
|---|---|
| Add with absent-document SHA and operation UUID `c0f6c990-84ca-4ac3-a298-2bdce600b031` | Succeeded; document SHA `5940cb647662106db640a99f82b1273e7cac1dd8f8d5697758bdbaf2808dc5b2` |
| Identical add replay, same UUID and payload | Succeeded as replay (`replayed=true`); same SHA |
| Get using case/punctuation-normalized company variant | Succeeded; entry found |
| Update with operation UUID `ea9502ba-83d7-4ef2-8cb1-0b898d16adbb` | Succeeded; document SHA `58ecd10c8bf40487a8e4972327b09f5c07e42c309314475935418dc1a62928fc` |
| Stale-SHA update with fresh UUID `90341457-0859-4909-9a11-a5eb3d11664a` | Rejected (`isError=true`). The captured output omitted the returned `error_code` value, so the exact `WRITE_CONFLICT` code is unverified. A readback confirmed the current SHA remained unchanged. A retry was then rejected by automatic approval review, which stated the stale-SHA mutation had already been rejected and instructed not to repeat it. No bypass was attempted. |
| Changed payload reusing original add UUID | Rejected with `INVALID_ARGUMENT`; response text identified `IDEMPOTENCY_KEY_CONFLICT` |
| Delete exact canary with current SHA and fresh UUID `e70be5db-4c09-43d3-9a0a-f516a696b012` | Succeeded; resulting document SHA `fa8fe32f9084822f321fdd5fa28af73c9af103fb3dbf7835e6da0896cc4ddb67` |
| Exact get after delete | Entry not found (`INVALID_ARGUMENT`; response text `BLACKLIST_ENTRY_NOT_FOUND`) |
| Final bounded list | `present=true`, zero entries, final SHA above |

The canonical blacklist document remains present and empty after cleanup. It was absent at baseline; this acceptance did not attempt to remove or restore the document.

## Result

Native blacklist add, idempotent replay, normalized lookup, update, changed-payload conflict, exact delete, and cleanup readback were exercised. The stale-SHA mutation was rejected, but its precise conflict code could not be captured before automatic approval review blocked a repeated mutation. No real-company entry remains.

