import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createCloudPdfArtifactStore, handleCvArtifactRequest, matchArtifactToApplication, persistRenderedCvArtifact, prepareArtifactAssociation } from "../../src/lib/cloud-pdf-artifacts.mjs";
import { createCloudTrackerManagement } from "../../src/lib/cloud-tracker-management.mjs";

const runId = "451cd973-d7e2-4e76-b1fc-50c32771a9e9";
const lease = "11111111-1111-4111-8111-111111111111";
const url = "https://careers-kinaxis.icims.com/jobs/35379/co-op-intern-forward-deployed-engineer/job";
const aliases = { "#": "num", date: "date", company: "company", role: "role", score: "score", status: "status", pdf: "pdf", report: "report", notes: "notes" };
const trackerText = `# Applications Tracker
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|---|---|---|---|---|---|---|---|
| 52 | 2026-10-02 | Kinaxis | Co-op Intern, Forward Deployed Engineer | 2.5/5 | Evaluated | ❌ | [38](../reports/038-kinaxis-2026-10-02.md) | Preserve me |
`;
const reportText = `# Evaluation: Kinaxis\n\n**URL:** ${url}\n**Score:** 2.5/5\n`;
const pdfBytes = Buffer.from("%PDF-1.7\nPDF payload".padEnd(700, "x"));
const pdfBase64 = pdfBytes.toString("base64");
const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");

test("reportless manual target artifact requires exact bound URL and never fabricates a report/index row", () => {
  const boundUrl = "https://jobs.example.test/role?jobId=one";
  const app = { n: "39", company: "Example Corp", role: "Engineer", report: "" };
  const run = { id: runId, state: "completed", request: { applicationNumber: "39", url: boundUrl }, artifact_path: "output/cv-manual-target.pdf", format: "letter" };
  const pdfDocument = { path: run.artifact_path, content: pdfBase64, content_encoding: "base64", byte_size: pdfBytes.length, sha256: pdfSha };
  const prepared = prepareArtifactAssociation({ run, app, reportContent: null, targetUrl: boundUrl, pdfDocument, trackerContent: trackerText.replace("| 52 |", "| 39 |").replace("| Kinaxis |", "| Example Corp |").replace("| Co-op Intern, Forward Deployed Engineer |", "| Engineer |"), trackerSha: "tracker-sha", pdfIndexContent: "existing-index\n", pdfIndexSha: "index-sha", aliases, idempotencyKey: "manual:1", completedAt: "2026-10-03T12:00:00.000Z" });
  assert.equal(prepared.reportPath, null);
  assert.equal(prepared.pdfIndexContent, "existing-index\n");
  assert.match(prepared.trackerContent, /\| 39 \|[^\n]*\| ✅ \|/);
  assert.throws(() => prepareArtifactAssociation({ run: { ...run, request: { applicationNumber: "39", url: "https://jobs.example.test/role?jobId=two" } }, app, reportContent: null, targetUrl: boundUrl, pdfDocument, trackerContent: trackerText, trackerSha: "tracker-sha", pdfIndexContent: "", pdfIndexSha: null, aliases, idempotencyKey: "manual:2", completedAt: "2026-10-03T12:00:00.000Z" }), { message: "CV_ARTIFACT_IDENTITY_MISMATCH" });
});

test("legacy report-backed artifact identity remains URL/path scoped despite presentation metadata differences", () => {
  const run = { state: "completed", request: { applicationNumber: "52", reportPath: "reports/038-kinaxis-2026-10-02.md", reportUrl: url }, company: "Older imported label", role: "Older imported title" };
  const app = { n: "52", company: "Kinaxis", role: "Co-op Intern, Forward Deployed Engineer", report: "[38](../reports/038-kinaxis-2026-10-02.md)" };
  assert.equal(matchArtifactToApplication(run, app, reportText), true);
});

