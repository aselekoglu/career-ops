import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createCloudSourceManagement,
  handleCloudSourceHistory,
  handleCloudSourcePreview,
  handleCloudSourceRead,
  shouldCacheCloudDocument,
} from "../../src/lib/cloud-source-management.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cv = "# CV\n\n## Projects\n\nBuilt Foo, a reliable service.\n";
const profile = "candidate:\n  full_name: Alex Example\n  custom_field: preserve\nfuture_section:\n  value: keep\n";
const statement = { kind: "user_statement", reference: "direct user statement in this conversation" };

function fakeSql(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const mutations = new Map();
  const statements = [];
  let forceCasMiss = false;
  const row = (path, content) => ({ path, content, sha256: sha(content), content_encoding: "utf8", byte_size: Buffer.byteLength(content), updated_at: "2026-10-04T00:00:00.000Z" });
  return {
    docs, mutations, statements,
    set(path, content) { docs.set(path, content); },
    forceCasMiss(value) { forceCasMiss = value; },
    async query(statement, params = []) {
      statements.push(statement);
      if (statement.startsWith("CREATE TABLE IF NOT EXISTS career_ops_tracker_mutations")) return [];
      if (statement.startsWith("SELECT path,CASE WHEN octet_length(content)<=200000 THEN content ELSE NULL END AS content")) {
        assert.match(statement, /octet_length\(content\)>200000 AS too_large/);
        const content = docs.get(params[0]);
        if (content === undefined) return [];
        const tooLarge = Buffer.byteLength(content, "utf8") > 200_000;
        return [{ ...row(params[0], tooLarge ? "" : content), content: tooLarge ? null : content, sha256: sha(content), too_large: tooLarge }];
      }
      if (statement.startsWith("SELECT path,CASE WHEN octet_length(content)<=2000000 THEN content ELSE NULL END AS content")) {
        assert.match(statement, /octet_length\(content\)>2000000 AS too_large/);
        const content = docs.get(params[0]);
        if (content === undefined) return [];
        const tooLarge = Buffer.byteLength(content, "utf8") > 2_000_000;
        return [{ ...row(params[0], tooLarge ? "" : content), content: tooLarge ? null : content, sha256: sha(content), too_large: tooLarge }];
      }
      if (statement.startsWith("SELECT payload_sha256,result FROM career_ops_tracker_mutations WHERE id=$1")) {
        const prior = mutations.get(params[0]); return prior ? [{ payload_sha256: prior.hash, result: prior.result }] : [];
      }
      if (statement.startsWith("SELECT path,updated_at,")) {
        const prefix = params[0].replace(/%$/, "");
        assert.match(statement, /content::jsonb->>'beforeSha256'/);
        assert.match(statement, /annotation_count/);
        assert.match(statement, /content_encoding='utf8'/);
        assert.doesNotMatch(statement, /jsonb_object_length|AS source_annotations|SELECT path,content,updated_at|->'diff'/);
        return [...docs.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, content]) => {
          const receipt = JSON.parse(content);
          const annotations = receipt.sourceAnnotations;
          return { path, updated_at: "2026-10-04T00:00:00.000Z", operation_id: receipt.operationId, proposal_id: receipt.proposalId, source: receipt.source,
            before_sha256: receipt.beforeSha256, after_sha256: receipt.afterSha256, status: receipt.status, annotation_count: receipt.annotationCount ?? (Array.isArray(annotations) ? annotations.length : Object.keys(annotations ?? {}).length), created_at: receipt.createdAt };
        }).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(params[2], params[2] + params[1]);
      }
      if (statement.startsWith("WITH incoming AS MATERIALIZED")) {
        const [id, mutationHash, serializedDocs, serializedResult] = params;
        const incoming = JSON.parse(serializedDocs), result = JSON.parse(serializedResult);
        const prior = mutations.get(id);
        if (prior) return [{ payload_sha256: prior.hash, result: prior.result, applied: false, cas_ok: false, writes_ok: true }];
        const casOk = !forceCasMiss && incoming.every(doc => {
          const current = docs.get(doc.path);
          const currentSha = current === undefined ? null : sha(current);
          return currentSha === doc.expected_sha;
        });
        if (!casOk) return [{ payload_sha256: null, result: null, applied: false, cas_ok: false, writes_ok: true }];
        for (const doc of incoming) docs.set(doc.path, doc.content);
        mutations.set(id, { hash: mutationHash, result });
        return [{ payload_sha256: mutationHash, result, applied: true, cas_ok: true, writes_ok: true }];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
}

test("CV preview applies bounded ordered exact replacements and persists only the reviewed proposal", async () => {
  const db = fakeSql({ "cv.md": cv });
  const service = createCloudSourceManagement({ sql: db, now: () => new Date("2026-10-04T12:00:00.000Z") });
  const input = {
    source: "cv", expectedSha256: sha(cv), operationId: uuid(1),
    edits: [{ oldText: "Built Foo, a reliable service.", newText: "Built Foo, a resilient service.", sourceAnnotation: statement }],
  };
  const preview = await service.createProposal("cv", input);
  assert.equal(preview.status, "preview");
  assert.equal(preview.baseSha256, sha(cv));
  assert.equal(preview.proposedSha256, sha(cv.replace("reliable", "resilient")));
  assert.equal(preview.diff[0].oldText, "Built Foo, a reliable service.");
  assert.equal(db.docs.get("cv.md"), cv);
  assert.ok(db.docs.has(`data/source-proposals/${uuid(1)}.json`));
  assert.equal((await service.getProposal("cv", preview.proposalId)).diff[0].newText, "Built Foo, a resilient service.");
});

test("CV preview reports stale source SHA distinctly", async () => {
  const db = fakeSql({ "cv.md": cv });
  const service = createCloudSourceManagement({ sql: db });
  await assert.rejects(service.createProposal("cv", {
    source: "cv", expectedSha256: "0".repeat(64), operationId: uuid(20), edits: [],
  }), { message: "SOURCE_STALE" });
});

test("CV preview rejects missing or ambiguous exact-match text", async () => {
  const db = fakeSql({ "cv.md": `${cv}Built Foo, a reliable service.\n` });
  const service = createCloudSourceManagement({ sql: db });
  await assert.rejects(service.createProposal("cv", {
    source: "cv", expectedSha256: sha(db.docs.get("cv.md")), operationId: uuid(2),
    edits: [{ oldText: "Built Foo, a reliable service.", newText: "Changed text.", sourceAnnotation: statement }],
  }), { message: "CV_EDIT_MATCH_NOT_UNIQUE" });
});

test("CV exact matching rejects overlapping occurrences", async () => {
  const db = fakeSql({ "cv.md": "aaa" });
  const service = createCloudSourceManagement({ sql: db });
  await assert.rejects(service.createProposal("cv", {
    source: "cv", expectedSha256: sha("aaa"), operationId: uuid(16),
    edits: [{ oldText: "aa", newText: "b", sourceAnnotation: statement }],
  }), { message: "CV_EDIT_MATCH_NOT_UNIQUE" });
});

test("source selector rejects inherited object names", async () => {
  const service = createCloudSourceManagement({ sql: fakeSql({}) });
  await assert.rejects(service.readSource("constructor"), { message: "INVALID_SOURCE" });
  await assert.rejects(service.createProposal("toString", {}), { message: "INVALID_SOURCE" });
});

test("source and revision reads fail closed when persisted hashes disagree with UTF-8 content", async () => {
  const revisionHash = sha("actual revision text");
  const malformedRevision = JSON.stringify({ source: "cv", sha256: revisionHash, content: "different text", createdAt: "2026-10-04T00:00:00.000Z" });
  const sql = { async query(statement, params = []) {
    if (statement.startsWith("SELECT path,CASE WHEN octet_length(content)<=200000 THEN content ELSE NULL END AS content")) {
      if (params[0] === "cv.md") return [{ path: "cv.md", content: cv, sha256: "0".repeat(64), content_encoding: "utf8" }];
      if (params[0] === "article-digest.md") return [{ path: "article-digest.md", content: null, sha256: "0".repeat(64), content_encoding: "utf8", too_large: true }];
    }
    if (statement.startsWith("SELECT path,CASE WHEN octet_length(content)<=2000000 THEN content ELSE NULL END AS content")) {
      if (params[0] === `data/source-revisions/cv/${revisionHash}.json`) return [{ path: params[0], content: malformedRevision, sha256: sha(malformedRevision), content_encoding: "utf8" }];
      if (params[0] === `data/source-proposals/${uuid(27)}.json`) return [{ path: params[0], content: null, sha256: "0".repeat(64), content_encoding: "utf8", too_large: true }];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  } };
  const service = createCloudSourceManagement({ sql });
  await assert.rejects(service.readSource("cv"), { message: "DOCUMENT_HASH_MISMATCH" });
  await assert.rejects(service.getRevision("cv", revisionHash), { message: "REVISION_INTEGRITY_ERROR" });
});

test("SQL size sentinels reject oversized annotation and proposal records before parsing", async () => {
  const rowDoc = (path, content) => ({ path, content, sha256: sha(content), content_encoding: "utf8", too_large: false });
  const sql = {
    statements: [],
    async query(statement, params = []) {
      this.statements.push(statement);
      if (statement.startsWith("CREATE TABLE IF NOT EXISTS")) return [];
      if (statement.startsWith("SELECT payload_sha256,result FROM career_ops_tracker_mutations WHERE id=$1")) return [];
      if (statement.startsWith("SELECT path,CASE WHEN octet_length(content)<=200000 THEN content ELSE NULL END AS content")) {
        if (params[0] === "cv.md") return [{ ...rowDoc("cv.md", cv), too_large: false }];
        if (params[0] === "article-digest.md") return [{ path: "article-digest.md", content: null, sha256: "a".repeat(64), content_encoding: "utf8", too_large: true }];
      }
      if (statement.startsWith("SELECT path,CASE WHEN octet_length(content)<=2000000 THEN content ELSE NULL END AS content")) {
        if (params[0] === `data/source-proposals/${uuid(28)}.json`) return [{ path: params[0], content: null, sha256: "b".repeat(64), content_encoding: "utf8", too_large: true }];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
  const service = createCloudSourceManagement({ sql });
  await assert.rejects(service.createProposal("cv", { source: "cv", expectedSha256: sha(cv), operationId: uuid(29), edits: [
    { oldText: "Built Foo, a reliable service.", newText: "Updated statement from source evidence.", sourceAnnotation: { kind: "primary_source", reference: `article-digest.md#${"a".repeat(64)}#${"evidence text ".repeat(3)}` } },
  ] }), { message: "SOURCE_TOO_LARGE" });
  await assert.rejects(service.getProposal("cv", uuid(28)), { message: "SOURCE_RECORD_TOO_LARGE" });
  assert.ok(sql.statements.some(statement => statement.includes("octet_length(content)<=200000")));
  assert.ok(sql.statements.some(statement => statement.includes("octet_length(content)<=2000000")));
});

test("primary-source annotations require an allowlisted fresh hash and exact nontrivial snippet", async () => {
  const source = "Evidence: delivered a reliable service to users and documented its operation.\n";
  const db = fakeSql({ "cv.md": cv, "article-digest.md": source });
  const service = createCloudSourceManagement({ sql: db });
  const reference = `article-digest.md#${sha(source)}#delivered a reliable service to users`;
  const input = { source: "cv", expectedSha256: sha(cv), operationId: uuid(3), edits: [
    { oldText: "Built Foo, a reliable service.", newText: "Built Foo, a reliable service for users.", sourceAnnotation: { kind: "primary_source", reference } },
  ] };
  assert.equal((await service.createProposal("cv", input)).status, "preview");
  await assert.rejects(service.createProposal("cv", { ...input, operationId: uuid(4), edits: [{ ...input.edits[0], sourceAnnotation: { kind: "primary_source", reference: reference.replace(sha(source), "0".repeat(64)) } }] }), { message: "SOURCE_REFERENCE_STALE" });
  await assert.rejects(service.createProposal("cv", { ...input, operationId: uuid(5), edits: [{ ...input.edits[0], sourceAnnotation: { kind: "primary_source", reference: `portals.yml#${sha(source)}#${"x".repeat(30)}` } }] }), { message: "SOURCE_REFERENCE_INVALID" });
  await assert.rejects(service.createProposal("cv", { ...input, operationId: uuid(25), edits: [{ ...input.edits[0], sourceAnnotation: { kind: "primary_source", reference: `modes/_custom.md#${sha(source)}#${"x".repeat(30)}` } }] }), { message: "SOURCE_REFERENCE_INVALID" });
});

test("profile patch preserves unrelated YAML keys and byte-preserves a semantic no-op", async () => {
  const db = fakeSql({ "config/profile.yml": profile });
  const service = createCloudSourceManagement({ sql: db });
  const result = await service.createProposal("profile", {
    source: "profile", expectedSha256: sha(profile), operationId: uuid(6),
    patch: { name: "Alex Example" }, sourceAnnotations: { name: statement },
  });
  assert.equal(result.status, "unchanged");
  assert.equal(result.proposedSha256, sha(profile));
  assert.deepEqual(result.diff, []);
  assert.equal(JSON.parse(db.docs.get(`data/source-proposals/${uuid(6)}.json`)).proposedContent, profile);
});

test("empty profile proposal applies as an auditable no-op without changing source bytes", async () => {
  const original = "# keep this comment\ncandidate:\n  full_name: Alex Example\n";
  const db = fakeSql({ "config/profile.yml": original });
  const service = createCloudSourceManagement({ sql: db, now: () => new Date("2026-10-04T12:00:00.000Z") });
  const proposal = await service.createProposal("profile", { source: "profile", expectedSha256: sha(original), operationId: uuid(22), patch: {}, sourceAnnotations: {} });
  const result = await service.applyProposal("profile", { proposalId: proposal.proposalId, expectedSha256: sha(original), operationId: uuid(23), confirm: true });
  assert.equal(proposal.status, "unchanged");
  assert.equal(result.status, "unchanged");
  assert.equal(result.beforeSha256, result.afterSha256);
  assert.equal(db.docs.get("config/profile.yml"), original);
  assert.ok(db.docs.has(`data/source-revisions/profile/${sha(original)}.json`));
  assert.ok(db.docs.has(`data/source-receipts/profile/${uuid(23)}.json`));
});

test("profile patch rejects unknown keys and malformed YAML without replacing the source", async () => {
  const db = fakeSql({ "config/profile.yml": profile, "config/profile.yml": "candidate: [broken\n" });
  const service = createCloudSourceManagement({ sql: db });
  const body = { source: "profile", expectedSha256: sha(db.docs.get("config/profile.yml")), operationId: uuid(7), patch: { name: "Alex" }, sourceAnnotations: { name: statement } };
  await assert.rejects(service.createProposal("profile", { ...body, patch: { name: "Alex", injected: "no" }, sourceAnnotations: { name: statement, injected: statement } }), { message: "INVALID_PROFILE_PATCH" });
  await assert.rejects(service.createProposal("profile", body), { message: "PROFILE_FORMAT_INVALID" });
});

test("profile patch refuses to replace malformed existing mapping parents", async () => {
  const malformedParent = "candidate: Alex\nfuture_section:\n  value: keep\n";
  const db = fakeSql({ "config/profile.yml": malformedParent });
  const service = createCloudSourceManagement({ sql: db });
  await assert.rejects(service.createProposal("profile", {
    source: "profile", expectedSha256: sha(malformedParent), operationId: uuid(21),
    patch: { name: "Alex Example" }, sourceAnnotations: { name: statement },
  }), { message: "PROFILE_FORMAT_INVALID" });
  assert.equal(db.docs.get("config/profile.yml"), malformedParent);
});

test("source reads and resulting profile content are bounded at 200 KB", async () => {
  const oversizedCv = "x".repeat(200_001);
  const cvService = createCloudSourceManagement({ sql: fakeSql({ "cv.md": oversizedCv }) });
  await assert.rejects(cvService.readSource("cv"), { message: "SOURCE_TOO_LARGE" });

  const compactProfile = `items: [${Array(50_500).fill("1").join(",")}]\n`;
  assert.ok(Buffer.byteLength(compactProfile, "utf8") < 200_000);
  const profileService = createCloudSourceManagement({ sql: fakeSql({ "config/profile.yml": compactProfile }) });
  await assert.rejects(profileService.createProposal("profile", {
    source: "profile", expectedSha256: sha(compactProfile), operationId: uuid(26),
    patch: { name: "Alex Example" }, sourceAnnotations: { name: statement },
  }), { message: "SOURCE_TOO_LARGE" });
});

test("apply requires exact confirmation and current base hash", async () => {
  const db = fakeSql({ "cv.md": cv });
  const service = createCloudSourceManagement({ sql: db });
  const preview = await service.createProposal("cv", { source: "cv", expectedSha256: sha(cv), operationId: uuid(8), edits: [] });
  await assert.rejects(service.applyProposal("cv", { proposalId: preview.proposalId, expectedSha256: sha(cv), operationId: uuid(9), confirm: false }), { message: "CONFIRMATION_REQUIRED" });
  db.set("cv.md", `${cv}External change.\n`);
  const before = new Map(db.docs);
  await assert.rejects(service.applyProposal("cv", { proposalId: preview.proposalId, expectedSha256: sha(cv), operationId: uuid(10), confirm: true }), { message: "SOURCE_STALE" });
  assert.deepEqual(db.docs, before);
});

test("successful apply writes source, immutable revisions, and receipt; replay precedes stale check", async () => {
  const db = fakeSql({ "cv.md": cv });
  const service = createCloudSourceManagement({ sql: db, now: () => new Date("2026-10-04T12:00:00.000Z") });
  const preview = await service.createProposal("cv", {
    source: "cv", expectedSha256: sha(cv), operationId: uuid(11),
    edits: [{ oldText: "Built Foo, a reliable service.", newText: "Built Foo, a resilient service.", sourceAnnotation: statement }],
  });
  const apply = { proposalId: preview.proposalId, expectedSha256: sha(cv), operationId: uuid(12), confirm: true };
  const result = await service.applyProposal("cv", apply);
  const updated = cv.replace("reliable", "resilient");
  assert.equal(result.status, "applied");
  assert.equal(db.docs.get("cv.md"), updated);
  assert.ok(db.docs.has(`data/source-revisions/cv/${sha(cv)}.json`));
  assert.ok(db.docs.has(`data/source-revisions/cv/${sha(updated)}.json`));
  assert.ok(db.docs.has(`data/source-receipts/cv/${uuid(12)}.json`));
  const replay = await service.applyProposal("cv", apply);
  assert.equal(replay.replayed, true);
  await assert.rejects(service.applyProposal("cv", { ...apply, proposalId: uuid(13) }), { message: "IDEMPOTENCY_KEY_CONFLICT" });
  assert.equal((await service.getRevision("cv", sha(cv))).content, cv);
  const history = await service.listHistory("cv", { limit: 100, offset: 0 });
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].sourceAnnotationCount, 1);
});

test("apply rejects malformed expiry and revalidates primary-source evidence", async () => {
  const evidence = "A verified statement with enough exact source text for annotation matching.";
  const db = fakeSql({ "cv.md": cv, "article-digest.md": evidence });
  const service = createCloudSourceManagement({ sql: db, now: () => new Date("2026-10-04T12:00:00.000Z") });
  const sourceAnnotation = { kind: "primary_source", reference: `article-digest.md#${sha(evidence)}#verified statement with enough exact source text` };
  const preview = await service.createProposal("cv", { source: "cv", expectedSha256: sha(cv), operationId: uuid(17), edits: [
    { oldText: "Built Foo, a reliable service.", newText: "Built Foo, a verified service.", sourceAnnotation },
  ] });
  const proposalPath = `data/source-proposals/${preview.proposalId}.json`;
  const saved = JSON.parse(db.docs.get(proposalPath));
  db.set(proposalPath, JSON.stringify({ ...saved, expiresAt: "not-a-date" }));
  await assert.rejects(service.applyProposal("cv", { proposalId: preview.proposalId, expectedSha256: sha(cv), operationId: uuid(18), confirm: true }), { message: "PROPOSAL_INVALID" });

  db.set(proposalPath, JSON.stringify({ ...saved, expiresAt: "2026-10-05T12:00:00.000Z" }));
  db.set("article-digest.md", `${evidence} Changed.`);
  await assert.rejects(service.applyProposal("cv", { proposalId: preview.proposalId, expectedSha256: sha(cv), operationId: uuid(19), confirm: true }), { message: "SOURCE_REFERENCE_STALE" });
  assert.equal(db.docs.get("cv.md"), cv);
});

test("CAS failure rolls back source, revision, receipt, and idempotency writes", async () => {
  const db = fakeSql({ "cv.md": cv });
  const service = createCloudSourceManagement({ sql: db });
  const preview = await service.createProposal("cv", { source: "cv", expectedSha256: sha(cv), operationId: uuid(14), edits: [] });
  const before = new Map(db.docs), mutationCount = db.mutations.size;
  db.forceCasMiss(true);
  await assert.rejects(service.applyProposal("cv", { proposalId: preview.proposalId, expectedSha256: sha(cv), operationId: uuid(15), confirm: true }), { message: "WRITE_CONFLICT" });
  assert.deepEqual(db.docs, before);
  assert.equal(db.mutations.size, mutationCount);
  const statement = db.statements.find(value => value.startsWith("WITH incoming AS MATERIALIZED"));
  assert.match(statement, /gate AS MATERIALIZED/);
  assert.match(statement, /CROSS JOIN marker/);
  assert.match(statement, /asserted AS MATERIALIZED/);
});

test("history bounds metadata and revision reads fail on a path/hash mismatch", async () => {
  const db = fakeSql({ "cv.md": cv });
  const service = createCloudSourceManagement({ sql: db });
  await assert.rejects(service.listHistory("cv", { limit: 101, offset: 0 }), { message: "INVALID_HISTORY_QUERY" });
  await assert.rejects(service.listHistory("cv", { limit: 10, offset: -1 }), { message: "INVALID_HISTORY_QUERY" });
  assert.deepEqual(await service.listHistory("cv", { limit: 100, offset: 0 }), { history: [], pagination: { limit: 100, offset: 0, nextOffset: null } });
  await assert.rejects(service.getRevision("cv", "not-a-sha"), { message: "INVALID_REVISION_SHA" });
});

test("history uses limit-plus-one metadata pagination without returning annotations", async () => {
  const receipts = {};
  for (let n = 30; n < 33; n++) {
    const operationId = uuid(n);
    receipts[`data/source-receipts/cv/${operationId}.json`] = JSON.stringify({
      operationId, proposalId: uuid(n + 10), source: "cv", beforeSha256: sha(`before-${n}`), afterSha256: sha(`after-${n}`),
      status: "applied", annotationCount: 1, sourceAnnotations: [{ kind: "user_statement", reference: "private reviewed statement" }], createdAt: `2026-10-04T12:0${n - 30}:00.000Z`,
    });
  }
  const db = fakeSql({ "cv.md": cv, ...receipts });
  const service = createCloudSourceManagement({ sql: db });
  const page = await service.listHistory("cv", { limit: 2, offset: 0 });
  assert.equal(page.history.length, 2);
  assert.equal(page.pagination.nextOffset, 2);
  assert.equal(page.history[0].sourceAnnotationCount, 1);
  assert.equal("sourceAnnotations" in page.history[0], false);
});

test("history at the maximum offset does not advertise an unsupported next page", async () => {
  const sql = { async query(statement, params = []) {
    if (statement.startsWith("CREATE TABLE IF NOT EXISTS career_ops_tracker_mutations")) return [];
    if (statement.startsWith("SELECT path,updated_at,")) {
      assert.equal(params[1], 101);
      assert.equal(params[2], 10_000);
      return Array.from({ length: 101 }, (_, index) => ({
        path: `data/source-receipts/cv/${uuid(index + 30)}.json`, updated_at: "2026-10-04T12:00:00.000Z",
        operation_id: uuid(index + 30), proposal_id: uuid(index + 130), source: "cv",
        before_sha256: sha(`before-${index}`), after_sha256: sha(`after-${index}`), status: "applied",
        annotation_count: 1, created_at: "2026-10-04T12:00:00.000Z",
      }));
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  } };
  const page = await createCloudSourceManagement({ sql }).listHistory("cv", { limit: 100, offset: 10_000 });
  assert.equal(page.history.length, 100);
  assert.deepEqual(page.pagination, { limit: 100, offset: 10_000, nextOffset: null });
});

test("editable primary source paths bypass warm document caching", () => {
  for (const path of ["cv.md", "config/profile.yml", "modes/_profile.md", "modes/_custom.md", "article-digest.md", "portals.yml", "reports/001-example.md", "data/source-revisions/cv/abc.json"]) assert.equal(shouldCacheCloudDocument(path), false, path);
  assert.equal(shouldCacheCloudDocument("templates/cv-template.html"), true);
});

test("fixed read handler returns exact content hashes and preview enforces JSON content type", async () => {
  const content = "candidate:\n  full_name: Alex\n";
  const service = {
    async readSource(source) { return { source, content, sha256: sha(content) }; },
    async createProposal(_source, input) { return { proposalId: input.operationId, status: "preview", baseSha256: input.expectedSha256, proposedSha256: input.expectedSha256, diff: [], expiresAt: "2026-10-05T00:00:00.000Z" }; },
  };
  const read = await handleCloudSourceRead("profile", { getService: () => service });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { source: "profile", content, sha256: sha(content) });
  const invalid = await handleCloudSourcePreview(new Request("https://career-ops.example/api/sources/profile/proposals", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "not json",
  }), "profile", { getService: () => service });
  assert.equal(invalid.status, 415);
  assert.deepEqual(await invalid.json(), { error: { code: "JSON_REQUIRED", message: "Send a JSON request body." } });
});

test("history route parses numeric pagination and rejects malformed parameters", async () => {
  let requested, calls = 0;
  const service = { async listHistory(source, options) { calls++; requested = { source, options }; return { history: [], pagination: { limit: 50, offset: 0, nextOffset: null } }; } };
  const response = await handleCloudSourceHistory("cv", { url: "https://career-ops.example/api/sources/cv/history?limit=50&offset=0", getService: () => service });
  assert.equal(response.status, 200);
  assert.deepEqual(requested, { source: "cv", options: { limit: 50, offset: 0 } });
  assert.deepEqual(await response.json(), { source: "cv", history: [], pagination: { limit: 50, offset: 0, nextOffset: null } });
  const invalid = await handleCloudSourceHistory("cv", { url: "https://career-ops.example/api/sources/cv/history?limit=lots", getService: () => service });
  assert.equal(invalid.status, 400);
  const unknown = await handleCloudSourceHistory("cv", { url: "https://career-ops.example/api/sources/cv/history?limit=5&extra=x", getService: () => service });
  assert.equal(unknown.status, 400);
  const duplicate = await handleCloudSourceHistory("cv", { url: "https://career-ops.example/api/sources/cv/history?limit=5&limit=6", getService: () => service });
  assert.equal(duplicate.status, 400);
  const outOfRange = await handleCloudSourceHistory("cv", { url: "https://career-ops.example/api/sources/cv/history?limit=101", getService: () => service });
  assert.equal(outOfRange.status, 400);
  assert.equal(calls, 1);
});

test("preview body cap cancels an oversized streamed JSON body without Content-Length", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ source: "cv", operationId: uuid(24), expectedSha256: sha(cv), edits: [], extra: "x".repeat(300_000) }));
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const request = new Request("https://career-ops.example/api/sources/cv/proposals", {
    method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
  });
  const response = await handleCloudSourcePreview(request, "cv", { getService: () => { throw new Error("should reject before service access"); } });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } });
});
