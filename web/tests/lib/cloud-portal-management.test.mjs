import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCloudPortalManagement, handleCloudPortal } from "../../src/lib/cloud-portal-management.mjs";

const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const baseYaml = `# keep root note
title_filter:
  positive: ["AI", "Engineer"] # preserve inline comment
tracked_companies:
  - name: Greenhouse Org
    careers_url: https://job-boards.greenhouse.io/acme
    api: https://boards-api.greenhouse.io/v1/boards/acme/jobs?access_token=redact-this
    enabled: true
    privateToken: "never return this"
    provider_options:
      nested: retained
job_boards:
  - name: SolidJobs IT
    careers_url: https://solid.jobs/public-api/offers/it?campaign=career-ops
    provider: solidjobs
    enabled: true
`;

function fixture(initial = baseYaml) {
  let document = initial == null ? null : { path: "portals.yml", content: initial, sha256: hash(initial), content_encoding: "utf8" };
  const mutations = new Map(), calls = [];
  let failWrite = false;
  const sql = { async query(statement, params = []) {
    calls.push({ statement, params });
    if (statement.startsWith("CREATE TABLE")) return [];
    if (statement.startsWith("SELECT path,CASE")) return document ? [{ ...document, too_large: false }] : [];
    if (statement.startsWith("SELECT payload_sha256,result")) {
      const old = mutations.get(params[0]); return old ? [{ payload_sha256: old.hash, result: old.result }] : [];
    }
    if (statement.includes("WITH gate AS MATERIALIZED")) {
      const [opId, payloadHash, path, content, resultJson, nextHash, expectedSha] = params;
      const old = mutations.get(opId);
      if (old) return [{ stored_hash: old.hash, stored_result: old.result, applied: false, written: 0, gate_ok: true, write_ok: true }];
      if ((document?.sha256 ?? null) !== expectedSha) return [{ stored_hash: null, applied: false, written: 0, gate_ok: false, write_ok: true }];
      if (failWrite) throw new Error("division by zero");
      mutations.set(opId, { hash: payloadHash, result: JSON.parse(resultJson) });
      document = { path, content, sha256: nextHash, content_encoding: "utf8" };
      return [{ stored_hash: payloadHash, stored_result: JSON.parse(resultJson), applied: true, written: "1", gate_ok: true, write_ok: true }];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  } };
  return { store: createCloudPortalManagement({ sql }), calls, mutations, get document() { return document; }, set failWrite(value) { failWrite = value; } };
}

const url = (path, query = "") => new URL(`https://example.test${path}${query}`);
const command = (operation, collection, expectedSha256, fields = {}) => ({ operationId: id(1), operation, collection, expectedSha256, confirm: true, ...fields });

test("bounded list/detail keep the legacy root endpoint separate and redact opaque config", async () => {
  const f = fixture();
  const page = await f.store.list(url("/api/portals/entries", "?collection=tracked_companies&limit=1&offset=0"));
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].scanSupported, false, "credential-bearing URL configuration is not represented as safely configured");
  assert.equal(page.entries[0].enabled, true);
  assert.equal(JSON.stringify(page).includes("never return this"), false);
  assert.equal(JSON.stringify(page).includes("redact-this"), false);
  assert.equal(Object.hasOwn(page.entries[0], "api"), false);
  assert.deepEqual(page.entries[0].redactedFields, ["api"]);
  assert.equal(page.entries[0].hasOpaqueSettings, true);
  assert.equal(Object.hasOwn(page.entries[0], "provider_options"), false);
  assert.equal(Object.hasOwn(page.entries[0], "parser"), false);
  assert.equal((await f.store.get(url("/api/portals/entry", "?collection=job_boards&name=SolidJobs%20IT"))).entry.provider, "solidjobs");
  await assert.rejects(f.store.list(url("/api/portals/entries", "?collection=search_queries")), { message: "INVALID_COLLECTION" });
  await assert.rejects(f.store.list(url("/api/portals/entries", "?collection=job_boards&limit=101")), { message: "INVALID_LIMIT" });
  assert.equal(f.calls.some(call => call.params.includes("/api/portals")), false);
});

