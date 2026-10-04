import { createHash } from "node:crypto";
import { detectColumnMap, parseApplications } from "./tracker-table.mjs";
import { resolveTrackerAliases } from "./cloud-tracker-aliases.mjs";

const PDF_PATH_RE = /^output\/[A-Za-z0-9._-]+\.pdf$/;
const REPORT_PATH_RE = /^reports\/[A-Za-z0-9._-]+\.md$/;
const SHA_RE = /^[0-9a-f]{64}$/i;
const MAX_PDF_BYTES = 9_000_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @typedef {"unlinked"|"pending"|"linked"} ArtifactAssociationStatus */
/** @typedef {Object} CloudCvArtifactMetadata
 * @property {string} runId
 * @property {string} status
 * @property {ArtifactAssociationStatus} associationStatus
 * @property {boolean} associationPending
 * @property {string|null} associationErrorCode
 * @property {string|null} applicationNumber
 * @property {string|null} targetApplicationNumber
 * @property {string|null} reportPath
 * @property {string|null} company
 * @property {string|null} role
 * @property {string|null} artifactPath
 * @property {"application/pdf"} contentType
 * @property {number|null} byteSize
 * @property {string|null} sha256
 * @property {"letter"|"a4"|null} format
 * @property {string|null} requestedAt
 * @property {string|null} completedAt
 */
const RUN_SCHEMA = `CREATE TABLE IF NOT EXISTS career_ops_cv_runs (
  id UUID PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('generating','queued','running','completed','failed')),
  request JSONB NOT NULL,
  company TEXT,
  role TEXT,
  format TEXT,
  html TEXT,
  artifact_path TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  lease UUID,
  error_code TEXT,
  workflow_url TEXT,
  application_number TEXT,
  report_path TEXT,
  association_status TEXT NOT NULL DEFAULT 'unlinked',
  association_error_code TEXT,
  association_idempotency_key TEXT,
  association_request_hash TEXT
)`;
const RUN_MIGRATION = `ALTER TABLE career_ops_cv_runs
  ADD COLUMN IF NOT EXISTS application_number TEXT,
  ADD COLUMN IF NOT EXISTS report_path TEXT,
  ADD COLUMN IF NOT EXISTS association_status TEXT NOT NULL DEFAULT 'unlinked',
  ADD COLUMN IF NOT EXISTS association_error_code TEXT,
  ADD COLUMN IF NOT EXISTS association_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS association_request_hash TEXT`;

export async function ensureCvArtifactSchema(sql) {
  await sql.query(RUN_SCHEMA, []);
  await sql.query(RUN_MIGRATION, []);
}

