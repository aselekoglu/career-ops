# CV artifact authenticated app fallback

The MCP artifact export may include `authenticatedAppPageUrl` as a fallback to the private download resource link. It is built from the fixed canonical API origin and the validated run UUID at `/cv-artifacts/<run-uuid>`. It carries no credentials or query tokens and is not a PDF URL or PDF bytes. The page may require the owner to sign in.

The page fetches metadata for that exact run and offers a user-triggered link only when the run ID matches, status is `completed`, and the stored byte size and SHA-256 are valid. Metadata validation does not verify the downloaded bytes. The fixed same-origin download endpoint validates the PDF when requested.

The live Site source must be reconciled with this fallback before publication. Do not declare issue #22 complete based on synthetic tests or the URL alone: verify the published page on the authenticated host, confirm owner sign-in behavior, and download the exact run to validate the PDF and its metadata binding.
