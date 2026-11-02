import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import test from "node:test";

import { CANONICAL_STATES, PIPELINE_STATUS_TABS, canonStatus } from "../../src/lib/format.ts";
import { computeProgressMetrics } from "../../src/lib/analytics-metrics.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const coreStates = parseYaml(readFileSync(join(REPO_ROOT, "templates", "states.yml"), "utf8")).states;
const canonicalLabels = coreStates.map((state) => state.label);

test("web canonical labels and pipeline tabs mirror templates/states.yml", () => {
  assert.deepEqual(CANONICAL_STATES, canonicalLabels);
  assert.deepEqual(PIPELINE_STATUS_TABS, canonicalLabels.map((label) => label.toUpperCase()));
});

test("Assessment aliases map into the canonical assessment stage", () => {
  assert.equal(canonStatus("Assessment"), "ASSESSMENT");
  assert.equal(canonStatus("screening"), "ASSESSMENT");
  assert.equal(canonStatus("online assessment"), "ASSESSMENT");
  assert.equal(canonStatus("online screening"), "ASSESSMENT");
});

test("browser progress funnel counts Assessment as a response and active application", () => {
  const metrics = computeProgressMetrics([{ status: "Assessment" }], canonStatus);

  assert.deepEqual(metrics.funnel.map((stage) => stage.count), [1, 1, 1, 0, 0]);
  assert.equal(metrics.activeApps, 1);
  assert.equal(metrics.totalOffers, 0);
});

test("browser analytics active and offer counts match the core status rules", () => {
  const applications = ["Evaluated", "Applied", "Responded", "Assessment", "screening", "Interview", "Offer", "Hired", "Rejected", "Discarded", "SKIP"]
    .map((status) => ({ status }));
  const metrics = computeProgressMetrics(applications, canonStatus);

  assert.deepEqual(metrics.funnel.map((stage) => stage.count), [11, 8, 7, 3, 2]);
  assert.equal(metrics.activeApps, 6);
  assert.equal(metrics.totalOffers, 2);
});