export async function persistRenderedCvArtifact({ sql, run, lease, htmlPath, pdfPath, pdfBytes }) {
  if (!run || !UUID_RE.test(String(run.id || "")) || !UUID_RE.test(String(lease || "")) ||
      !PDF_PATH_RE.test(String(pdfPath || "")) || !/^output\/[A-Za-z0-9._-]+\.html$/.test(String(htmlPath || "")) ||
      typeof run.html !== "string" || !["letter", "a4"].includes(run.format) || !Buffer.isBuffer(pdfBytes) ||
      pdfBytes.length < 500 || pdfBytes.length > MAX_PDF_BYTES || pdfBytes.subarray(0, 4).toString("ascii") !== "%PDF") {
    throw new Error("INVALID_CV_RECEIPT");
  }
  const pdfBase64 = pdfBytes.toString("base64");
  const rows = await sql.query(`WITH claimed AS (
      SELECT id,request FROM career_ops_cv_runs WHERE id=$1 AND lease=$2 AND state='running' AND format=$3 FOR UPDATE
    ), html_doc AS (
      INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
      SELECT $4,$5,$6,'utf8',$7,now() FROM claimed ON CONFLICT(path) DO NOTHING RETURNING path
    ), pdf_doc AS (
      INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
      SELECT $8,$9,$10,'base64',$11,now() FROM html_doc ON CONFLICT(path) DO NOTHING RETURNING path
    ), completed AS (
    UPDATE career_ops_cv_runs SET state='completed',artifact_path=$8,completed_at=now(),
      association_status=CASE WHEN claimed.request ? 'applicationNumber' THEN 'pending' ELSE 'unlinked' END,
      association_error_code=NULL
    FROM claimed,pdf_doc WHERE career_ops_cv_runs.id=claimed.id AND career_ops_cv_runs.state='running' AND career_ops_cv_runs.lease=$2
    RETURNING career_ops_cv_runs.*
    ), counts AS (
      SELECT (SELECT COUNT(*) FROM claimed)+(SELECT COUNT(*) FROM html_doc)+(SELECT COUNT(*) FROM pdf_doc)+(SELECT COUNT(*) FROM completed) AS total
    ), asserted AS MATERIALIZED (
      SELECT CASE WHEN total=4 THEN 1 ELSE 1/(total-total) END AS ok FROM counts
    )
    SELECT completed.* FROM asserted LEFT JOIN completed ON TRUE WHERE asserted.ok=1 AND completed.id IS NOT NULL`,
  [run.id, lease, run.format, htmlPath, run.html, hash(Buffer.from(run.html)), Buffer.byteLength(run.html), pdfPath, pdfBase64, hash(pdfBytes), pdfBytes.length]);
  if (!rows[0]) throw new Error("INVALID_CV_WORKER_CLAIM");
  return rows[0];
}

export function validatePdfDocument(row) {
  if (!row || row.content_encoding !== "base64" || typeof row.content !== "string" ||
      row.content.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.content) ||
      !Number.isSafeInteger(Number(row.byte_size)) || Number(row.byte_size) < 500 || Number(row.byte_size) > MAX_PDF_BYTES ||
      typeof row.sha256 !== "string" || !SHA_RE.test(row.sha256)) throw new Error("CV_ARTIFACT_INVALID");
  const bytes = Buffer.from(row.content, "base64");
  if (bytes.toString("base64") !== row.content || bytes.byteLength !== Number(row.byte_size) ||
      bytes.subarray(0, 4).toString("ascii") !== "%PDF" || hash(bytes) !== row.sha256.toLowerCase()) {
    throw new Error("CV_ARTIFACT_INVALID");
  }
  return bytes;
}

export function reportPathFromCell(value) {
  const match = String(value || "").match(/\]\((?:\.\.\/)?(reports\/[A-Za-z0-9._-]+\.md)\)/);
  return match && REPORT_PATH_RE.test(match[1]) ? match[1] : null;
}

export function reportUrlFromContent(content) {
  const match = String(content || "").match(/^\*\*URL:\*\*\s*(https?:\/\/[^\s]+)\s*$/mi);
  return match?.[1] || null;
}

