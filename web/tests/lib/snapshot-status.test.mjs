import test from "node:test";
import assert from "node:assert/strict";
import { mapSnapshotStatus } from "../../src/lib/snapshot-status.mjs";

test("maps every status emitted by the core scanner", () => {
  const expected = {
    reachable: "live",
    empty: "empty",
    slug_gone: "broken",
    network: "broken",
    auth: "broken",
    server: "broken",
    unknown: "broken",
  };

  for (const [input, output] of Object.entries(expected)) {
    assert.equal(mapSnapshotStatus(input), output, input);
  }
});

test("preserves legacy failure and neutral status behavior", () => {
  assert.equal(mapSnapshotStatus("live"), "live");
  assert.equal(mapSnapshotStatus("broken"), "broken");
  assert.equal(mapSnapshotStatus("unreachable"), "broken");
  assert.equal(mapSnapshotStatus("error"), "broken");
  assert.equal(mapSnapshotStatus("disabled"), "skipped");
  assert.equal(mapSnapshotStatus("no_health"), "skipped");
  assert.equal(mapSnapshotStatus(null), "skipped");
  assert.equal(mapSnapshotStatus(undefined), "skipped");
});
