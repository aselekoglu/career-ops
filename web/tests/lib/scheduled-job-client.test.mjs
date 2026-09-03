import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cadenceMinimum, createScheduledJobRequest, MIN_SCHEDULE_MINUTES, updateScheduledJobRequest } from "../../src/lib/scheduled-job-client.mjs";
import { runStatusTone } from "../../src/lib/scheduled-run-status.mjs";
import { isSchedulerStatusPayload } from "../../src/lib/scheduled-scheduler-status.mjs";
import { cycleFocusIndex } from "../../src/lib/scheduled-overlay-focus.mjs";
import { scheduledRunnerResourcePath, scheduledStorePath } from "../../src/lib/scheduled-runner-path.mjs";

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

test("scheduled-job client updates by encoded id and preserves payload", async () => {
  let request;
  const result = await updateScheduledJobRequest("job/1", { status: "paused" }, async (...args) => {
    request = args;
    return { ok: true, async json() { return { id: "job/1", status: "paused" }; } };
  });
  assert.deepEqual(result, { id: "job/1", status: "paused" });
  assert.equal(request[0], "/api/scheduled-jobs/job%2F1");
  assert.deepEqual(JSON.parse(request[1].body), { status: "paused" });
});

test("scheduler payload and overlay focus helpers fail closed and wrap", () => {
  assert.equal(isSchedulerStatusPayload({ task: {} }), true);
  assert.equal(isSchedulerStatusPayload({ error: "offline" }), false);
  assert.equal(isSchedulerStatusPayload(null), false);
  assert.equal(cycleFocusIndex(0, 2, true), 1);
  assert.equal(cycleFocusIndex(1, 2, false), 0);
  assert.equal(cycleFocusIndex(0, 0), -1);
});

test("runner and scheduler-status derive the same default and custom lock path", () => {
  const root = "C:/career-ops";
  const defaultStore = scheduledStorePath(root, null);
  assert.equal(scheduledRunnerResourcePath(defaultStore), `${defaultStore}.runner`);
  const customStore = scheduledStorePath(root, "C:/profile/scheduled-jobs.json");
  assert.equal(scheduledRunnerResourcePath(customStore), `${path.resolve("C:/profile/scheduled-jobs.json")}.runner`);
});

test("scheduled-job CRUD uses the shared store resolver", () => {
  const source = fs.readFileSync(new URL("../../src/lib/scheduled-jobs.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ scheduledStorePath \} from "\.\/scheduled-runner-path\.mjs"/);
  assert.match(source, /scheduledStorePath\(careerOpsRoot\(\)\)/);
});
