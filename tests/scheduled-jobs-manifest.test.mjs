import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractArrayFromSource } from "../update-system.mjs";

test("updater ships every pure web module imported by the scheduled runner", () => {
  const updater = fs.readFileSync(path.resolve("update-system.mjs"), "utf8");
  const manifest = extractArrayFromSource(updater, "SYSTEM_PATHS");
  // The local runner intentionally reuses these side-effect-free web modules;
  // shipping them keeps scheduled scans working after a system update.
  for (const dependency of [
    "web/src/lib/scheduled-jobs-store.mjs",
    "web/src/lib/scheduled-cadence.mjs",
    "web/src/lib/scheduled-runner-path.mjs",
  ]) {
    assert.ok(manifest.includes(dependency), `${dependency} is missing from SYSTEM_PATHS`);
  }
});