function makeSql(initialRequest, { includeAliases = true, legacyNumHeader = false, manualTarget = false } = {}) {
  const pdfPath = "output/cv-kinaxis-forward-deployed-test.pdf";
  const storedTracker = manualTarget
    ? `# Applications Tracker\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 39 | 2026-10-02 | Example Corp | Engineer |  | Interview | ❌ |  | Preserve me |\n`
    : legacyNumHeader ? trackerText.replace("| # |", "| Num |") : trackerText;
  const documents = new Map([
    ["data/applications.md", { path: "data/applications.md", content: storedTracker, content_encoding: "utf8", byte_size: Buffer.byteLength(storedTracker), sha256: "tracker-sha" }],
    ["reports/038-kinaxis-2026-10-02.md", { path: "reports/038-kinaxis-2026-10-02.md", content: reportText, content_encoding: "utf8", byte_size: Buffer.byteLength(reportText), sha256: "report-sha" }],
  ]);
  if (manualTarget) {
    const targetMap = JSON.stringify({ version: 1, targets: { "39": { url, company: "Example Corp", role: "Engineer" } } });
    documents.set("data/tracker-targets.json", { path: "data/tracker-targets.json", content: targetMap, content_encoding: "utf8", byte_size: Buffer.byteLength(targetMap), sha256: createHash("sha256").update(targetMap).digest("hex") });
  }
  if (includeAliases) documents.set("data/tracker-aliases.json", { path: "data/tracker-aliases.json", content: JSON.stringify(aliases), content_encoding: "utf8", byte_size: 100, sha256: "aliases-sha" });
  documents.set("data/status-log.tsv", { path: "data/status-log.tsv", content: "", content_encoding: "utf8", byte_size: 0, sha256: "status-sha" });
  const mutations = new Map(); let nextApplicationNumber = 52;
  const run = {
    id: runId, state: "running", request: initialRequest, company: manualTarget ? "Example Corp" : "Kinaxis", role: manualTarget ? "Engineer" : "Co-op Intern, Forward Deployed Engineer", format: "letter",
    html: "<!doctype html><html><body>CV</body></html>", lease, requested_at: "2026-10-02T12:00:00.000Z", started_at: "2026-10-02T12:01:00.000Z",
    completed_at: null, artifact_path: null, application_number: null, report_path: null, association_status: "unlinked", association_error_code: null,
    association_idempotency_key: null, association_request_hash: null,
  };
  let associationWrites = 0;
  let allowAssociationWrite = false;
  const sql = { async query(statement, params = []) {
    if (statement.startsWith("CREATE TABLE") || statement.startsWith("ALTER TABLE") || statement.startsWith("UPDATE career_ops_cv_runs SET state='failed'")) return [];
    if (statement.startsWith("SELECT * FROM career_ops_cv_runs WHERE id=$1")) return [{ ...run }];
    if (statement.startsWith("SELECT payload_sha256,result FROM career_ops_tracker_mutations WHERE id=$1")) { const prior = mutations.get(params[0]); return prior ? [{ payload_sha256: prior.hash, result: prior.result }] : []; }
    if (statement.startsWith("INSERT INTO career_ops_evaluation_report_counter")) return [{ num: ++nextApplicationNumber }];
    if (statement.startsWith("SELECT path,content,sha256,content_encoding FROM career_ops_documents WHERE path=$1")) return documents.has(params[0]) ? [{ ...documents.get(params[0]) }] : [];
    if (statement.startsWith("SELECT path,content,content_encoding,byte_size,sha256 FROM career_ops_documents WHERE path=$1")) return documents.has(params[0]) ? [{ ...documents.get(params[0]) }] : [];
    if (statement.startsWith("SELECT path,") && statement.includes("octet_length(content)")) return documents.has(params[0]) ? [{ ...documents.get(params[0]), too_large: false }] : [];
    if (statement.startsWith("SELECT path,") && statement.includes("regexp_match(content")) return [...documents.values()].filter((doc) => doc.path.startsWith("reports/")).map((doc) => ({ path: doc.path, url: doc.content.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/mi)?.[1] ?? null }));
    if (statement.startsWith("WITH incoming AS MATERIALIZED")) {
      const [id, payloadHash, encodedDocs, encodedResult] = params, incoming = JSON.parse(encodedDocs);
      const cas = incoming.every((doc) => (documents.get(doc.path)?.sha256 ?? null) === doc.expected_sha);
      if (!cas) return [{ payload_sha256: null, result: null, applied: false, cas_ok: false, writes_ok: true }];
      for (const doc of incoming) documents.set(doc.path, { path: doc.path, content: doc.content, content_encoding: "utf8", byte_size: doc.byte_size, sha256: doc.sha256 });
      const result = JSON.parse(encodedResult); mutations.set(id, { hash: payloadHash, result });
      return [{ payload_sha256: payloadHash, result, applied: true, cas_ok: true, writes_ok: true }];
    }
    if (statement.includes("WITH claimed AS")) {
      assert.match(statement, /total=4 THEN 1 ELSE 1\/\(total-total\)/);
      run.state = "completed"; run.artifact_path = pdfPath; run.completed_at = "2026-10-02T12:02:00.000Z";
      run.association_status = initialRequest.applicationNumber ? "pending" : "unlinked";
      documents.set(params[3], { path: params[3], content: params[4], content_encoding: "utf8", byte_size: params[6], sha256: params[5] });
      documents.set(params[7], { path: params[7], content: params[8], content_encoding: "base64", byte_size: params[10], sha256: params[9] });
      return [{ ...run }];
    }
    if (statement.startsWith("WITH locked AS")) {
      associationWrites++;
      assert.match(statement, /WHERE path='data\/applications\.md' AND sha256=\$8/);
      assert.match(statement, /path='data\/tracker-targets\.json' AND sha256=\$14/);
      assert.match(statement, /IS NOT DISTINCT FROM \$12/);
      assert.match(statement, /total=3 THEN 1 ELSE 1\/\(total-total\)/);
      if (!allowAssociationWrite) throw Object.assign(new Error("division by zero"), { code: "22012" });
      documents.set("data/applications.md", { path: "data/applications.md", content: params[4], content_encoding: "utf8", byte_size: params[6], sha256: params[5] });
      if (params[12] !== null) documents.set("data/pdf-index.tsv", { path: "data/pdf-index.tsv", content: params[8], content_encoding: "utf8", byte_size: params[10], sha256: params[9] });
      run.application_number = params[1]; run.report_path = params[12]; run.association_status = "linked"; run.association_error_code = null;
      run.association_idempotency_key = params[2]; run.association_request_hash = params[3];
      return [{ ...run }];
    }
    if (statement.startsWith("UPDATE career_ops_cv_runs SET association_status='pending'")) { run.association_status = "pending"; run.association_error_code = params[1]; return []; }
    throw new Error(`Unexpected SQL in test: ${statement}`);
  } };
  return { sql, documents, run, enableAssociationWrite() { allowAssociationWrite = true; }, associationWrites: () => associationWrites };
}

