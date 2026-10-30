# Profile positioning through Career Ops MCP

The profile proposal flow supports `narrative.headline` and `narrative.superpowers` alongside identity and targeting fields. The hosted Config page uses the same source proposal and apply endpoints.

These narrative fields guide how future CVs and application writing frame relevant experience. They are not evidence of skills, technologies, accomplishments, or scope. Generated claims must remain supported by `cv.md`, `article-digest.md`, or another allowed primary source. Adapt relevant ideas to each role; do not repeat the headline mechanically.

## ChatGPT and Codex workflow

1. Read the profile and its current `sha256` with `career_ops_source_get` using `source: "profile"`.
2. Create a proposal with `career_ops_profile_edit_preview`. Include an annotation for each patch field. Use `user_statement` for wording supplied directly by the user, or `primary_source` with the exact current source hash and snippet for a source-backed field.
3. Show the user the proposal returned by `career_ops_source_proposal`, including the exact diff and annotations. Preview writes a proposal record only; it does not change `config/profile.yml`.
4. Apply only after the user approves that exact diff. Call `career_ops_source_apply` with the proposal ID, original profile SHA-256, a stable operation UUID, and `confirm: true`.
5. Re-read the profile with `career_ops_source_get` and confirm the persisted values.

Example preview arguments (replace the placeholders with user-provided wording):

```json
{
  "expectedSha256": "<current-profile-sha256>",
  "operationId": "<stable-uuid-for-this-preview>",
  "patch": {
    "headline": "<user-reviewed headline>",
    "superpowers": ["<strength 1>", "<strength 2>"]
  },
  "sourceAnnotations": {
    "headline": {
      "kind": "user_statement",
      "reference": "Entered and reviewed by the user."
    },
    "superpowers": {
      "kind": "user_statement",
      "reference": "Entered and reviewed by the user."
    }
  }
}
```

The same tools and fields are available in ChatGPT and Codex MCP clients. Invalid types, unsupported fields, missing annotations, stale profile hashes, and malformed YAML return stable error codes. A stale proposal must be previewed again against the newly read profile; never retry it with a guessed hash.

## Hosted Config page

Open **Config → Profile positioning**. The form reads only the canonical profile source, previews the exact before/after values, and keeps Apply disabled for an unchanged proposal. Applying requires a separate click; the page then re-reads the canonical profile. Concurrent edits return a stale-source message and require a fresh reload and preview.
