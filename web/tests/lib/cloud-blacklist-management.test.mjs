import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCloudBlacklistManagement, handleCloudBlacklist } from "../../src/lib/cloud-blacklist-management.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const original = "# Do not apply\nKeep this note.\n\n| Company | Since | Scope | Reason |\n|---------|-------|-------|--------|\n| Legacy GmbH | 2024-01-01 | domain | old reason |\n\nKeep this tail.\n| Other | unrelated | table | preserve |\n| X | Y | Z | W |\n";

function fixture(initial = original) {
  let doc = initial == null ? null : { path: "data/blacklist.md", content: initial, sha256: digest(initial), content_encoding: "utf8" };
  const mutations = new Map();
  let failWrite = false;
  const calls = [];
  const sql = { async query(statement, params = []) {
    calls.push({ statement, params });
    if (statement.startsWith("CREATE TABLE")) return [];
    if (statement.startsWith("SELECT path,CASE")) return doc ? [{ ...doc, too_large: false }] : [];
    if (statement.startsWith("SELECT payload_sha256,result")) {
      const prior = mutations.get(params[0]); return prior ? [{ payload_sha256: prior.hash, result: prior.result }] : [];
    }
    if (statement.includes("WITH gate AS MATERIALIZED")) {
      const [operationId, hash, path, content, resultJson, newSha, expected] = params;
      const prior = mutations.get(operationId);
      if (prior) return [{ stored_hash: prior.hash, stored_result: prior.result, applied: false, written: 0, gate_ok: true, write_ok: true }];
      if ((doc?.sha256 ?? null) !== expected) return [{ stored_hash: null, applied: false, written: 0, gate_ok: false, write_ok: true }];
      mutations.set(operationId, { hash, result: JSON.parse(resultJson) });
      if (failWrite) { mutations.delete(operationId); throw new Error("division by zero"); }
      doc = { path, content, sha256: newSha, content_encoding: "utf8" };
      return [{ stored_hash: hash, stored_result: JSON.parse(resultJson), applied: true, written: "1", gate_ok: true, write_ok: true }];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  } };
  return { store: createCloudBlacklistManagement({ sql }), calls, get doc() { return doc; }, mutations, set failWrite(value) { failWrite = value; } };
}
const url = (path, query = "") => new URL(`https://example.test${path}${query}`);
const command = (operation, expectedSha256, fields = {}) => ({ operationId: id(1), operation, expectedSha256, confirm: true, ...fields });

test("absent reads stay empty and bounded list reads only the blacklist document", async () => {
  const f = fixture(null);
  assert.deepEqual(await f.store.list(url("/api/blacklist")), { present: false, sha256: null, entries: [], pagination: { limit: 25, offset: 0, nextOffset: null } });
  assert.equal(f.doc, null);
  assert.deepEqual(f.calls.map(x => x.params[0]), ["data/blacklist.md"]);
  const existing = fixture("| Company | Since | Scope | Reason |\n|---|---|---|---|\n" + Array.from({ length: 4 }, (_, i) => `| Company ${i} | | company | r |`).join("\n"));
  const page = await existing.store.list(url("/api/blacklist", "?limit=2&offset=1"));
  assert.equal(page.entries.length, 2); assert.equal(page.pagination.nextOffset, 3);
  await assert.rejects(existing.store.list(url("/api/blacklist", "?limit=101")), { message: "INVALID_LIMIT" });
});

test("lookup preserves legacy domain metadata and stops before a later table", async () => {
  const f = fixture();
  assert.deepEqual((await f.store.get(url("/api/blacklist/entry", "?company=Legacy%20GmbH&scope=domain"))).entry, { company: "Legacy GmbH", since: "2024-01-01", scope: "domain", reason: "old reason" });
  assert.equal((await f.store.list(url("/api/blacklist"))).entries.length, 1);
  await assert.rejects(f.store.get(url("/api/blacklist/entry", "?company=Missing&scope=company")), { message: "BLACKLIST_ENTRY_NOT_FOUND" });
});

test("rejects a blacklist row with extra columns instead of silently dropping user data", async () => {
  const malformed = fixture("| Company | Since | Scope | Reason |\n|---|---|---|---|\n| A Corp | | company | reason | extra |");
  await assert.rejects(malformed.store.list(url("/api/blacklist")), { message: "BLACKLIST_FORMAT_INVALID" });
});

test("rejects a canonical-looking header with extra columns without writing", async () => {
  const malformed = fixture("| Company | Since | Scope | Reason | Extra |\n|---|---|---|---|---|\n| A Corp | | company | reason | keep |");
  const originalSha = malformed.doc.sha256;
  await assert.rejects(malformed.store.list(url("/api/blacklist")), { message: "BLACKLIST_FORMAT_INVALID" });
  await assert.rejects(malformed.store.mutate(command("add", originalSha, { entry: { company: "B Corp", scope: "company" } })), { message: "BLACKLIST_FORMAT_INVALID" });
  assert.equal(malformed.doc.sha256, originalSha);
  assert.equal(malformed.mutations.size, 0);
});

test("company-only add/update/delete preserve surrounding prose and reject bad commands", async () => {
  const opening = "# Do not apply\nKeep this note.\n\nKeep this tail.\n";
  const f = fixture(opening);
  const initialSha = f.doc.sha256;
  await assert.rejects(f.store.mutate(command("add", initialSha, { entry: { company: "A", scope: "domain" } })), { message: "BLACKLIST_INVALID_SCOPE" });
  await assert.rejects(f.store.mutate({ ...command("add", initialSha, { entry: { company: "A", scope: "company" } }), confirm: false }), { message: "BLACKLIST_CONFIRMATION_REQUIRED" });
  let result = await f.store.mutate(command("add", initialSha, { entry: { company: "Café Société", since: "2026-10-05", scope: "company", reason: "review" } }));
  assert.equal(result.replayed, false); assert.equal(f.doc.sha256, digest(f.doc.content));
  const before = f.doc.sha256;
  await assert.rejects(f.store.mutate({ ...command("add", before, { entry: { company: "Cafe\u0301 Socie\u0301te\u0301", scope: "company" } }), operationId: id(6) }), { message: "BLACKLIST_DUPLICATE_ENTRY" });
  result = await f.store.mutate({ ...command("update", before, { selector: { company: "Café Société", scope: "company" }, entry: { company: "Café Société", scope: "company", reason: "new" } }), operationId: id(2) });
  assert.equal(result.entry.reason, "new");
  assert.match(f.doc.content, /# Do not apply[\s\S]*Keep this note[\s\S]*Keep this tail/);
  const sha = f.doc.sha256;
  result = await f.store.mutate({ ...command("delete", sha, { selector: { company: "Café Société", scope: "company" } }), operationId: id(3) });
  assert.equal(result.entry, null);
});

test("replay, payload conflict, stale SHA and failed write race keep idempotency sound", async () => {
  const f = fixture(null);
  const first = command("add", null, { entry: { company: "A Corp", scope: "company" } });
  const committed = await f.store.mutate(first);
  assert.equal((await f.store.mutate(first)).replayed, true);
  const reordered = { confirm: true, expectedSha256: null, operation: "add", operationId: id(1), entry: { scope: "company", company: "A Corp" } };
  assert.equal((await f.store.mutate(reordered)).replayed, true, "key order does not change the idempotency fingerprint");
  await assert.rejects(f.store.mutate({ ...first, entry: { company: "B Corp", scope: "company" } }), { message: "IDEMPOTENCY_KEY_CONFLICT" });
  await assert.rejects(f.store.mutate({ ...command("add", null, { entry: { company: "C Corp", scope: "company" } }), operationId: id(4) }), { message: "WRITE_CONFLICT" });
  assert.equal(f.doc.sha256, committed.sha256);
  f.failWrite = true;
  await assert.rejects(f.store.mutate({ ...command("add", f.doc.sha256, { entry: { company: "D Corp", scope: "company" } }), operationId: id(5) }), { message: "WRITE_CONFLICT" });
  assert.equal(f.mutations.has(id(5)), false, "assertion failure rolls back its marker");
});

test("HTTP command rejects non-JSON before SQL or mutation work", async () => {
  const response = await handleCloudBlacklist(new Request("https://example.test/api/blacklist/commands", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), "mutate");
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { code: "JSON_REQUIRED" });
});