test("valid exact inbox CV persists as completed but stays unlinked and does not mark a tracker row ready", async () => {
  const db = makeSql({ url });
  const result = await persistRenderedCvArtifact({ sql: db.sql, run: db.run, lease, htmlPath: "output/cv-kinaxis-forward-deployed-test.html", pdfPath: "output/cv-kinaxis-forward-deployed-test.pdf", pdfBytes });
  assert.equal(result.state, "completed");
  assert.equal(result.association_status, "unlinked");
  assert.equal(result.application_number, null);
  assert.match(db.documents.get("data/applications.md").content, /\| ❌ \|/);
  assert.equal(db.documents.get(db.run.artifact_path).content_encoding, "base64");
  assert.equal(db.associationWrites(), 0);
});

test("actual manual-add row starts PDF-pending and its exact binding supports no-report artifact association", async () => {
  const targetUrl = "https://jobs.example.test/role?jobId=one";
  const db = makeSql({ url });
  const tracker = createCloudTrackerManagement({ sql: db.sql, now: () => new Date("2026-10-03T12:00:00.000Z") });
  const added = await tracker.mutate("tracker", { operationId: "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf", operation: "add", company: "Example Corp", role: "Engineer", url: targetUrl, source: "user supplied", status: "Offer", date: "2026-10-01" });
  const applicationNumber = added.application.n;
  const manualRow = db.documents.get("data/applications.md").content.split(/\r?\n/).find((line) => line.startsWith(`| ${applicationNumber} |`));
  assert.match(manualRow, /\| ❌ \|\s*\|/);
  db.run.request = { applicationNumber, url: targetUrl };
  db.run.company = "Example Corp"; db.run.role = "Engineer";
  await persistRenderedCvArtifact({ sql: db.sql, run: db.run, lease, htmlPath: "output/cv-kinaxis-forward-deployed-test.html", pdfPath: "output/cv-kinaxis-forward-deployed-test.pdf", pdfBytes });
  db.enableAssociationWrite();
  const linked = await createCloudPdfArtifactStore({ sql: db.sql }).associate(runId, applicationNumber, "manual:target");
  assert.equal(linked.associationStatus, "linked");
  assert.equal(linked.applicationNumber, applicationNumber);
  assert.equal(linked.reportPath, null);
  assert.equal(db.documents.has("data/pdf-index.tsv"), false, "reportless associations do not invent a report-index row");
  assert.match(db.documents.get("data/applications.md").content, new RegExp(`\\| ${applicationNumber} \\|[^\\n]*\\| ✅ \\|`));
});

