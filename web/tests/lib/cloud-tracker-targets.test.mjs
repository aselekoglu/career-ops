import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTargetUrlAvailable,
  bindTrackerTarget,
  emptyTrackerTargets,
  parseTrackerTargets,
  readTrackerTargets,
  resolveTrackerTarget,
  serializeTrackerTargets,
  unbindTrackerTarget,
} from "../../src/lib/cloud-tracker-targets.mjs";
import { createHash } from "node:crypto";

const url = "https://jobs.example.org/role?jobId=42";
const target = { applicationNumber: "39", url, company: "Example Corp", role: "Engineer" };

test("missing target document is an empty versioned map and invalid maps fail closed", () => {
  assert.deepEqual(parseTrackerTargets(null), emptyTrackerTargets());
  assert.throws(() => parseTrackerTargets(JSON.stringify({ version: 2, targets: {} })), { message: "TRACKER_TARGETS_INVALID" });
  assert.throws(() => parseTrackerTargets(JSON.stringify({ version: 1, targets: { 39: { url, company: "", role: "Engineer" } } })), { message: "TRACKER_TARGETS_INVALID" });
});

test("target map canonical uniqueness prevents duplicate ownership and rebinding", () => {
  const initial = emptyTrackerTargets();
  const bound = bindTrackerTarget(initial, target);
  assert.equal(bound.targets["39"].url, url);
  assert.throws(() => assertTargetUrlAvailable(bound, "https://jobs.example.org/role?jobId=42&utm_source=board", "40"), { message: "TRACKER_TARGET_URL_CONFLICT" });
  assert.throws(() => bindTrackerTarget(bound, { ...target, applicationNumber: "40" }), { message: "TRACKER_TARGET_URL_CONFLICT" });
  assert.throws(() => bindTrackerTarget(bound, { ...target, url: "https://jobs.example.org/other" }), { message: "TRACKER_TARGET_IMMUTABLE" });
  assert.throws(() => assertTargetUrlAvailable(bound, url, "40", ["https://jobs.example.org/role?jobId=42&utm_medium=email"]), { message: "TRACKER_TARGET_URL_CONFLICT" });
  assert.deepEqual(unbindTrackerTarget(bound, "40"), bound);
  assert.deepEqual(unbindTrackerTarget(bound, "39"), emptyTrackerTargets());
});

test("target map SQL read is byte-bounded and validates its stored hash", async () => {
  let statementSeen = "";
  const content = JSON.stringify(bindTrackerTarget(emptyTrackerTargets(), target));
  const sql = { async query(statement, params) {
    statementSeen = statement;
    assert.equal(params[0], "data/tracker-targets.json");
    assert.equal(params[1], 1_000_000);
    return [{ path: params[0], content, sha256: createHash("sha256").update(content).digest("hex"), content_encoding: "utf8", too_large: false }];
  } };
  const loaded = await readTrackerTargets(sql);
  assert.match(statementSeen, /CASE WHEN octet_length\(content\)<=\$2/);
  assert.deepEqual(loaded.targets, bindTrackerTarget(emptyTrackerTargets(), target));
  assert.equal(JSON.parse(serializeTrackerTargets(loaded.targets)).version, 1);

  const oversized = { async query() { return [{ path: "data/tracker-targets.json", content: null, sha256: "0".repeat(64), content_encoding: "utf8", too_large: true }]; } };
  await assert.rejects(readTrackerTargets(oversized), { message: "TRACKER_TARGETS_TOO_LARGE" });
});

test("bound manual target resolves without a report and legacy report fallback remains exact", () => {
  const targets = bindTrackerTarget(emptyTrackerTargets(), target);
  assert.deepEqual(resolveTrackerTarget({ applicationNumber: "39", application: { n: "39", company: target.company, role: target.role, report: "" }, reportUrl: null, targets }), {
    url, company: "Example Corp", role: "Engineer", source: "binding",
  });
  assert.deepEqual(resolveTrackerTarget({ applicationNumber: "40", application: { n: "40", company: target.company, role: target.role, report: "[040](legacy)" }, reportUrl: "https://jobs.example.org/legacy", targets }), {
    url: "https://jobs.example.org/legacy", company: "Example Corp", role: "Engineer", source: "report",
  });
});

test("binding/report mismatches and reportless unbound rows fail without notes-based guesses", () => {
  const targets = bindTrackerTarget(emptyTrackerTargets(), target);
  assert.throws(() => resolveTrackerTarget({ applicationNumber: "39", application: { n: "39", company: target.company, role: target.role, report: "[039](report)" }, reportUrl: "https://jobs.example.org/different", targets }), { message: "TRACKER_TARGET_REPORT_MISMATCH" });
  assert.throws(() => resolveTrackerTarget({ applicationNumber: "40", application: { n: "40", company: "Other", role: "Analyst", notes: `Added manually from ${url}` }, reportUrl: null, targets }), { message: "TRACKER_TARGET_NOT_FOUND" });
  assert.throws(() => resolveTrackerTarget({ applicationNumber: "39", application: { n: "39", company: target.company, role: "Changed Role", report: "" }, reportUrl: null, targets }), { message: "TRACKER_TARGET_ROW_MISMATCH" });
});
