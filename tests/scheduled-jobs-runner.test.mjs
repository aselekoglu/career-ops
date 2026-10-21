import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildScanCommand,
  enqueueDueJobs,
  extractRolesFound,
  nextFutureRun,
} from "../scripts/scheduled-jobs-runner.mjs";

// The root suite ships with core-only installs, where web/ is absent. Resolve
// the web-owned store only after checking its path, so the import guard can
// prove that a missing web/ checkout skips these store cases safely.
const scheduledStorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/src/lib/scheduled-jobs-store.mjs");
const hasScheduledStore = fs.existsSync(scheduledStorePath);
const scheduledStore = hasScheduledStore
  ? await import(pathToFileURL(scheduledStorePath).href)
  : null;

test("scheduled-jobs store starts empty and never seeds candidate-specific targeting", { skip: !scheduledStore }, () => {
  const { emptyScheduledStore, readScheduledStore } = scheduledStore;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-store-"));
  try {
    const store = readScheduledStore(path.join(temp, "scheduled-jobs.json"));
    assert.deepEqual(store, emptyScheduledStore());
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("scheduled-jobs store serializes concurrent writers without losing jobs", { skip: !scheduledStore }, async () => {
  const { readScheduledStore, withScheduledStore } = scheduledStore;
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

test("invalid scheduled-jobs JSON is reported instead of overwritten", { skip: !scheduledStore }, () => {
  const { readScheduledStore } = scheduledStore;
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