test("application-target render stays completed with explicit pending error after tracker CAS conflict, then links idempotently", async () => {
  const db = makeSql({ applicationNumber: "52", reportPath: "reports/038-kinaxis-2026-10-02.md", reportUrl: url });
  const completed = await persistRenderedCvArtifact({ sql: db.sql, run: db.run, lease, htmlPath: "output/cv-kinaxis-forward-deployed-test.html", pdfPath: "output/cv-kinaxis-forward-deployed-test.pdf", pdfBytes });
  assert.equal(completed.state, "completed");
  assert.equal(completed.association_status, "pending");
  const artifactStore = createCloudPdfArtifactStore({ sql: db.sql });
  await assert.rejects(artifactStore.associate(runId, "52", "auto:1"), { message: "CV_ARTIFACT_WRITE_CONFLICT" });
  await artifactStore.markAssociationPending(runId, new Error("CV_ARTIFACT_WRITE_CONFLICT"));
  const pending = await artifactStore.get(runId);
  assert.equal(pending.status, "completed");
  assert.equal(pending.associationPending, true);
  assert.equal(pending.associationErrorCode, "CV_ARTIFACT_WRITE_CONFLICT");
  assert.equal(pending.applicationNumber, null);
  assert.match(db.documents.get("data/applications.md").content, /\| ❌ \|/);

  const downloaded = await artifactStore.download(runId);
  assert.equal(downloaded.bytes.subarray(0, 4).toString("ascii"), "%PDF");
  assert.equal(downloaded.metadata.status, "completed");
  assert.equal(downloaded.metadata.associationPending, true);

  db.enableAssociationWrite();
  const linked = await artifactStore.associate(runId, "52", "manual:retry-1");
  assert.equal(linked.associationStatus, "linked");
  assert.equal(linked.applicationNumber, "52");
  assert.equal(linked.reportPath, "reports/038-kinaxis-2026-10-02.md");
  assert.match(db.documents.get("data/applications.md").content, /\| 52 \|[^\n]*\| ✅ \|/);
  assert.match(db.documents.get("data/applications.md").content, /Preserve me/);
  assert.match(db.documents.get("data/pdf-index.tsv").content, /^038\toutput\/cv-kinaxis-forward-deployed-test\.pdf\toutput\/cv-kinaxis-forward-deployed-test\.html\tletter\t2026-10-02$/m);
  const writes = db.associationWrites();
  const replay = await artifactStore.associate(runId, "52", "manual:retry-1");
  assert.equal(replay.associationStatus, "linked");
  assert.equal(db.associationWrites(), writes, "idempotent replay must not write documents a second time");
});

test("artifact association uses canonical aliases when the Neon alias document is absent", async () => {
  const db = makeSql({ applicationNumber: "52", reportPath: "reports/038-kinaxis-2026-10-02.md", reportUrl: url }, { includeAliases: false, legacyNumHeader: true });
  await persistRenderedCvArtifact({ sql: db.sql, run: db.run, lease, htmlPath: "output/cv-kinaxis-forward-deployed-test.html", pdfPath: "output/cv-kinaxis-forward-deployed-test.pdf", pdfBytes });
  db.enableAssociationWrite();
  const linked = await createCloudPdfArtifactStore({ sql: db.sql }).associate(runId, "52", "auto:canonical-fallback");
  assert.equal(linked.associationStatus, "linked");
  assert.equal(linked.applicationNumber, "52");
  assert.match(db.documents.get("data/applications.md").content, /^\| 52 \|.*\| ✅ \|/m);
  assert.match(db.documents.get("data/applications.md").content, /Preserve me/);
  assert.equal(db.documents.has("data/tracker-aliases.json"), false, "canonical fallback must remain read-only");
});

