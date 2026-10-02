import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { createCloudTrackerManagement } = await import(new URL("../../src/lib/cloud-tracker-management.mjs", import.meta.url));
const { reserveCareerOpsReportNumber } = await import(new URL("../../src/lib/cloud-report-numbering.mjs", import.meta.url));
const url = "https://jobs.example.test/roles/alpha";
const aliases = JSON.stringify({"#":"num",date:"date",company:"company",via:"via",role:"role",location:"location",score:"score",status:"status",pdf:"pdf",report:"report",notes:"notes"});
const tracker = `# Applications Tracker\n\n| # | Date | Company | Via | Role | Location | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-09-01 | Existing Co | Direct | Engineer | Remote | 4.0/5 | Evaluated | ❌ | [001](../reports/001-existing.md) | Applied 2026-09-15 |\n`;
const pipeline = `# Pipeline\n\n- [ ] ${url} | Example Co | Engineer\n- [ ] https://jobs.example.test/roles/other | Other Co | Analyst\n`;

function fixture({ beforeCommit = null, trackerText = tracker } = {}) {
  const docs = new Map([
    ["data/applications.md", trackerText], ["data/pipeline.md", pipeline], ["data/tracker-aliases.json", aliases],
    ["data/status-log.tsv", "1\t2026-09-01\t-\tEvaluated\tmanual\tImported\n"],
    ["data/follow-ups.md", "# Follow-ups\n\n"], ["config/profile.yml", "followup_cadence:\n  applied_first_days: 10\n"],
  ]);
  const mutations = new Map(); let before = beforeCommit, nextNumber = 1;
  const row = (path, content) => ({ path, content, sha256: createHash("sha256").update(content).digest("hex"), content_encoding: "utf8" });
  const sql = { async query(statement, params = []) {
    if (statement.startsWith("CREATE TABLE")) return [];
    if (statement.startsWith("INSERT INTO career_ops_evaluation_report_counter")) {
      if (!statement.includes("RETURNING last_number AS num")) return [];
      return [{ num: ++nextNumber }];
    }
    if (statement.startsWith("SELECT payload_sha256,result FROM career_ops_tracker_mutations WHERE id=")) {
      const prior = mutations.get(params[0]); return prior ? [{ payload_sha256: prior.hash, result: prior.result }] : [];
    }
    if (statement.startsWith("SELECT path,content,sha256,content_encoding FROM career_ops_documents")) {
      const content = docs.get(params[0]); return content === undefined ? [] : [row(params[0], content)];
    }
    if (statement.startsWith("WITH incoming AS MATERIALIZED")) {
      before?.(docs); before = null;
      const [id, payloadHash, jsonIncoming, jsonResult] = params, prior = mutations.get(id);
      if (prior) return [{ payload_sha256: prior.hash, result: prior.result, applied: false, cas_ok: true, writes_ok: true }];
      const incoming = JSON.parse(jsonIncoming);
      const cas = incoming.every(d => {
        const content = docs.get(d.path); return (content === undefined ? null : row(d.path, content).sha256) === d.expected_sha;
      });
      if (!cas) return [{ payload_sha256: null, result: null, applied: false, cas_ok: false, writes_ok: true }];
      for (const doc of incoming) docs.set(doc.path, doc.content);
      const result = JSON.parse(jsonResult); mutations.set(id, { hash: payloadHash, result });
      return [{ payload_sha256: payloadHash, result, applied: true, cas_ok: true, writes_ok: true }];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  } };
  return { docs, sql, store: createCloudTrackerManagement({ sql, now: () => new Date("2026-10-02T12:00:00.000Z") }) };
}

const operationId = "55555555-5555-4555-8555-555555555555";

test("exact application lookup distinguishes unknown IDs", async () => {
  const { store } = fixture();
  assert.equal((await store.getApplication("1")).company, "Existing Co");
  await assert.rejects(store.getApplication("2"), { message: "APPLICATION_NOT_FOUND" });
});

test("manual tracker add requires canonical explicit status and never invents score or report", async () => {
  const { store, docs } = fixture();
  const base = { operationId, operation: "add", company: "New Co", role: "Data Engineer", url, source: "user supplied", date: "2026-10-01" };
  await assert.rejects(store.mutate("tracker", base), { message: "INVALID_STATUS" });
  const result = await store.mutate("tracker", { ...base, status: "Interview" });
  assert.equal(result.application.n, "2");
  assert.equal(result.application.score, null);
  assert.equal(result.application.report, null);
  assert.match(docs.get("data/applications.md"), /^\| 2 \| 2026-10-01 \| New Co \| user supplied \| Data Engineer \|  \|  \| Interview \|  \|  \| Added manually from /m);
  assert.match(docs.get("data/status-log.tsv"), /2\t2026-10-01\t-\tInterview\tmanual\tManual tracker entry\n$/);
  const replay = await store.mutate("tracker", { ...base, status: "Interview" });
  assert.equal(replay.application.n, "2");
  assert.equal(replay.replayed, true);
  assert.equal((docs.get("data/applications.md").match(/^\| 2 \|/gm) || []).length, 1);
});

test("manual add explicitly marked Applied seeds its follow-up from the supplied date", async () => {
  const { store, docs } = fixture();
  const result = await store.mutate("tracker", { operationId: "88888888-8888-4888-8888-888888888888", operation: "add", company: "New Co", role: "Engineer", url: "https://jobs.example.test/roles/new", source: "user supplied", date: "2026-10-01", status: "Applied" });
  assert.equal(result.application.score, null);
  assert.equal(result.application.report, null);
  assert.match(docs.get("data/follow-ups.md"), /- next #2 2026-10-11 \(set 2026-10-02\)/);
});

test("manual tracker add shares the serialized counter with reserved evaluation report numbers", async () => {
  const { store, sql } = fixture();
  const reservedEvaluationNumber = await reserveCareerOpsReportNumber(sql);
  const result = await store.mutate("tracker", { operationId: "99999999-9999-4999-8999-999999999999", operation: "add", company: "Manual Co", role: "Engineer", url: "https://jobs.example.test/roles/manual", source: "user supplied", status: "Evaluated" });
  assert.equal(reservedEvaluationNumber, "2");
  assert.equal(result.application.n, "3");
});

test("status transition appends the canonical ledger and follow-up pin atomically", async () => {
  const { store, docs } = fixture();
  await store.mutate("tracker", { operationId, operation: "set-status", applicationId: "1", status: "Applied", date: "2026-09-20" });
  assert.match(docs.get("data/applications.md"), /^\| 1 \|.*\| Applied \|/m);
  assert.match(docs.get("data/status-log.tsv"), /1\t2026-09-20\tEvaluated\tApplied\tset-status\t\n$/);
  assert.match(docs.get("data/follow-ups.md"), /- next #1 2026-09-30 \(set 2026-10-02\)/);
});

test("Applied transition uses an existing Applied note date before today's fallback", async () => {
  const { store, docs } = fixture();
  await store.mutate("tracker", { operationId, operation: "set-status", applicationId: "1", status: "Applied" });
  assert.match(docs.get("data/follow-ups.md"), /- next #1 2026-09-25 \(set 2026-10-02\)/);
});

test("Applied transition falls back to today when no explicit or note date exists", async () => {
  const trackerWithoutAppliedDate = tracker.replace("Applied 2026-09-15", "Date not recorded");
  const { store, docs } = fixture({ trackerText: trackerWithoutAppliedDate });
  await store.mutate("tracker", { operationId, operation: "set-status", applicationId: "1", status: "Applied" });
  assert.match(docs.get("data/follow-ups.md"), /- next #1 2026-10-12 \(set 2026-10-02\)/);
});

test("stale SHA conflicts preserve concurrent changes instead of overwriting them", async () => {
  const { store, docs } = fixture({ beforeCommit(current) { current.set("data/applications.md", current.get("data/applications.md") + "<!-- Concurrent update -->\n"); } });
  const beforeTracker = docs.get("data/applications.md");
  await assert.rejects(store.mutate("tracker", { operationId, operation: "update-notes", applicationId: "1", notes: "Edited" }), { message: "WRITE_CONFLICT" });
  assert.equal(docs.get("data/applications.md"), `${beforeTracker}<!-- Concurrent update -->\n`);
  assert.doesNotMatch(docs.get("data/applications.md"), /\| Edited \|/);
});

test("Inbox commands target exact URLs and preserve unrelated lines", async () => {
  const { store, docs } = fixture();
  await assert.rejects(store.mutate("inbox", { operationId, operation: "archive", targetUrl: "https://jobs.example.test/roles/alph" , confirm: true }), { message: "INBOX_URL_NOT_FOUND" });
  await store.mutate("inbox", { operationId, operation: "edit", targetUrl: url, newUrl: "https://jobs.example.test/roles/beta", company: "Updated Co" });
  const changed = docs.get("data/pipeline.md");
  assert.ok(changed.includes("https://jobs.example.test/roles/beta | Updated Co | Engineer"));
  assert.ok(changed.includes("https://jobs.example.test/roles/other | Other Co | Analyst"));
  await assert.rejects(store.mutate("inbox", { operationId: "66666666-6666-4666-8666-666666666666", operation: "delete", targetUrl: "https://jobs.example.test/roles/beta" }), { message: "CONFIRMATION_REQUIRED" });
  await store.mutate("inbox", { operationId: "77777777-7777-4777-8777-777777777777", operation: "archive", targetUrl: "https://jobs.example.test/roles/beta", confirm: true });
  assert.match(docs.get("data/pipeline.md"), /^- \[x\] https:\/\/jobs\.example\.test\/roles\/beta/m);
});

test("delete replay returns its first result after the target row is gone without another write", async () => {
  const { store, docs } = fixture();
  const command = { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operation: "delete", applicationId: "1", confirm: true };
  const first = await store.mutate("tracker", command);
  const afterDelete = [...docs.entries()];
  const replay = await store.mutate("tracker", command);
  assert.equal(first.operation, "delete");
  assert.equal(replay.replayed, true);
  assert.deepEqual([...docs.entries()], afterDelete);
});

test("operation IDs cannot replay across tracker and inbox command kinds", async () => {
  const { store, docs } = fixture();
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await store.mutate("tracker", { operationId: id, operation: "update-notes", applicationId: "1", notes: "Reviewed" });
  const afterTrackerWrite = [...docs.entries()];
  await assert.rejects(store.mutate("inbox", { operationId: id, operation: "delete", targetUrl: url, confirm: true }), { message: "IDEMPOTENCY_KEY_CONFLICT" });
  assert.deepEqual([...docs.entries()], afterTrackerWrite);
});
