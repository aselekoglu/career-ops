# Next.js security patch

## Finding

`next@16.3.4` is inside the affected range `>=16.2.0 <16.3.6` for [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), “Next.js: Remote Code Execution in next/og ImageResponse.” The advisory describes the Node.js `ImageResponse` path when attacker-controlled values reach SVG content, attributes, or styles; it says Edge `ImageResponse` and applications without that untrusted interpolation are unaffected. The current `web/src` tree has no `next/og` or `ImageResponse` usage, so no application-level vulnerable route was found. This is a scope-specific source check, not a general security conclusion.

## Change

Updated the exact direct `next` dependency from 16.3.4 to the requested patched 16.3.8. The lockfile updates only `next`, its exact `@next/env` dependency, and matching platform-specific `@next/swc-*` optional packages to 16.3.8. React, `eslint-config-next` (not a declared direct dependency), YAML, and unrelated packages remain unchanged.

## Verification

- `npm.cmd ls next @next/env --depth=1`: confirms `next@16.3.8` and `@next/env@16.3.8`.
- Targeted `npm.cmd audit --json` metadata query: `next` is no longer listed as vulnerable. No audit fix or unrelated dependency upgrade was run.
- One `npm.cmd run build` was started. Captured output confirmed “Compiled successfully” and reached the TypeScript phase; final console/exit summary was not retained by the command wrapper. Fresh `.next/BUILD_ID`, `routes-manifest.json`, `prerender-manifest.json`, and `server/app-paths-manifest.json` were written at 2026-10-05 12:13:45–12:13:52, and no `next build` process remains. Treat the build artifacts as evidence that generation completed, while noting the direct shell exit status was not captured.
- No application source, auth/proxy code, portal management files, or Site bridge files were changed.