test("CV worker rejects invalid PDF receipt before document writes", async () => {
  const db = makeSql({ url });
  await assert.rejects(persistRenderedCvArtifact({ sql: db.sql, run: db.run, lease, htmlPath: "output/cv-test.html", pdfPath: "output/cv-test.pdf", pdfBytes: Buffer.from("not a pdf".padEnd(700, "x")) }), { message: "INVALID_CV_RECEIPT" });
  assert.equal(db.run.state, "running");
  assert.equal(db.documents.has(db.run.artifact_path), false);
});

test("fixed download handler is UUID-scoped and sends safe PDF headers", async () => {
  const store = { async download(id) { assert.equal(id, runId); return { bytes: pdfBytes, metadata: { status: "completed" } }; } };
  const response = await handleCvArtifactRequest(new Request(`https://career.example/api/cv-artifacts/${runId}/download`), runId, "download", store);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), `attachment; filename="cv-run-${runId}.pdf"`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("ascii", 0, 4), "%PDF");
  const invalid = await handleCvArtifactRequest(new Request("https://career.example/api/cv-artifacts/../download"), "../download", "download", store);
  assert.equal(invalid.status, 400);
});

test("artifact metadata routes require fixed application/run selectors and reject extra association fields", async () => {
  const calls = [];
  const store = {
    async list(...args) { calls.push(["list", ...args]); return { applicationNumber: args[0] ?? null, artifacts: [], latest: null, pagination: { limit: args[1], offset: args[2], nextOffset: null } }; },
    async get(id) { calls.push(["get", id]); return { runId: id, status: "completed", associationStatus: "unlinked", associationPending: false, requestedAt: "2026-10-02T12:00:00.000Z", completedAt: "2026-10-02T12:02:00.000Z" }; },
    async associate(...args) { calls.push(["associate", ...args]); return {}; },
  };
  const list = await handleCvArtifactRequest(new Request("https://career.example/api/cv-artifacts?applicationNumber=38"), null, "list", store);
  assert.equal(list.status, 200);
  assert.deepEqual(calls[0], ["list", "38", 25, 0]);
  const all = await handleCvArtifactRequest(new Request("https://career.example/api/cv-artifacts?limit=2&offset=4"), null, "list", store);
  assert.equal(all.status, 200);
  assert.deepEqual(calls[1], ["list", null, 2, 4]);
  assert.equal((await handleCvArtifactRequest(new Request("https://career.example/api/cv-artifacts?applicationNumber=38&company=Kinaxis"), null, "list", store)).status, 400);
  assert.equal((await handleCvArtifactRequest(new Request("https://career.example/api/cv-artifacts?limit=1&limit=2"), null, "list", store)).status, 400);
  assert.equal((await handleCvArtifactRequest(new Request("https://career.example/api/cv-artifacts?limit=101"), null, "list", store)).status, 400);
  const metadata = await handleCvArtifactRequest(new Request(`https://career.example/api/cv-artifacts/${runId}`), runId, "metadata", store);
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).associationStatus, "unlinked");
  const invalid = await handleCvArtifactRequest(new Request("https://career.example/api/cv-artifacts/not-a-uuid"), "not-a-uuid", "metadata", store);
  assert.equal(invalid.status, 400);
  const extra = await handleCvArtifactRequest(new Request(`https://career.example/api/cv-artifacts/${runId}/associate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ applicationNumber: "38", idempotencyKey: "key-1", company: "Kinaxis" }),
  }), runId, "associate", store);
  assert.equal(extra.status, 400);
  assert.equal(calls.some(call => call[0] === "associate"), false);
});

test("application lookup returns the newest completed artifact first", async () => {
  const newer = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "completed", request: { url }, company: "Kinaxis", role: "Forward Deployed Engineer", format: "letter", artifact_path: "output/cv-new.pdf", requested_at: "2026-10-02T12:00:00.000Z", completed_at: "2026-10-02T12:03:00.000Z", application_number: "38", report_path: "reports/038-kinaxis-2026-10-02.md", association_status: "linked" };
  const older = { ...newer, id: runId, artifact_path: "output/cv-old.pdf", completed_at: "2026-10-02T12:02:00.000Z" };
  const docs = new Map([newer, older].map(row => [row.artifact_path, { path: row.artifact_path, content: pdfBase64, content_encoding: "base64", byte_size: pdfBytes.length, sha256: pdfSha }]));
  let orderedQuery = "";
  const sql = { async query(statement, params = []) {
    if (statement.startsWith("CREATE TABLE") || statement.startsWith("ALTER TABLE")) return [];
    if (statement.startsWith("SELECT r.id,r.state,")) {
      orderedQuery = statement; assert.equal(params[0], "38"); assert.equal(params[1], 26); assert.equal(params[2], 0);
      return [newer, older].map(row => ({ ...row, stored_pdf_path: row.artifact_path, stored_pdf_encoding: "base64", stored_pdf_size: pdfBytes.length, stored_pdf_sha256: pdfSha }));
    }
    if (statement.startsWith("SELECT path,content,content_encoding,byte_size,sha256 FROM career_ops_documents WHERE path=$1")) return docs.has(params[0]) ? [docs.get(params[0])] : [];
    throw new Error(`Unexpected SQL in list test: ${statement}`);
  } };
  const result = await createCloudPdfArtifactStore({ sql }).list("38");
  assert.match(orderedQuery, /ORDER BY r\.completed_at DESC NULLS LAST, r\.requested_at DESC, r\.id DESC/);
  assert.equal(result.latest.runId, newer.id);
  assert.deepEqual(result.artifacts.map(artifact => artifact.runId), [newer.id, older.id]);
  assert.equal(result.latest.sha256, pdfSha);
});

test("artifact list is globally bounded and returns only PDF metadata for each page", async () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: `${String(index + 1).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, state: "completed", request: {}, company: "Kinaxis", role: `Role ${index + 1}`,
    format: "letter", artifact_path: `output/cv-${index + 1}.pdf`, requested_at: `2026-10-0${4 - index}T12:00:00.000Z`, completed_at: `2026-10-0${4 - index}T13:00:00.000Z`,
    application_number: String(44 - index), report_path: `reports/0${44 - index}-role.md`, association_status: "linked",
    stored_pdf_path: `output/cv-${index + 1}.pdf`, stored_pdf_encoding: "base64", stored_pdf_size: 700 + index, stored_pdf_sha256: String(index + 1).repeat(64),
  }));
  let queryText = "";
  const sql = { async query(statement, params = []) {
    if (statement.startsWith("CREATE TABLE") || statement.startsWith("ALTER TABLE")) return [];
    if (statement.startsWith("SELECT r.id,r.state,")) {
      queryText = statement;
      if (params[1] === 3) { assert.deepEqual(params, [null, 3, 1]); return rows.slice(params[2], params[2] + params[1]); }
      assert.deepEqual(params, [null, 1, 0]);
      return [rows[0]];
    }
    throw new Error(`Unexpected SQL in paged list test: ${statement}`);
  } };
  const result = await createCloudPdfArtifactStore({ sql }).list(null, 2, 1);
  assert.match(queryText, /LIMIT \$2 OFFSET \$3/);
  assert.doesNotMatch(queryText, /d\.content\s*(?:,|AS)/);
  assert.doesNotMatch(queryText, /r\.\*|r\.html|r\.workflow_url|r\.request\s*(?:,|AS)/);
  assert.match(queryText, /jsonb_build_object\('applicationNumber',r\.request->>'applicationNumber'\)/);
  assert.equal(result.applicationNumber, null);
  assert.equal(result.latest.runId, rows[0].id);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts[0].byteSize, 701);
  assert.equal(result.artifacts[0].sha256, String(2).repeat(64));
  assert.deepEqual(result.pagination, { limit: 2, offset: 1, nextOffset: 3 });
});