test("absent portal document reads empty without creating it", async () => {
  const f = fixture(null);
  assert.deepEqual(await f.store.list(url("/api/portals/entries", "?collection=job_boards")), { present: false, sha256: null, entries: [], pagination: { limit: 25, offset: 0, nextOffset: null } });
  assert.equal(f.document, null);
});

test("add/update/delete preserve YAML comments, filters, unknown fields, and nested provider data", async () => {
  const f = fixture();
  const before = f.document.sha256;
  const add = command("add", "tracked_companies", before, { entry: { name: "PolyAI", careers_url: "https://job-boards.eu.greenhouse.io/polyai", enabled: true } });
  const added = await f.store.mutate(add);
  assert.equal(added.entry.scanSupported, true);
  assert.match(f.document.content, /# keep root note/);
  assert.match(f.document.content, /# preserve inline comment/);
  assert.match(f.document.content, /privateToken: "never return this"/);
  assert.match(f.document.content, /provider_options:\n\s+nested: retained/);
  const nextSha = f.document.sha256;
  const updated = await f.store.mutate({ ...command("update", "tracked_companies", nextSha, { selector: { name: "PolyAI" }, entry: { notes: "regional board" } }), operationId: id(2) });
  assert.equal(updated.entry.notes, "regional board");
  assert.equal(updated.entry.name, "PolyAI");
  await assert.rejects(f.store.mutate({ ...command("update", f.document.sha256 ? "tracked_companies" : "", f.document.sha256, { selector: { name: "PolyAI" }, entry: { name: "Renamed" } }), operationId: id(3) }), { message: "PORTAL_IDENTITY_IMMUTABLE" });
  const deleted = await f.store.mutate({ ...command("delete", "tracked_companies", f.document.sha256, { selector: { name: "PolyAI" } }), operationId: id(4) });
  assert.equal(deleted.entry, null);
  assert.match(f.document.content, /title_filter:/);
  assert.match(f.document.content, /privateToken: "never return this"/);
});

test("disabled unsupported canaries are honest, websearch is handoff-only, and unsafe enabled providers fail", async () => {
  const f = fixture(null);
  const disabled = await f.store.mutate(command("add", "job_boards", null, { entry: { name: "Future Board", provider: "future-plugin", enabled: false } }));
  assert.equal(disabled.entry.scanSupported, false);
  assert.equal(disabled.entry.enabled, false);
  const handoff = await f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Search Candidate", scan_method: "websearch", scan_query: "site:jobs.example.com engineer", enabled: false } }), operationId: id(2) });
  assert.equal(handoff.entry.handoffRequired, true);
  assert.equal(handoff.entry.scanSupported, false);
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Handoff ATS", careers_url: "https://job-boards.greenhouse.io/handoff", scan_method: "websearch", scan_query: "site:jobs.example.com engineer", enabled: true } }), operationId: id(9) }), { message: "PORTAL_UNSUPPORTED_ENABLED_PROVIDER" });
  await assert.rejects(f.store.mutate({ ...command("update", "job_boards", f.document.sha256, { selector: { name: "Future Board" }, entry: { enabled: true } }), operationId: id(8) }), { message: "PORTAL_UNSUPPORTED_ENABLED_PROVIDER" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Unsupported", provider: "future-plugin", enabled: true } }), operationId: id(3) }), { message: "PORTAL_UNSUPPORTED_ENABLED_PROVIDER" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Local", provider: "local-parser", enabled: false } }), operationId: id(4) }), { message: "PORTAL_INVALID_PROVIDER" });
});

