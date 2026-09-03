import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractArrayFromSource } from "../update-system.mjs";

test("updater ships every pure module imported by the scheduled runner", () => {
  const updater = fs.readFileSync(path.resolve("update-system.mjs"), "utf8");
  const manifest = extractArrayFromSource(updater, "SYSTEM_PATHS");
  assert.ok(fs.existsSync(path.resolve("lib/scheduled-runner-path.mjs")));
  for (const dependency of [
    "web/src/lib/scheduled-jobs-store.mjs",
    "web/src/lib/scheduled-cadence.mjs",
    "web/src/lib/scheduled-runner-path.mjs",
    "lib/scheduled-runner-path.mjs",
  ]) {
    assert.ok(manifest.includes(dependency), `${dependency} is missing from SYSTEM_PATHS`);
  }
});

test("core and web scheduled path resolvers remain runtime-parity copies", async () => {
  const core = await import("../lib/scheduled-runner-path.mjs");
  const web = await import("../web/src/lib/scheduled-runner-path.mjs");
  const root = path.resolve("career-ops-parity");
  const relative = "data/custom-scheduled-jobs.json";
  const absolute = path.resolve(root, "profile", "scheduled-jobs.json");
  for (const configured of [undefined, relative, absolute]) {
    const coreStore = core.scheduledStorePath(root, configured);
    const webStore = web.scheduledStorePath(root, configured);
    assert.equal(webStore, coreStore, `store path parity failed for ${configured ?? "default"}`);
    assert.equal(web.scheduledRunnerResourcePath(webStore), core.scheduledRunnerResourcePath(coreStore));
  }
});