export function matchArtifactToApplication(run, app, reportContent) {
  if (!run || run.state !== "completed" || !app || typeof app.n !== "string") return false;
  const request = typeof run.request === "string" ? safeJson(run.request) : run.request;
  if (!request || typeof request !== "object") return false;
  const reportUrl = reportUrlFromContent(reportContent);
  if (request.applicationNumber !== undefined) {
    const reportPath = reportPathFromCell(app.report);
    return String(request.applicationNumber) === app.n && typeof request.reportUrl === "string" && request.reportUrl === reportUrl &&
      typeof request.reportPath === "string" && request.reportPath === reportPath;
  }
  return typeof request.url === "string" && Boolean(reportUrl) && request.url === reportUrl;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function updateTrackerPdf(content, applicationNumber, aliases) {
  const original = String(content || "");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const apps = parseApplications(content, "", aliases);
  const matches = apps.filter((app) => app.n === applicationNumber);
  if (!matches.length) throw new Error("CV_ARTIFACT_APPLICATION_NOT_FOUND");
  if (matches.length !== 1) throw new Error("CV_ARTIFACT_APPLICATION_AMBIGUOUS");
  const map = detectColumnMap(lines, aliases || {});
  if (!map || map.pdf === undefined) throw new Error("CV_ARTIFACT_TRACKER_INVALID");
  const index = lines.findIndex((line) => line.trim() === matches[0].raw);
  if (index < 0) throw new Error("CV_ARTIFACT_TRACKER_INVALID");
  const parts = lines[index].split("|").map((value) => value.trim());
  if (parts[map.pdf + 1] === "✅") return original;
  if (parts[map.pdf + 1] !== "❌") throw new Error("CV_ARTIFACT_TRACKER_PDF_STATE_INVALID");
  parts[map.pdf + 1] = "✅";
  lines[index] = "| " + parts.slice(1, -1).join(" | ") + " |";
  return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}

function normalizeReportNumber(value) {
  return String(value || "").replace(/^0+(?=\d)/, "");
}

function updatePdfIndex(content, reportPath, pdfPath, htmlPath, format, date) {
  const reportNumber = reportPath.match(/^reports\/(\d+)-/i)?.[1];
  if (!reportNumber || !PDF_PATH_RE.test(pdfPath) || !/^output\/[A-Za-z0-9._-]+\.html$/.test(htmlPath) || !["letter", "a4"].includes(format) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("CV_ARTIFACT_INDEX_ROW_INVALID");
  }
  const original = String(content || "");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const retained = lines.filter((line) => {
    if (!line.trim() || line.startsWith("#")) return true;
    const columns = line.split("\t");
    return normalizeReportNumber(columns[0]) !== normalizeReportNumber(reportNumber) && columns[1] !== pdfPath;
  });
  if (!retained.some((line) => line.startsWith("#"))) retained.unshift("# report\tpdf\thtml\tformat\tdate — written by generate-pdf.mjs, do not edit");
  retained.push([reportNumber, pdfPath, htmlPath, format, date].join("\t"));
  return retained.join(newline).replace(/(?:\r?\n)*$/, newline);
}

export function prepareArtifactAssociation({ run, app, reportContent, pdfDocument, trackerContent, trackerSha, pdfIndexContent, pdfIndexSha, aliases, idempotencyKey, completedAt }) {
  if (!run || run.state !== "completed" || !run.id || !/^\d{1,6}$/.test(String(app?.n || "")) ||
      typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw new Error("CV_ARTIFACT_ASSOCIATION_INVALID");
  }
  if (!PDF_PATH_RE.test(String(run.artifact_path || "")) || pdfDocument?.path !== run.artifact_path) throw new Error("CV_ARTIFACT_INVALID");
  const bytes = validatePdfDocument(pdfDocument);
  if (!matchArtifactToApplication(run, app, reportContent)) throw new Error("CV_ARTIFACT_IDENTITY_MISMATCH");
  const reportPath = reportPathFromCell(app.report);
  const reportNumber = reportPath?.match(/^reports\/(\d+)-/)?.[1];
  if (!reportPath || !reportNumber) throw new Error("CV_ARTIFACT_REPORT_LINK_INVALID");
  const trackerNext = updateTrackerPdf(trackerContent, app.n, aliases);
  const htmlPath = run.artifact_path.replace(/\.pdf$/i, ".html");
  const date = new Date(completedAt).toISOString().slice(0, 10);
  const pdfIndexNext = updatePdfIndex(pdfIndexContent, reportPath, run.artifact_path, htmlPath, run.format, date);
  return {
    runId: run.id,
    applicationNumber: app.n,
    reportPath,
    reportNumber,
    artifactPath: run.artifact_path,
    htmlPath,
    contentType: "application/pdf",
    byteSize: bytes.byteLength,
    sha256: pdfDocument.sha256.toLowerCase(),
    format: run.format,
    completedAt: new Date(completedAt).toISOString(),
    idempotencyKey,
    trackerContent: trackerNext,
    trackerSha,
    pdfIndexContent: pdfIndexNext,
    pdfIndexSha,
  };
}

export function artifactMetadata(run, pdfDocument = null) {
  const request = typeof run?.request === "string" ? safeJson(run.request) : run?.request;
  const targetApplicationNumber = request?.applicationNumber ? String(request.applicationNumber) : null;
  let bytes = null;
  if (pdfDocument) bytes = validatePdfDocument(pdfDocument);
  return {
    runId: run.id,
    status: run.state,
    associationStatus: run.association_status || (run.application_number ? "linked" : targetApplicationNumber ? "pending" : "unlinked"),
    associationPending: (run.association_status || (run.application_number ? "linked" : targetApplicationNumber ? "pending" : "unlinked")) === "pending",
    associationErrorCode: run.association_error_code || null,
    applicationNumber: run.application_number || null,
    targetApplicationNumber,
    reportPath: run.report_path || null,
    company: run.company || null,
    role: run.role || null,
    artifactPath: run.artifact_path || null,
    contentType: "application/pdf",
    byteSize: bytes?.byteLength ?? null,
    sha256: pdfDocument?.sha256 || null,
    format: run.format || null,
    requestedAt: run.requested_at ? new Date(run.requested_at).toISOString() : null,
    completedAt: run.completed_at ? new Date(run.completed_at).toISOString() : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeAssociationCode = (error) => /^CV_ARTIFACT_[A-Z_]{1,80}$/.test(String(error?.message || "")) ? error.message : "CV_ARTIFACT_ASSOCIATION_FAILED";

export function createCloudPdfArtifactStore(options = {}) {
  const sql = options.sql;
  let initialized;
  const ready = () => initialized ??= ensureCvArtifactSchema(sql).catch((error) => { initialized = null; throw error; });
  const find = async (id) => (await sql.query("SELECT * FROM career_ops_cv_runs WHERE id=$1", [id]))[0] || null;
  const readDocument = async (path) => (await sql.query(
    "SELECT path,content,content_encoding,byte_size,sha256 FROM career_ops_documents WHERE path=$1 LIMIT 1", [path],
  ))[0] || null;

  async function applicationBundle(applicationNumber) {
    const [tracker, aliasesDoc] = await Promise.all([readDocument("data/applications.md"), readDocument("data/tracker-aliases.json")]);
    if (!tracker || tracker.content_encoding !== "utf8") throw new Error("CV_ARTIFACT_TRACKER_UNAVAILABLE");
    if (aliasesDoc && aliasesDoc.content_encoding !== "utf8") throw new Error("CV_ARTIFACT_TRACKER_ALIASES_INVALID");
    const aliases = resolveTrackerAliases(aliasesDoc?.content ?? null, "CV_ARTIFACT_TRACKER_ALIASES_INVALID");
    const apps = parseApplications(tracker.content, "", aliases);
    const matched = apps.filter((app) => app.n === applicationNumber);
    if (!matched.length) throw new Error("CV_ARTIFACT_APPLICATION_NOT_FOUND");
    if (matched.length !== 1) throw new Error("CV_ARTIFACT_APPLICATION_AMBIGUOUS");
    const reportPath = reportPathFromCell(matched[0].report);
    if (!reportPath) throw new Error("CV_ARTIFACT_REPORT_LINK_INVALID");
    const reportDoc = await readDocument(reportPath);
    if (!reportDoc || reportDoc.content_encoding !== "utf8") throw new Error("CV_ARTIFACT_REPORT_NOT_FOUND");
    return { app: matched[0], reportContent: reportDoc.content, trackerDoc: tracker, aliases };
  }

  async function loadPdf(run) {
    if (!run?.artifact_path || !PDF_PATH_RE.test(run.artifact_path)) throw new Error("CV_ARTIFACT_NOT_FOUND");
    const doc = await readDocument(run.artifact_path);
    if (!doc) throw new Error("CV_ARTIFACT_NOT_FOUND");
    try { validatePdfDocument(doc); } catch { throw new Error("CV_ARTIFACT_CORRUPT_PDF"); }
    return doc;
  }

  async function associate(runId, applicationNumber, idempotencyKey) {
    if (!UUID_RE.test(String(runId || ""))) throw new Error("CV_ARTIFACT_INVALID_RUN_ID");
    if (typeof applicationNumber !== "string" || !/^[1-9]\d{0,5}$/.test(applicationNumber)) throw new Error("CV_ARTIFACT_INVALID_APPLICATION_NUMBER");
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new Error("CV_ARTIFACT_INVALID_IDEMPOTENCY_KEY");
    await ready();
    const run = await find(runId);
    if (!run) throw new Error("CV_ARTIFACT_NOT_FOUND");
    if (run.state !== "completed") throw new Error("CV_ARTIFACT_RUN_NOT_COMPLETED");
    const request = typeof run.request === "string" ? safeJson(run.request) : run.request;
    const existingApp = run.application_number || null;
    if (existingApp && existingApp !== applicationNumber) throw new Error("CV_ARTIFACT_ALREADY_ASSOCIATED");
    const keyHash = hash(Buffer.from(`${runId}\n${applicationNumber}\n${idempotencyKey}`));
    if (existingApp === applicationNumber && run.association_status === "linked" && run.association_idempotency_key === idempotencyKey && run.association_request_hash === keyHash) {
      return get(runId);
    }
    if (run.association_idempotency_key && (run.association_idempotency_key !== idempotencyKey || run.association_request_hash !== keyHash)) {
      if (existingApp === applicationNumber && run.association_status === "linked") return get(runId);
      throw new Error("CV_ARTIFACT_IDEMPOTENCY_CONFLICT");
    }
    const pdfDoc = await loadPdf(run);
    const { app, reportContent, trackerDoc, aliases } = await applicationBundle(applicationNumber);
    const indexDoc = await readDocument("data/pdf-index.tsv");
    if (indexDoc && indexDoc.content_encoding !== "utf8") throw new Error("CV_ARTIFACT_INDEX_INVALID");
    const prepared = prepareArtifactAssociation({
      run, app, reportContent, pdfDocument: pdfDoc,
      trackerContent: trackerDoc.content, trackerSha: trackerDoc.sha256,
      pdfIndexContent: indexDoc?.content ?? "", pdfIndexSha: indexDoc?.sha256 ?? null,
      aliases, idempotencyKey, completedAt: run.completed_at,
    });
    const trackerShaNext = hash(Buffer.from(prepared.trackerContent));
    const indexShaNext = hash(Buffer.from(prepared.pdfIndexContent));
    let rows;
    try { rows = await sql.query(`WITH locked AS (
        SELECT id FROM career_ops_cv_runs
        WHERE id=$1 AND state='completed'
          AND (application_number IS NULL OR application_number=$2)
          AND (association_idempotency_key IS NULL OR association_idempotency_key=$3)
          AND (association_request_hash IS NULL OR association_request_hash=$4)
        FOR UPDATE
      ), tracker AS (
        UPDATE career_ops_documents SET content=$5,sha256=$6,byte_size=$7,updated_at=now()
        WHERE path='data/applications.md' AND sha256=$8 AND EXISTS(SELECT 1 FROM locked) RETURNING path
      ), index_write AS (
        INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
        SELECT 'data/pdf-index.tsv',$9,$10,'utf8',$11,now() FROM tracker
        ON CONFLICT(path) DO UPDATE SET content=EXCLUDED.content,sha256=EXCLUDED.sha256,content_encoding='utf8',byte_size=EXCLUDED.byte_size,updated_at=now()
        WHERE career_ops_documents.sha256 IS NOT DISTINCT FROM $12
        RETURNING path
      ), linked AS (
        UPDATE career_ops_cv_runs SET application_number=$2,report_path=$13,association_status='linked',association_error_code=NULL,
          association_idempotency_key=$3,association_request_hash=$4
        WHERE id=$1 AND state='completed' AND EXISTS(SELECT 1 FROM tracker) AND EXISTS(SELECT 1 FROM index_write)
        RETURNING *
      ), counts AS (
        SELECT (SELECT COUNT(*) FROM tracker)+(SELECT COUNT(*) FROM index_write)+(SELECT COUNT(*) FROM linked) AS total
      ), asserted AS MATERIALIZED (
        SELECT CASE WHEN total=3 THEN 1 ELSE 1/(total-total) END AS ok FROM counts
      )
      SELECT linked.* FROM asserted LEFT JOIN linked ON TRUE WHERE asserted.ok=1 AND linked.id IS NOT NULL`,
    [runId, applicationNumber, idempotencyKey, keyHash,
      prepared.trackerContent, trackerShaNext, Buffer.byteLength(prepared.trackerContent), prepared.trackerSha,
      prepared.pdfIndexContent, indexShaNext, Buffer.byteLength(prepared.pdfIndexContent), prepared.pdfIndexSha, prepared.reportPath]);
    } catch (error) {
      if (error?.code === "22012" || /division by zero/i.test(String(error?.message || ""))) throw new Error("CV_ARTIFACT_WRITE_CONFLICT");
      throw error;
    }
    if (rows[0]) return artifactMetadata(rows[0], pdfDoc);
    const current = await find(runId);
    if (current?.state === "completed" && current.application_number === applicationNumber && current.association_status === "linked" &&
        current.association_idempotency_key === idempotencyKey && current.association_request_hash === keyHash) return get(runId);
    if (current?.application_number === applicationNumber && current.association_status === "linked") return get(runId);
    throw new Error("CV_ARTIFACT_WRITE_CONFLICT");
  }

  async function get(runId) {
    if (!UUID_RE.test(String(runId || ""))) throw new Error("CV_ARTIFACT_INVALID_RUN_ID");
    await ready();
    const run = await find(runId);
    if (!run) return null;
    const doc = run.state === "completed" && run.artifact_path ? await loadPdf(run) : null;
    return artifactMetadata(run, doc);
  }

  return {
    async get(runId) { return get(runId); },
    async list(applicationNumber) {
      if (typeof applicationNumber !== "string" || !/^[1-9]\d{0,5}$/.test(applicationNumber)) throw new Error("CV_ARTIFACT_INVALID_APPLICATION_NUMBER");
      await ready();
      const rows = await sql.query(`SELECT * FROM career_ops_cv_runs
        WHERE application_number=$1 OR request->>'applicationNumber'=$1
        ORDER BY completed_at DESC NULLS LAST, requested_at DESC`, [applicationNumber]);
      const artifacts = [];
      for (const row of rows) {
        const doc = row.state === "completed" && row.artifact_path ? await loadPdf(row) : null;
        artifacts.push(artifactMetadata(row, doc));
      }
      return { applicationNumber, latest: artifacts[0] || null, artifacts };
    },
    async associate(runId, applicationNumber, idempotencyKey) { return associate(runId, applicationNumber, idempotencyKey); },
    async download(runId) {
      if (!UUID_RE.test(String(runId || ""))) throw new Error("CV_ARTIFACT_INVALID_RUN_ID");
      await ready();
      const run = await find(runId);
      if (!run || run.state !== "completed") throw new Error("CV_ARTIFACT_NOT_FOUND");
      const document = await loadPdf(run);
      return { bytes: validatePdfDocument(document), metadata: artifactMetadata(run, document) };
    },
    async markAssociationPending(runId, error) {
      const code = safeAssociationCode(error);
      await ready();
      await sql.query("UPDATE career_ops_cv_runs SET association_status='pending',association_error_code=$2 WHERE id=$1 AND state='completed' AND application_number IS NULL", [runId, code]);
      return code;
    },
  };
}

let defaultStore;
function getStore() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("CV_ARTIFACTS_UNAVAILABLE");
  if (!defaultStore) {
    // Imported lazily so unit tests and local tools can load the pure helpers without Neon setup.
    defaultStore = import("@neondatabase/serverless").then(({ neon }) => createCloudPdfArtifactStore({ sql: neon(databaseUrl) }));
  }
  return defaultStore;
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const API_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function boundedJson(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("CV_ARTIFACT_INVALID_ASSOCIATION");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("CV_ARTIFACT_REQUEST_TOO_LARGE"); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

/** @param {Request} request @param {string|null} [runId] @param {"list"|"metadata"|"associate"|"download"} [action] @param {ReturnType<typeof createCloudPdfArtifactStore>|null} [storeOverride] */
export async function handleCvArtifactRequest(request, runId = null, action = "metadata", storeOverride = null) {
  try {
    const store = storeOverride || await getStore();
    if (action === "list") {
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some((key) => key !== "applicationNumber")) return json({ code: "CV_ARTIFACT_INVALID_QUERY" }, 400);
      const applicationNumber = params.get("applicationNumber");
      if (applicationNumber === null) return json({ code: "CV_ARTIFACT_APPLICATION_NUMBER_REQUIRED" }, 400);
      return json(await store.list(applicationNumber));
    }
    if (!API_UUID_RE.test(String(runId || ""))) return json({ code: "CV_ARTIFACT_INVALID_RUN_ID" }, 400);
    if (new URL(request.url).search) return json({ code: "CV_ARTIFACT_INVALID_QUERY" }, 400);
    if (action === "download") {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
      const result = await store.download(runId);
      return new Response(request.method === "HEAD" ? null : result.bytes, { status: 200, headers: {
        "Content-Type": "application/pdf", "Content-Length": String(result.bytes.byteLength),
        "Content-Disposition": `attachment; filename="cv-run-${runId}.pdf"`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    if (action === "associate") {
      if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
      if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ code: "JSON_REQUIRED" }, 415);
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 4000) return json({ code: "CV_ARTIFACT_REQUEST_TOO_LARGE" }, 413);
      let body;
      try { body = await boundedJson(request, 4000); }
      catch (error) { if (error?.message === "CV_ARTIFACT_REQUEST_TOO_LARGE") return json({ code: error.message }, 413); return json({ code: "CV_ARTIFACT_INVALID_ASSOCIATION" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["applicationNumber", "idempotencyKey"].includes(key))) {
        return json({ code: "CV_ARTIFACT_INVALID_ASSOCIATION" }, 400);
      }
      return json(await store.associate(runId, body.applicationNumber, body.idempotencyKey));
    }
    if (request.method !== "GET" && request.method !== "HEAD") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    const result = await store.get(runId);
    return result ? json(result) : json({ code: "CV_ARTIFACT_NOT_FOUND" }, 404);
  } catch (error) {
    const code = String(error?.message || "CV_ARTIFACTS_UNAVAILABLE");
    const known = /^CV_ARTIFACT_[A-Z_]{1,80}$/.test(code);
    const status = /REQUEST_TOO_LARGE/.test(code) ? 413
      : /INVALID_|APPLICATION_NUMBER|IDEMPOTENCY_KEY|ASSOCIATION_INVALID|REPORT_LINK_INVALID|TRACKER_PDF_STATE/.test(code) ? 400
      : /NOT_FOUND|APPLICATION_NOT_FOUND/.test(code) ? 404
        : /ALREADY_ASSOCIATED|IDEMPOTENCY_CONFLICT|WRITE_CONFLICT|RUN_NOT_COMPLETED|IDENTITY_MISMATCH|AMBIGUOUS/.test(code) ? 409
          : code === "CV_ARTIFACT_CORRUPT_PDF" ? 500 : 503;
    return json({ code: known ? code : "CV_ARTIFACTS_UNAVAILABLE" }, status);
  }
}

export const __test = { reportPathFromCell, reportUrlFromContent, updatePdfIndex };