test("provider ID must match a recognized URL and provider-specific public config", async () => {
  const f = fixture(null);
  await assert.rejects(f.store.mutate(command("add", "tracked_companies", null, { entry: { name: "Wrong host", provider: "greenhouse", careers_url: "https://careers.example.org/jobs", enabled: true } })), { message: "PORTAL_UNSUPPORTED_ENABLED_PROVIDER" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", null, { entry: { name: "Lookalike", provider: "greenhouse", careers_url: "https://careers.evilgreenhouse.io/jobs", enabled: true } }), operationId: id(6) }), { message: "PORTAL_UNSUPPORTED_ENABLED_PROVIDER" });
  const board = await f.store.mutate({ ...command("add", "job_boards", null, { entry: { name: "SEEK feed", provider: "jobstreet", api: "https://id.jobstreet.com/api/jobsearch/v5/search", siteKey: "ID-Main", searchKeywords: "data scientist", searchLocation: "Jakarta", pageSize: 30, maxPages: 3, enabled: true } }), operationId: id(2) });
  assert.equal(board.entry.scanSupported, true);
});

test("credential-bearing legacy URLs stay hidden and are preserved when omitted from a partial update", async () => {
  const f = fixture();
  const before = f.document.content;
  const result = await f.store.mutate(command("update", "tracked_companies", f.document.sha256, { selector: { name: "Greenhouse Org" }, entry: { notes: "safe note" } }));
  assert.equal(Object.hasOwn(result.entry, "api"), false);
  assert.deepEqual(result.entry.redactedFields, ["api"]);
  assert.match(f.document.content, /api: https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\?access_token=redact-this/);
  assert.match(f.document.content, /privateToken: "never return this"/);
  assert.notEqual(f.document.content, before);
});

test("confirmed commands enforce safe HTTPS URLs, closed field schemas, exact identity, and unique keys", async () => {
  const f = fixture();
  await assert.rejects(f.store.mutate({ ...command("add", "job_boards", f.document.sha256, { entry: { name: "Bad", careers_url: "http://jobs.example.org", enabled: false } }), operationId: id(2) }), { message: "PORTAL_INVALID_URL" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Bad", careers_url: "https://user:pass@jobs.example.org", enabled: false } }), operationId: id(3) }), { message: "PORTAL_INVALID_URL" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Bad", careers_url: "https://jobs.example.org/apply?access_token=secret", enabled: false } }), operationId: id(4) }), { message: "PORTAL_INVALID_URL" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Bad", parser: { command: "cmd" }, enabled: false } }), operationId: id(5) }), { message: "PORTAL_INVALID_ENTRY" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Greenhouse Org", enabled: false } }), operationId: id(6) }), { message: "PORTAL_DUPLICATE_ENTRY" });
  await assert.rejects(f.store.mutate({ ...command("add", "job_boards", f.document.sha256, { entry: { name: "x", enabled: false, maxPages: "3" } }), operationId: id(7) }), { message: "PORTAL_INVALID_FIELD" });
  await assert.rejects(f.store.mutate({ ...command("delete", "job_boards", f.document.sha256, { selector: { name: "x", extra: "ignored" } }), operationId: id(8) }), { message: "INVALID_REQUEST" });
  await assert.rejects(f.store.mutate({ ...command("delete", "job_boards", f.document.sha256, { selector: { name: "SolidJobs IT" } }), operationId: id(9), confirm: false }), { message: "PORTAL_CONFIRMATION_REQUIRED" });
});

test("opaque local-parser settings are never projected or re-enabled, but may be disabled", async () => {
  const f = fixture(`tracked_companies:\n  - name: Old parser\n    enabled: true\n    provider: local-parser\n    parser:\n      command: node\n      script: private-parser.mjs\n      args: ["--token", "hidden"]\n`);
  const list = await f.store.list(url("/api/portals/entries", "?collection=tracked_companies"));
  assert.equal(list.entries[0].scanSupported, false);
  assert.equal(JSON.stringify(list).includes("private-parser"), false);
  await assert.rejects(f.store.mutate(command("update", "tracked_companies", f.document.sha256, { selector: { name: "Old parser" }, entry: { notes: "edit" } })), { message: "PORTAL_UNSUPPORTED_ENABLED_PROVIDER" });
  const disabled = await f.store.mutate({ ...command("update", "tracked_companies", f.document.sha256, { selector: { name: "Old parser" }, entry: { enabled: false } }), operationId: id(5) });
  assert.equal(disabled.entry.enabled, false);
  assert.match(f.document.content, /private-parser\.mjs/);
});

test("ambiguous normalized legacy names fail detail/mutation rather than selecting the first", async () => {
  const f = fixture(`tracked_companies:\n  - name: Acme\n    enabled: false\n  - name: " ACME "\n    enabled: false\n`);
  await assert.rejects(f.store.get(url("/api/portals/entry", "?collection=tracked_companies&name=acme")), { message: "PORTAL_ENTRY_AMBIGUOUS" });
  await assert.rejects(f.store.mutate(command("delete", "tracked_companies", f.document.sha256, { selector: { name: "Acme" } })), { message: "PORTAL_ENTRY_AMBIGUOUS" });
});

test("shared YAML anchors block only mutations that would affect other values", async () => {
  const sharedScalar = fixture(`tracked_companies:\n  - name: Anchor\n    enabled: false\n    scan_query: &shared_query original\n  - name: Alias\n    enabled: false\n    scan_query: *shared_query\n`);
  const scalarSha = sharedScalar.document.sha256;
  await assert.rejects(sharedScalar.store.mutate(command("update", "tracked_companies", scalarSha, { selector: { name: "Anchor" }, entry: { scan_query: "changed" } })), { message: "PORTAL_SHARED_ALIAS_MUTATION" });
  await assert.rejects(sharedScalar.store.mutate({ ...command("delete", "tracked_companies", scalarSha, { selector: { name: "Anchor" } }), operationId: id(7) }), { message: "PORTAL_SHARED_ALIAS_MUTATION" });
  assert.equal(sharedScalar.document.sha256, scalarSha);
  assert.equal(sharedScalar.mutations.size, 0);

  const sharedMap = fixture(`tracked_companies:\n  - &shared_entry\n    name: Shared\n    enabled: false\n    notes: original\n  - name: Other\n    enabled: false\nroot_alias:\n  entry: *shared_entry\n`);
  const mapSha = sharedMap.document.sha256;
  await assert.rejects(sharedMap.store.mutate(command("update", "tracked_companies", mapSha, { selector: { name: "Shared" }, entry: { notes: "changed" } })), { message: "PORTAL_SHARED_ALIAS_MUTATION" });
  assert.equal(sharedMap.document.sha256, mapSha);
  assert.equal(sharedMap.mutations.size, 0);

  const unrelated = fixture(`root_alias: &unrelated original\nroot_copy: *unrelated\ntracked_companies:\n  - name: Local\n    enabled: false\n`);
  const safe = await unrelated.store.mutate(command("update", "tracked_companies", unrelated.document.sha256, { selector: { name: "Local" }, entry: { notes: "local change" } }));
  assert.equal(safe.entry.notes, "local change", "unrelated document aliases do not block scoped edits");
});

test("key-ordered replay is stable; changed payload, stale SHA, and write race fail closed", async () => {
  const f = fixture(null);
  const first = command("add", "tracked_companies", null, { entry: { name: "Greenhouse Org", careers_url: "https://job-boards.greenhouse.io/acme", enabled: true } });
  const written = await f.store.mutate(first);
  const reordered = { confirm: true, expectedSha256: null, collection: "tracked_companies", operation: "add", operationId: id(1), entry: { enabled: true, careers_url: "https://job-boards.greenhouse.io/acme", name: "Greenhouse Org" } };
  assert.equal((await f.store.mutate(reordered)).replayed, true);
  await assert.rejects(f.store.mutate({ ...first, entry: { ...first.entry, name: "Different" } }), { message: "IDEMPOTENCY_KEY_CONFLICT" });
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", null, { entry: { name: "Stale", enabled: false } }), operationId: id(3) }), { message: "WRITE_CONFLICT" });
  assert.equal(f.document.sha256, written.sha256);
  f.failWrite = true;
  await assert.rejects(f.store.mutate({ ...command("add", "tracked_companies", f.document.sha256, { entry: { name: "Race", enabled: false } }), operationId: id(4) }), { message: "WRITE_CONFLICT" });
  assert.equal(f.mutations.has(id(4)), false);
});

test("HTTP command checks JSON MIME before looking up database configuration", async () => {
  const response = await handleCloudPortal(new Request("https://example.test/api/portals/commands", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), "mutate");
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { code: "JSON_REQUIRED" });
});

test("management mutations never dispatch a provider or scanner fetch", async () => {
  const f = fixture(null);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected provider dispatch"); };
  try {
    await f.store.mutate(command("add", "job_boards", null, { entry: { name: "Manual canary", provider: "future-plugin", enabled: false } }));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
