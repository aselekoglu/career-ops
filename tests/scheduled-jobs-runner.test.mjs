import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  emptyScheduledStore,
  isSafeScheduledId,
  readLockStatus,
  readScheduledStore,
  withResourceLock,
  withScheduledStore,
} from "../web/src/lib/scheduled-jobs-store.mjs";
import {
  buildScanCommand,
  claimDueJob,
  enqueueDueJobs,
  extractRolesFound,
  nextFutureRun,
  recordCompletion,
} from "../scripts/scheduled-jobs-runner.mjs";

test("scheduled-jobs store starts empty and never seeds candidate-specific targeting", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-store-"));
  try {
    const store = readScheduledStore(path.join(temp, "scheduled-jobs.json"));
    assert.deepEqual(store, emptyScheduledStore());
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("scheduled-jobs store serializes concurrent writers without losing jobs", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-lock-"));
  const storePath = path.join(temp, "scheduled-jobs.json");
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        withScheduledStore(storePath, (store) => {
          const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
          const now = new Date().toISOString();
          store.jobs.push({ id, name: String(index), status: "active", engine: "full", filters: {}, timezone: "UTC", startAt: now, every: 1, unit: "hours", createdAt: now, updatedAt: now });
        }),
      ),
    );
    const ids = readScheduledStore(storePath).jobs.map((job) => job.name).sort();
    assert.deepEqual(ids, Array.from({ length: 12 }, (_, index) => String(index)).sort());
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("invalid scheduled-jobs JSON is reported instead of overwritten", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-invalid-"));
  const storePath = path.join(temp, "scheduled-jobs.json");
  try {
    fs.writeFileSync(storePath, "{not-json", "utf8");
    assert.throws(() => readScheduledStore(storePath), /Invalid scheduled-jobs store/);
    assert.equal(fs.readFileSync(storePath, "utf8"), "{not-json");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("overdue schedules queue once and advance directly to the next future run", () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const store = {
    jobs: [{
      id: "job-1",
      status: "active",
      startAt: "2026-08-08T08:00:00.000Z",
      every: 1,
      unit: "hours",
    }],
    runs: [],
    queue: [],
  };

  assert.equal(enqueueDueJobs(store, now), 1);
  assert.equal(store.queue.length, 1);
  assert.equal(store.jobs[0].nextRunAt, "2026-08-08T13:00:00.000Z");
  assert.equal(enqueueDueJobs(store, now), 0);
  assert.equal(store.queue.length, 1);
  assert.equal(nextFutureRun("2026-08-08T08:00:00.000Z", 1, "hours", now), "2026-08-08T13:00:00.000Z");
});

test("scan command honors the selected engine and bounded filters", () => {
  const filters = {
    sinceDays: 5,
    ats: ["lever", "ashby"],
    limitPerAts: 999,
  };
  assert.deepEqual(buildScanCommand({ engine: "portals", filters }), {
    script: "scan.mjs",
    args: ["--since", "5", "--quiet"],
  });
  assert.deepEqual(buildScanCommand({ engine: "full", filters }), {
    script: "scan-ats-full.mjs",
    args: ["--since", "5", "--ats", "lever,ashby", "--limit", "500", "--json"],
  });
});

test("roles-found parsing matches both scanner output formats", () => {
  assert.equal(extractRolesFound("full", JSON.stringify({ postingsKept: 7 })), 7);
  assert.equal(extractRolesFound("portals", "New offers added:      3\n"), 3);
  assert.equal(extractRolesFound("full", "not json"), 0);
});

test("queue claim is durable until completion and stale claims are reclaimable", async () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const store = {
    jobs: [{ id: "11111111-1111-4111-8111-111111111111", status: "active", startAt: "2026-08-08T08:00:00.000Z", every: 1, unit: "hours" }],
    runs: [],
    queue: [{ id: "22222222-2222-4222-8222-222222222222", jobId: "11111111-1111-4111-8111-111111111111", queuedAt: "2026-08-08T08:00:00.000Z" }],
  };
  const first = claimDueJob(store, now);
  assert.equal(first.claimToken.length, 36);
  assert.equal(store.queue.length, 1);
  assert.equal(store.queue[0].claimToken, first.claimToken);
  assert.equal(claimDueJob(store, now + 1_000), null);

  const reclaimed = claimDueJob(store, now + 31_000);
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.claimToken, first.claimToken);
  assert.equal(store.queue.length, 1);

  await recordCompletion("unused", reclaimed, { state: "success", attempt: 1, rolesFound: 2, durationMs: 1, message: "ok" }, store);
  assert.equal(store.queue.length, 0);
  assert.equal(store.runs.length, 1);
});

test("daily recurrence preserves local wall-clock time over DST", () => {
  const beforeSpring = Date.parse("2026-03-07T14:00:00.000Z");
  const spring = nextFutureRun("2026-03-07T09:00:00.000-05:00", 1, "days", beforeSpring, "America/Toronto");
  assert.equal(spring, "2026-03-08T13:00:00.000Z");

  const beforeFall = Date.parse("2026-10-31T13:00:00.000Z");
  const fall = nextFutureRun("2026-10-31T09:00:00.000-04:00", 1, "days", beforeFall, "America/Toronto");
  assert.equal(fall, "2026-11-01T14:00:00.000Z");
});

test("scheduled IDs are UUIDs and lock status distinguishes stale owners", () => {
  assert.equal(isSafeScheduledId("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isSafeScheduledId("../escape"), false);
});

test("persisted malformed identifiers fail closed without touching the file", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-id-"));
  const storePath = path.join(temp, "scheduled-jobs.json");
  try {
    fs.writeFileSync(storePath, JSON.stringify({ jobs: [{ id: "../escape" }], runs: [], queue: [] }), "utf8");
    assert.throws(() => readScheduledStore(storePath), /Invalid scheduled-jobs store/);
    assert.match(fs.readFileSync(storePath, "utf8"), /escape/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a crashed lock owner is recoverable by a real second process", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-crash-lock-"));
  const resource = path.join(temp, "resource");
  try {
    const child = (await import("node:child_process")).spawnSync(process.execPath, ["--input-type=module", "-e", `import { withResourceLock } from ${JSON.stringify(pathToFileURL(path.resolve("web/src/lib/scheduled-jobs-store.mjs")).href)}; await withResourceLock(${JSON.stringify(resource)}, async () => { process.stdout.write("claimed"); process.exit(17); });`], { encoding: "utf8" });
    assert.equal(child.status, 17);
    assert.equal(readLockStatus(resource).stale, true);
    let entered = false;
    await withResourceLock(resource, async () => { entered = true; });
    assert.equal(entered, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
