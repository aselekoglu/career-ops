import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";

const SOURCE_PATHS = Object.freeze({ cv: "cv.md", profile: "config/profile.yml" });
const PRIMARY_SOURCE_PATHS = new Set(["cv.md", "article-digest.md", "config/profile.yml", "modes/_profile.md"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_CV_BYTES = 200_000;
const MAX_RECORD_BYTES = 2_000_000;
const MAX_EDIT_COUNT = 20;
const MAX_REPLACEMENT_CHARS = 20_000;
const MAX_REFERENCE_CHARS = 2_000;
const MAX_BODY_BYTES = 256_000;
const MAX_HISTORY_OFFSET = 10_000;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_FIELDS = new Set(["name", "email", "location", "roles", "compMin", "compMax", "currency", "remote"]);
const ALWAYS_FRESH_PATHS = new Set(["cv.md", "config/profile.yml", "modes/_profile.md", "modes/_custom.md", "article-digest.md", "portals.yml"]);
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export function shouldCacheCloudDocument(relativePath) {
  const path = String(relativePath ?? "").replaceAll("\\", "/");
  return !path.startsWith("data/") && !ALWAYS_FRESH_PATHS.has(path) && !path.startsWith("reports/");
}

function sourcePath(source) {
  if (!Object.hasOwn(SOURCE_PATHS, source)) throw new Error("INVALID_SOURCE");
  const path = SOURCE_PATHS[source];
  return path;
}
function assertShape(value, allowed, code = "INVALID_REQUEST") {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error(code);
}
function verifyDocument(row, maxBytes, tooLargeCode) {
  if (row?.too_large === true || row && row.content == null) throw new Error(tooLargeCode);
  if (row && typeof row.content === "string" && Buffer.byteLength(row.content, "utf8") > maxBytes) throw new Error(tooLargeCode);
  if (!row || row.content_encoding !== "utf8" || typeof row.content !== "string" || typeof row.sha256 !== "string" || sha(row.content) !== row.sha256) {
    throw new Error("DOCUMENT_HASH_MISMATCH");
  }
  return row;
}
function allowedPrimaryPath(path) {
  return PRIMARY_SOURCE_PATHS.has(path) || /^writing-samples\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/.test(path);
}
function pathValue(root, path) {
  return path.reduce((value, key) => value && typeof value === "object" ? value[key] : undefined, root);
}
function ensureObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
function cloneObject(value) { return structuredClone(ensureObject(value) ? value : {}); }
function setPath(root, path, value) {
  let current = root;
  for (const key of path.slice(0, -1)) {
    if (!ensureObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[path.at(-1)] = value;
}

export function createCloudSourceManagement({ sql, now = () => new Date() }) {
  let initialized;
  const ready = () => initialized ??= sql.query(
    "CREATE TABLE IF NOT EXISTS career_ops_tracker_mutations (id UUID PRIMARY KEY, payload_sha256 TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    [],
  );
  async function read(path) {
    const row = (await sql.query(`SELECT path,CASE WHEN octet_length(content)<=${MAX_CV_BYTES} THEN content ELSE NULL END AS content,sha256,content_encoding,octet_length(content)>${MAX_CV_BYTES} AS too_large FROM career_ops_documents WHERE path=$1`, [path]))[0];
    if (!row) throw new Error("DOCUMENT_UNAVAILABLE");
    return verifyDocument(row, MAX_CV_BYTES, "SOURCE_TOO_LARGE");
  }
  async function optional(path) {
    const row = (await sql.query(`SELECT path,CASE WHEN octet_length(content)<=${MAX_RECORD_BYTES} THEN content ELSE NULL END AS content,sha256,content_encoding,octet_length(content)>${MAX_RECORD_BYTES} AS too_large FROM career_ops_documents WHERE path=$1`, [path]))[0];
    return row ? verifyDocument(row, MAX_RECORD_BYTES, "SOURCE_RECORD_TOO_LARGE") : null;
  }
  async function replay(id, kind, payload) {
    const prior = (await sql.query("SELECT payload_sha256,result FROM career_ops_tracker_mutations WHERE id=$1", [id]))[0];
    if (!prior) return null;
    const payloadHash = sha(JSON.stringify({ kind, payload }));
    if (prior.payload_sha256 !== payloadHash) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    return { ...(prior.result ?? {}), replayed: true };
  }
  async function commit(id, kind, payload, docs, result) {
    const payloadHash = sha(JSON.stringify({ kind, payload }));
    const incoming = docs.map(doc => ({
      path: doc.path,
      expected_sha: doc.old ?? null,
      content: doc.content,
      sha256: sha(doc.content),
      byte_size: Buffer.byteLength(doc.content, "utf8"),
    }));
    const statement = `WITH incoming AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS d(path text, expected_sha text, content text, sha256 text, byte_size integer)
    ), gate AS MATERIALIZED (
      SELECT NOT EXISTS (SELECT 1 FROM incoming i LEFT JOIN career_ops_documents d USING(path) WHERE d.sha256 IS DISTINCT FROM i.expected_sha) AS ok
    ), marker AS (
      INSERT INTO career_ops_tracker_mutations(id,payload_sha256,result) SELECT $1,$2,$4::jsonb FROM gate WHERE ok
      ON CONFLICT(id) DO NOTHING RETURNING id,payload_sha256,result
    ), writes AS (
      INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
      SELECT i.path,i.content,i.sha256,'utf8',i.byte_size,now() FROM incoming i CROSS JOIN marker
      ON CONFLICT(path) DO UPDATE SET content=EXCLUDED.content,sha256=EXCLUDED.sha256,content_encoding='utf8',byte_size=EXCLUDED.byte_size,updated_at=now()
      WHERE career_ops_documents.sha256 IS NOT DISTINCT FROM (SELECT expected_sha FROM incoming WHERE path=EXCLUDED.path)
      RETURNING path
    ), asserted AS MATERIALIZED (
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM marker) OR totals.written=totals.expected THEN TRUE ELSE 1/(totals.written-totals.written)=1 END AS ok
      FROM (SELECT (SELECT count(*) FROM writes) AS written,(SELECT count(*) FROM incoming) AS expected) totals
    ) SELECT COALESCE((SELECT payload_sha256 FROM marker),(SELECT payload_sha256 FROM career_ops_tracker_mutations WHERE id=$1)) AS payload_sha256,
      COALESCE((SELECT result FROM marker),(SELECT result FROM career_ops_tracker_mutations WHERE id=$1)) AS result,
      EXISTS(SELECT 1 FROM marker) AS applied,(SELECT ok FROM gate) AS cas_ok,(SELECT ok FROM asserted) AS writes_ok`;
    let output;
    try { output = (await sql.query(statement, [id, payloadHash, JSON.stringify(incoming), JSON.stringify(result)]))[0]; }
    catch (error) { if (/division by zero/i.test(String(error?.message))) throw new Error("WRITE_CONFLICT"); throw error; }
    if (output?.payload_sha256 == null) throw new Error("WRITE_CONFLICT");
    if (output.payload_sha256 !== payloadHash) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if (!output.applied) return { ...(output.result ?? result), replayed: true };
    if (!output.cas_ok || !output.writes_ok) throw new Error("WRITE_CONFLICT");
    return output.result ?? result;
  }
  async function validateAnnotation(annotation) {
    assertShape(annotation, new Set(["kind", "reference"]), "INVALID_SOURCE_ANNOTATION");
    if (typeof annotation.reference !== "string" || !annotation.reference.trim() || annotation.reference.length > MAX_REFERENCE_CHARS) throw new Error("INVALID_SOURCE_ANNOTATION");
    if (annotation.kind === "user_statement") return { kind: annotation.kind, reference: annotation.reference.trim() };
    if (annotation.kind !== "primary_source") throw new Error("INVALID_SOURCE_ANNOTATION");
    const first = annotation.reference.indexOf("#"), second = annotation.reference.indexOf("#", first + 1);
    if (first < 1 || second < first + 2) throw new Error("SOURCE_REFERENCE_INVALID");
    const path = annotation.reference.slice(0, first), expectedSha = annotation.reference.slice(first + 1, second), snippet = annotation.reference.slice(second + 1);
    if (!allowedPrimaryPath(path) || !SHA_RE.test(expectedSha) || snippet.length < 24 || snippet.trim().length === 0) throw new Error("SOURCE_REFERENCE_INVALID");
    const sourceDoc = await read(path);
    if (sourceDoc.sha256 !== expectedSha) throw new Error("SOURCE_REFERENCE_STALE");
    if (!sourceDoc.content.includes(snippet)) throw new Error("SOURCE_REFERENCE_INVALID");
    return { kind: annotation.kind, reference: annotation.reference };
  }
  async function buildCvProposal(input, base) {
    assertShape(input, new Set(["source", "expectedSha256", "operationId", "edits"]));
    if (input.source !== "cv" || !UUID_RE.test(input.operationId ?? "") || !SHA_RE.test(input.expectedSha256 ?? "") || !Array.isArray(input.edits) || input.edits.length > MAX_EDIT_COUNT) throw new Error("INVALID_CV_PROPOSAL");
    if (input.expectedSha256 !== base.sha256) throw new Error("SOURCE_STALE");
    let proposedContent = base.content;
    const diff = [];
    for (const edit of input.edits) {
      assertShape(edit, new Set(["oldText", "newText", "sourceAnnotation"]), "INVALID_CV_EDIT");
      if (typeof edit.oldText !== "string" || !edit.oldText.trim() || typeof edit.newText !== "string" || edit.oldText.length > MAX_REPLACEMENT_CHARS || edit.newText.length > MAX_REPLACEMENT_CHARS) throw new Error("INVALID_CV_EDIT");
      const at = proposedContent.indexOf(edit.oldText);
      if (at < 0 || proposedContent.indexOf(edit.oldText, at + 1) >= 0) throw new Error("CV_EDIT_MATCH_NOT_UNIQUE");
      const annotation = await validateAnnotation(edit.sourceAnnotation);
      proposedContent = proposedContent.slice(0, at) + edit.newText + proposedContent.slice(at + edit.oldText.length);
      diff.push({ oldText: edit.oldText, newText: edit.newText, sourceAnnotation: annotation });
      if (Buffer.byteLength(proposedContent, "utf8") > MAX_CV_BYTES) throw new Error("SOURCE_TOO_LARGE");
    }
    return { proposedContent, diff, sourceAnnotations: diff.map(entry => entry.sourceAnnotation) };
  }
  function validateProfilePatch(input) {
    assertShape(input, new Set(["source", "expectedSha256", "operationId", "patch", "sourceAnnotations"]));
    if (input.source !== "profile" || !UUID_RE.test(input.operationId ?? "") || !ensureObject(input.patch) || !ensureObject(input.sourceAnnotations)) throw new Error("INVALID_PROFILE_PATCH");
    const keys = Object.keys(input.patch);
    if (keys.some(key => !PROFILE_FIELDS.has(key)) || Object.keys(input.sourceAnnotations).length !== keys.length || keys.some(key => !(key in input.sourceAnnotations))) throw new Error("INVALID_PROFILE_PATCH");
    if (("compMin" in input.patch) !== ("compMax" in input.patch)) throw new Error("INVALID_PROFILE_PATCH");
    const p = input.patch;
    for (const key of ["name", "email", "location", "currency", "remote"]) if (key in p && (typeof p[key] !== "string" || !p[key].trim() || p[key].length > 500)) throw new Error("INVALID_PROFILE_PATCH");
    if ("roles" in p && (!Array.isArray(p.roles) || p.roles.length < 1 || p.roles.length > 6 || p.roles.some(role => typeof role !== "string" || !role.trim() || role.length > 200))) throw new Error("INVALID_PROFILE_PATCH");
    if ("currency" in p && !/^[A-Z]{3}$/.test(p.currency)) throw new Error("INVALID_PROFILE_PATCH");
    for (const key of ["compMin", "compMax"]) if (key in p && (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1_000_000_000)) throw new Error("INVALID_PROFILE_PATCH");
    if ("compMin" in p && p.compMin > p.compMax) throw new Error("INVALID_PROFILE_PATCH");
    return keys;
  }
  async function buildProfileProposal(input, base) {
    const keys = validateProfilePatch(input);
    if (input.expectedSha256 !== base.sha256) throw new Error("SOURCE_STALE");
    let parsed;
    try { parsed = parseYaml(base.content); } catch { throw new Error("PROFILE_FORMAT_INVALID"); }
    if (!ensureObject(parsed)) throw new Error("PROFILE_FORMAT_INVALID");
    const baseObject = cloneObject(parsed), merged = cloneObject(parsed), p = input.patch;
    for (const parent of ["candidate", "target_roles", "compensation"]) {
      if (Object.hasOwn(baseObject, parent) && !ensureObject(baseObject[parent])) throw new Error("PROFILE_FORMAT_INVALID");
    }
    const mappings = {
      name: ["candidate", "full_name"], email: ["candidate", "email"], location: ["candidate", "location"],
      roles: ["target_roles", "primary"], compMin: ["compensation", "target_range"], compMax: ["compensation", "target_range"],
      currency: ["compensation", "currency"], remote: ["compensation", "location_flexibility"],
    };
    const targetRange = "compMin" in p ? `${p.compMin}-${p.compMax}` : null;
    for (const key of keys) {
      const value = key === "compMin" || key === "compMax" ? targetRange : key === "roles" ? p.roles.slice(0, 6) : p[key];
      setPath(merged, mappings[key], value);
    }
    const unchanged = isDeepStrictEqual(baseObject, merged);
    const proposedContent = unchanged ? base.content : dumpYaml(merged, { lineWidth: 100, noRefs: true });
    if (Buffer.byteLength(proposedContent, "utf8") > MAX_CV_BYTES) throw new Error("SOURCE_TOO_LARGE");
    const annotations = {};
    for (const key of keys) annotations[key] = await validateAnnotation(input.sourceAnnotations[key]);
    const diff = unchanged ? [] : [...new Set(keys.map(key => mappings[key].join(".")))].map(path => {
      const keysForPath = keys.filter(key => mappings[key].join(".") === path);
      const pathParts = path.split(".");
      return { path, before: pathValue(baseObject, pathParts) ?? null, after: pathValue(merged, pathParts) ?? null, fields: keysForPath, sourceAnnotations: keysForPath.map(key => annotations[key]) };
    });
    return { proposedContent, diff, sourceAnnotations: annotations, unchanged };
  }
  async function createProposal(source, input) {
    const targetPath = sourcePath(source);
    await ready();
    if (!input || typeof input !== "object" || input.source !== source || !UUID_RE.test(input.operationId ?? "")) throw new Error("INVALID_REQUEST");
    const kind = `source.preview.${source}`;
    const prior = await replay(input.operationId, kind, input);
    if (prior) return prior;
    const base = await read(targetPath);
    if (Buffer.byteLength(base.content, "utf8") > MAX_CV_BYTES) throw new Error("SOURCE_TOO_LARGE");
    const built = source === "cv" ? await buildCvProposal(input, base) : await buildProfileProposal(input, base);
    const createdAt = now().toISOString(), expiresAt = new Date(Date.parse(createdAt) + PROPOSAL_TTL_MS).toISOString();
    const proposal = {
      proposalId: input.operationId, source, status: built.unchanged || built.proposedContent === base.content ? "unchanged" : "preview",
      baseSha256: base.sha256, proposedSha256: sha(built.proposedContent), diff: built.diff,
      sourceAnnotations: built.sourceAnnotations, proposedContent: built.proposedContent,
      createdAt, expiresAt,
    };
    const result = { proposalId: proposal.proposalId, source, status: proposal.status, baseSha256: proposal.baseSha256, proposedSha256: proposal.proposedSha256, diff: proposal.diff, expiresAt };
    const proposalContent = JSON.stringify(proposal);
    if (Buffer.byteLength(proposalContent, "utf8") > MAX_RECORD_BYTES) throw new Error("SOURCE_RECORD_TOO_LARGE");
    return commit(input.operationId, kind, input, [{ path: `data/source-proposals/${input.operationId}.json`, old: null, content: proposalContent }], result);
  }
  async function getProposal(source, proposalId) {
    const targetPath = sourcePath(source);
    if (!UUID_RE.test(proposalId ?? "")) throw new Error("INVALID_PROPOSAL_ID");
    const row = await optional(`data/source-proposals/${proposalId}.json`);
    if (!row) throw new Error("PROPOSAL_NOT_FOUND");
    let proposal;
    try { proposal = JSON.parse(row.content); } catch { throw new Error("PROPOSAL_INVALID"); }
    if (proposal.source !== source || proposal.proposalId !== proposalId) throw new Error("PROPOSAL_NOT_FOUND");
    const expiresAt = Date.parse(proposal.expiresAt);
    if (!Number.isFinite(expiresAt) || !SHA_RE.test(proposal.baseSha256 ?? "") || !SHA_RE.test(proposal.proposedSha256 ?? "") || typeof proposal.proposedContent !== "string" || sha(proposal.proposedContent) !== proposal.proposedSha256) throw new Error("PROPOSAL_INVALID");
    const current = await read(targetPath);
    const { proposedContent, ...review } = proposal;
    return { ...review, status: expiresAt <= now().getTime() ? "expired" : current.sha256 !== proposal.baseSha256 ? "stale" : proposal.status };
  }
  async function ensureRevision(source, contentHash, content, documents) {
    const path = `data/source-revisions/${source}/${contentHash}.json`;
    const prior = await optional(path);
    if (prior) {
      let revision;
      try { revision = JSON.parse(prior.content); } catch { throw new Error("REVISION_INVALID"); }
      if (revision.source !== source || revision.sha256 !== contentHash || revision.content !== content || sha(revision.content) !== contentHash) throw new Error("REVISION_INTEGRITY_ERROR");
      return;
    }
    const revisionContent = JSON.stringify({ source, sha256: contentHash, content, createdAt: now().toISOString() });
    if (Buffer.byteLength(revisionContent, "utf8") > MAX_RECORD_BYTES) throw new Error("SOURCE_RECORD_TOO_LARGE");
    documents.push({ path, old: null, content: revisionContent });
  }
  async function applyProposal(source, input) {
    const targetPath = sourcePath(source);
    assertShape(input, new Set(["proposalId", "expectedSha256", "operationId", "confirm"]));
    if (!UUID_RE.test(input.operationId ?? "") || !UUID_RE.test(input.proposalId ?? "") || !SHA_RE.test(input.expectedSha256 ?? "")) throw new Error("INVALID_APPLY_REQUEST");
    if (input.confirm !== true) throw new Error("CONFIRMATION_REQUIRED");
    await ready();
    const kind = `source.apply.${source}`;
    const prior = await replay(input.operationId, kind, input);
    if (prior) return prior;
    const proposalRow = await optional(`data/source-proposals/${input.proposalId}.json`);
    if (!proposalRow) throw new Error("PROPOSAL_NOT_FOUND");
    let proposal;
    try { proposal = JSON.parse(proposalRow.content); } catch { throw new Error("PROPOSAL_INVALID"); }
    if (proposal.source !== source || proposal.proposalId !== input.proposalId) throw new Error("PROPOSAL_NOT_FOUND");
    const expiresAt = Date.parse(proposal.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error("PROPOSAL_INVALID");
    if (expiresAt <= now().getTime()) throw new Error("PROPOSAL_EXPIRED");
    if (proposal.baseSha256 !== input.expectedSha256 || !SHA_RE.test(proposal.proposedSha256 ?? "") || sha(proposal.proposedContent) !== proposal.proposedSha256) throw new Error("PROPOSAL_INVALID");
    const current = await read(targetPath);
    if (current.sha256 !== input.expectedSha256) throw new Error("SOURCE_STALE");
    const annotations = Array.isArray(proposal.sourceAnnotations) ? proposal.sourceAnnotations : Object.values(proposal.sourceAnnotations ?? {});
    for (const annotation of annotations) await validateAnnotation(annotation);
    const documents = [{ path: targetPath, old: current.sha256, content: proposal.proposedContent }];
    const oldSha = current.sha256, newSha = proposal.proposedSha256;
    await ensureRevision(source, oldSha, current.content, documents);
    if (newSha !== oldSha) await ensureRevision(source, newSha, proposal.proposedContent, documents);
    const createdAt = now().toISOString();
    const sourceAnnotationCount = Array.isArray(proposal.sourceAnnotations) ? proposal.sourceAnnotations.length : Object.keys(proposal.sourceAnnotations ?? {}).length;
    const receipt = {
      operationId: input.operationId, proposalId: proposal.proposalId, source,
      beforeSha256: oldSha, afterSha256: newSha, sourceAnnotations: proposal.sourceAnnotations,
      sourceAnnotationCount, createdAt, status: newSha === oldSha ? "unchanged" : "applied",
    };
    documents.push({ path: `data/source-receipts/${source}/${input.operationId}.json`, old: null, content: JSON.stringify(receipt) });
    return commit(input.operationId, kind, input, documents, {
      ok: true, status: receipt.status, operationId: input.operationId, proposalId: proposal.proposalId,
      source, beforeSha256: oldSha, afterSha256: newSha, receiptPath: `data/source-receipts/${source}/${input.operationId}.json`,
    });
  }
  async function listHistory(source, options = {}) {
    sourcePath(source);
    const limit = options.limit == null ? 50 : options.limit;
    const offset = options.offset == null ? 0 : options.offset;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > MAX_HISTORY_OFFSET) throw new Error("INVALID_HISTORY_QUERY");
    await ready();
    const rows = await sql.query(`SELECT path,updated_at,
      content::jsonb->>'operationId' AS operation_id,content::jsonb->>'proposalId' AS proposal_id,
      content::jsonb->>'source' AS source,content::jsonb->>'beforeSha256' AS before_sha256,
      content::jsonb->>'afterSha256' AS after_sha256,content::jsonb->>'status' AS status,
      content::jsonb->>'sourceAnnotationCount' AS annotation_count,
      content::jsonb->>'createdAt' AS created_at
      FROM career_ops_documents WHERE path LIKE $1 AND content_encoding='utf8' ORDER BY updated_at DESC,path ASC LIMIT $2 OFFSET $3`, [`data/source-receipts/${source}/%`, limit + 1, offset]);
    const hasMore = rows.length > limit;
    const history = rows.slice(0, limit).map(row => {
      if (row.source !== source || !UUID_RE.test(row.operation_id ?? "") || !UUID_RE.test(row.proposal_id ?? "") || !SHA_RE.test(row.before_sha256 ?? "") || !SHA_RE.test(row.after_sha256 ?? "") || !["applied", "unchanged"].includes(row.status) || !row.created_at || !Number.isInteger(Number(row.annotation_count)) || Number(row.annotation_count) < 0) throw new Error("RECEIPT_INVALID");
      return { operationId: row.operation_id, proposalId: row.proposal_id, source, beforeSha256: row.before_sha256, afterSha256: row.after_sha256, status: row.status, sourceAnnotationCount: Number(row.annotation_count), createdAt: row.created_at, updatedAt: row.updated_at };
    });
    const nextOffset = hasMore && offset + limit <= MAX_HISTORY_OFFSET ? offset + limit : null;
    return { history, pagination: { limit, offset, nextOffset } };
  }
  async function getRevision(source, contentHash) {
    sourcePath(source);
    if (!SHA_RE.test(contentHash ?? "")) throw new Error("INVALID_REVISION_SHA");
    const row = await optional(`data/source-revisions/${source}/${contentHash}.json`);
    if (!row) throw new Error("REVISION_NOT_FOUND");
    let revision;
    try { revision = JSON.parse(row.content); } catch { throw new Error("REVISION_INVALID"); }
    if (revision.source !== source || revision.sha256 !== contentHash || typeof revision.content !== "string" || sha(revision.content) !== contentHash) throw new Error("REVISION_INTEGRITY_ERROR");
    if (Buffer.byteLength(revision.content, "utf8") > MAX_CV_BYTES) throw new Error("SOURCE_TOO_LARGE");
    return { source, sha256: contentHash, content: revision.content, createdAt: revision.createdAt };
  }
  return {
    readSource: async source => {
      const row = await read(sourcePath(source));
      if (Buffer.byteLength(row.content, "utf8") > MAX_CV_BYTES) throw new Error("SOURCE_TOO_LARGE");
      return { source, content: row.content, sha256: row.sha256 };
    },
    createProposal, getProposal, applyProposal, listHistory, getRevision,
  };
}

let envStore;
export function createCloudSourceManagementFromEnv() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("CLOUD_DATA_UNAVAILABLE");
  if (!envStore) envStore = createCloudSourceManagement({ sql: neon(process.env.DATABASE_URL.trim()) });
  return envStore;
}

const STATUS = new Map([
  ["INVALID_SOURCE", 404], ["DOCUMENT_UNAVAILABLE", 404], ["SOURCE_NOT_FOUND", 404], ["PROPOSAL_NOT_FOUND", 404], ["REVISION_NOT_FOUND", 404],
  ["INVALID_REQUEST", 400], ["INVALID_SOURCE_ANNOTATION", 400], ["SOURCE_REFERENCE_INVALID", 400], ["SOURCE_REFERENCE_STALE", 409],
  ["INVALID_CV_PROPOSAL", 400], ["INVALID_CV_EDIT", 400], ["CV_EDIT_MATCH_NOT_UNIQUE", 422], ["SOURCE_TOO_LARGE", 413],
  ["INVALID_PROFILE_PATCH", 400], ["PROFILE_FORMAT_INVALID", 409], ["INVALID_PROPOSAL_ID", 400], ["PROPOSAL_INVALID", 409],
  ["INVALID_APPLY_REQUEST", 400], ["CONFIRMATION_REQUIRED", 400], ["PROPOSAL_EXPIRED", 409], ["SOURCE_STALE", 409],
  ["IDEMPOTENCY_KEY_CONFLICT", 409], ["WRITE_CONFLICT", 409], ["INVALID_REVISION_SHA", 400], ["REVISION_INVALID", 409],
  ["REVISION_INTEGRITY_ERROR", 409], ["DOCUMENT_HASH_MISMATCH", 503], ["RECEIPT_INVALID", 503], ["CLOUD_DATA_UNAVAILABLE", 503], ["INVALID_HISTORY_QUERY", 400],
  ["SOURCE_RECORD_TOO_LARGE", 413],
]);
function apiFailure(error) {
  const code = String(error?.message ?? "");
  const known = STATUS.has(code);
  return json({ error: { code: known ? code : "SOURCE_REQUEST_FAILED", message: known ? code.replaceAll("_", " ").toLowerCase() : "The source request could not be completed." } }, known ? STATUS.get(code) : 500);
}
function validSource(source) { return Object.hasOwn(SOURCE_PATHS, source); }
async function boundedJson(request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return { response: json({ error: { code: "JSON_REQUIRED", message: "Send a JSON request body." } }, 415) };
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return { response: json({ error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } }, 413) };
  if (!request.body) return { response: json({ error: { code: "INVALID_REQUEST", message: "A JSON body is required." } }, 400) };
  const reader = request.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); return { response: json({ error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } }, 413) }; }
      chunks.push(value);
    }
  } catch { return { response: json({ error: { code: "INVALID_REQUEST", message: "The request body could not be read." } }, 400) }; }
  finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch { return { response: json({ error: { code: "INVALID_REQUEST", message: "The request body must be valid JSON." } }, 400) }; }
}
function getService(options) { return (options.getService || createCloudSourceManagementFromEnv)(); }
export async function handleCloudSourceRead(source, options = {}) {
  if (!validSource(source)) return apiFailure(new Error("INVALID_SOURCE"));
  try { return json(await getService(options).readSource(source)); } catch (error) { return apiFailure(error); }
}
export async function handleCloudSourcePreview(request, source, options = {}) {
  if (!validSource(source)) return apiFailure(new Error("INVALID_SOURCE"));
  const parsed = await boundedJson(request); if (parsed.response) return parsed.response;
  try { return json(await getService(options).createProposal(source, parsed.value)); } catch (error) { return apiFailure(error); }
}
export async function handleCloudSourceProposalRead(source, proposalId, options = {}) {
  if (!validSource(source)) return apiFailure(new Error("INVALID_SOURCE"));
  try { return json(await getService(options).getProposal(source, proposalId)); } catch (error) { return apiFailure(error); }
}
export async function handleCloudSourceApply(request, source, options = {}) {
  if (!validSource(source)) return apiFailure(new Error("INVALID_SOURCE"));
  const parsed = await boundedJson(request); if (parsed.response) return parsed.response;
  try { return json(await getService(options).applyProposal(source, parsed.value)); } catch (error) { return apiFailure(error); }
}
export async function handleCloudSourceHistory(source, options = {}) {
  if (!validSource(source)) return apiFailure(new Error("INVALID_SOURCE"));
  try {
    const url = new URL(options.url ?? "https://career-ops.example/api/sources");
    const limitText = url.searchParams.get("limit"), offsetText = url.searchParams.get("offset");
    const limit = limitText == null ? undefined : Number(limitText), offset = offsetText == null ? undefined : Number(offsetText);
    if ([...url.searchParams.keys()].some(key => !["limit", "offset"].includes(key)) || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("offset").length > 1 || limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 100) || offset != null && (!Number.isInteger(offset) || offset < 0 || offset > 10_000)) throw new Error("INVALID_HISTORY_QUERY");
    return json({ source, ...(await getService(options).listHistory(source, { limit, offset })) });
  } catch (error) { return apiFailure(error); }
}
export async function handleCloudSourceRevision(source, revisionSha, options = {}) {
  if (!validSource(source)) return apiFailure(new Error("INVALID_SOURCE"));
  try { return json(await getService(options).getRevision(source, revisionSha)); } catch (error) { return apiFailure(error); }
}
