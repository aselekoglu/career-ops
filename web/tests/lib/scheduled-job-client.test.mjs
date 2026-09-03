import test from "node:test";
import assert from "node:assert/strict";
import { cadenceMinimum, createScheduledJobRequest, MIN_SCHEDULE_MINUTES } from "../../src/lib/scheduled-job-client.mjs";
import { runStatusTone } from "../../src/lib/scheduled-run-status.mjs";

test("scheduled-job client keeps one cadence minimum and preserves payload", async () => {
  assert.equal(cadenceMinimum("minutes"), MIN_SCHEDULE_MINUTES);
  assert.equal(cadenceMinimum("hours"), 1);
  let request;
  const result = await createScheduledJobRequest({ name: "Profile scan", every: 2, unit: "days", filters: { positive: [] } }, async (...args) => {
    request = args;
    return { ok: true, async json() { return { id: "job" }; } };
  });
  assert.deepEqual(result, { id: "job" });
  assert.equal(request[0], "/api/scheduled-jobs");
  assert.deepEqual(JSON.parse(request[1].body), { name: "Profile scan", every: 2, unit: "days", filters: { positive: [] } });
});

test("only failed runs use the failure tone", () => {
  assert.equal(runStatusTone("failed"), "failed");
  for (const state of ["queued", "running", "cancelled", "success"]) assert.notEqual(runStatusTone(state), "failed");
});
