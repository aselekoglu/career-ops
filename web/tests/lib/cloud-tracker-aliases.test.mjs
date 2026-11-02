import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveTrackerAliases } from "../../src/lib/cloud-tracker-aliases.mjs";

test("missing Neon aliases resolve to the generated canonical header aliases", async () => {
  const canonical = JSON.parse(await readFile(new URL("../../../tracker-aliases.json", import.meta.url), "utf8"));
  assert.deepEqual(resolveTrackerAliases(null), canonical);
  assert.deepEqual(resolveTrackerAliases(undefined), canonical);
});

test("a valid stored alias document remains authoritative", () => {
  const stored = { "#": "num", employer: "company", title: "role", score: "score", state: "status" };
  assert.deepEqual(resolveTrackerAliases(JSON.stringify(stored)), stored);
});

test("a malformed stored alias document fails closed", () => {
  assert.throws(() => resolveTrackerAliases("[]"), { message: "TRACKER_ALIASES_INVALID" });
  assert.throws(() => resolveTrackerAliases("{"), { message: "TRACKER_ALIASES_INVALID" });
});
