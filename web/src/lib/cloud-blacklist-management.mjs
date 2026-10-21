import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import { normalizeTextKey } from "./core/normalize-text-key.mjs";

const PATH = "data/blacklist.md";
const TABLE = "career_ops_tracker_mutations";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/i;
const MAX_DOCUMENT_BYTES = 256_000;
const MAX_BODY_BYTES = 8_192;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;
const MAX_ENTRIES = 2_000;
const HEADER = "| Company | Since | Scope | Reason |";
const SEPARATOR = "|---------|-------|-------|--------|";
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const payloadFingerprint = payload => sha(stableJson({ kind: "blacklist.command", payload }));
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function fail(error) {
  const code = typeof error?.message === "string" ? error.message : "BLACKLIST_REQUEST_FAILED";
  const statuses = new Map([
    ["INVALID_REQUEST", 400], ["JSON_REQUIRED", 415], ["INVALID_QUERY", 400], ["INVALID_LIMIT", 400], ["INVALID_OFFSET", 400],
    ["INVALID_OPERATION_ID", 400], ["INVALID_OPERATION", 400], ["BLACKLIST_CONFIRMATION_REQUIRED", 400],
    ["BLACKLIST_INVALID_ENTRY", 400], ["BLACKLIST_INVALID_COMPANY", 400], ["BLACKLIST_INVALID_DATE", 400],
    ["BLACKLIST_INVALID_SCOPE", 400], ["BLACKLIST_IDENTITY_IMMUTABLE", 400], ["BLACKLIST_DUPLICATE_ENTRY", 409],
    ["BLACKLIST_ENTRY_NOT_FOUND", 404], ["BLACKLIST_FORMAT_INVALID", 409], ["BLACKLIST_DOCUMENT_TOO_LARGE", 413],
    ["IDEMPOTENCY_KEY_CONFLICT", 409], ["WRITE_CONFLICT", 409], ["DOCUMENT_UNAVAILABLE", 503],
    ["CLOUD_DATA_UNAVAILABLE", 503],
  ]);
  const safe = statuses.has(code) ? code : "BLACKLIST_REQUEST_FAILED";
  return json({ code: safe }, statuses.get(safe) ?? 500);
}

function assertShape(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error("INVALID_REQUEST");
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) throw new Error("JSON_REQUIRED");
  if (!request.body) throw new Error("INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("INVALID_REQUEST"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error("INVALID_REQUEST"); }
}

function parseLimitOffset(url) {
  for (const key of url.searchParams.keys()) if (!new Set(["limit", "offset"]).has(key)) throw new Error("INVALID_QUERY");
  for (const key of ["limit", "offset"]) if (url.searchParams.getAll(key).length > 1) throw new Error("INVALID_QUERY");
  const limitText = url.searchParams.get("limit");
  const offsetText = url.searchParams.get("offset");
  const limit = limitText === null ? 25 : Number(limitText);
  const offset = offsetText === null ? 0 : Number(offsetText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("INVALID_LIMIT");
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new Error("INVALID_OFFSET");
  return { limit, offset };
}

function cleanCell(value, required, max) {
  if (typeof value !== "string") throw new Error("BLACKLIST_INVALID_ENTRY");
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > max || /[|\r\n\x00-\x1f\x7f-\x9f]/u.test(cleaned)) throw new Error("BLACKLIST_INVALID_ENTRY");
  return cleaned;
}

function validateEntry(value) {
  assertShape(value, new Set(["company", "since", "scope", "reason"]));
  const company = cleanCell(value.company, true, 200);
  const since = value.since === undefined ? "" : cleanCell(value.since, false, 10);
  const reason = value.reason === undefined ? "" : cleanCell(value.reason, false, 2_000);
  if (since && !validDate(since)) throw new Error("BLACKLIST_INVALID_DATE");
  if (value.scope !== "company") throw new Error("BLACKLIST_INVALID_SCOPE");
  if (!normalizeTextKey(company)) throw new Error("BLACKLIST_INVALID_COMPANY");
  return { company, since, scope: "company", reason };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function keyFor(company, scope) {
  if (scope === "domain") return `domain:${String(company ?? "").trim().toLowerCase().replace(/\.$/, "")}`;
  return normalizeTextKey(company);
}

function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const parts = trimmed.split("|").map(part => part.trim());
  if (parts.at(-1) === "") parts.pop();
  parts.shift();
  return parts;
}

function tableState(content) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const row = cells(lines[i]);
    if (row && row.length >= 4 && row[0].toLowerCase() === "company" && row[1].toLowerCase() === "since" && row[2].toLowerCase() === "scope" && row[3].toLowerCase() === "reason") {
      if (row.length !== 4) throw new Error("BLACKLIST_FORMAT_INVALID");
      headerIndex = i; break;
    }
  }
  const rows = [];
  let tableEnd = headerIndex < 0 ? lines.length : headerIndex + 1;
  if (headerIndex >= 0) {
    let start = headerIndex + 1;
    if (lines[start] && /^\s*\|\s*:?-{2,}/.test(lines[start])) { tableEnd = ++start; }
    for (let i = start; i < lines.length; i++) {
      if (!lines[i].trim().startsWith("|")) break;
      const row = cells(lines[i]);
      if (row?.length >= 2 && row[0].toLowerCase() === "company" && row[1].toLowerCase() === "since") break;
      tableEnd = i + 1;
      if (row && row.length !== 4) throw new Error("BLACKLIST_FORMAT_INVALID");
      if (!row || row.length < 4 || /^[-: ]+$/.test(row[0])) continue;
      if (!row[0] || /^company$/i.test(row[0])) continue;
      const scope = row[2]?.toLowerCase() === "domain" ? "domain" : "company";
      rows.push({ index: i, entry: { company: row[0], since: row[1] ?? "", scope, reason: row[3] ?? "" } });
      if (rows.length > MAX_ENTRIES) throw new Error("BLACKLIST_DOCUMENT_TOO_LARGE");
    }
  }
  return { lines, headerIndex, tableEnd, rows };
}

function publicEntries(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = keyFor(row.entry.company, row.entry.scope);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row.entry);
  }
  return result;
}

function formatEntry(entry) {
  return `| ${entry.company} | ${entry.since} | ${entry.scope} | ${entry.reason} |`;
}

function serializeAdded(state, entry) {
  if (state.headerIndex < 0) {
    const prefix = state.lines.join("\n").replace(/\n*$/, "");
    return `${prefix ? `${prefix}\n\n` : ""}${HEADER}\n${SEPARATOR}\n${formatEntry(entry)}\n`;
  }
  let insertAt = state.tableEnd;
  if (!state.lines[state.headerIndex + 1]?.trim().startsWith("|")) {
    state.lines.splice(state.headerIndex + 1, 0, SEPARATOR);
    insertAt = state.headerIndex + 2;
  }
  state.lines.splice(insertAt, 0, formatEntry(entry));
  return state.lines.join("\n").replace(/\n*$/, "\n");
}

function findExact(state, selector) {
  const wanted = keyFor(selector.company, selector.scope);
  const rows = state.rows.filter(row => keyFor(row.entry.company, row.entry.scope) === wanted);
  if (rows.length > 1) throw new Error("BLACKLIST_FORMAT_INVALID");
  return rows[0] ?? null;
}

function validateSelector(value) {
  assertShape(value, new Set(["company", "scope"]));
  const company = cleanCell(value.company, true, 200);
  if (!normalizeTextKey(company)) throw new Error("BLACKLIST_INVALID_COMPANY");
  if (value.scope !== "company" && value.scope !== "domain") throw new Error("BLACKLIST_INVALID_SCOPE");
  return { company, scope: value.scope };
}

export function createCloudBlacklistManagement({ sql }) {
  let initialized;
  const ready = () => initialized ??= sql.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id UUID PRIMARY KEY, payload_sha256 TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`, []);
  async function readDocument() {
    const row = (await sql.query(`SELECT path,CASE WHEN octet_length(content)<=${MAX_DOCUMENT_BYTES} THEN content ELSE NULL END AS content,sha256,content_encoding,octet_length(content)>${MAX_DOCUMENT_BYTES} AS too_large FROM career_ops_documents WHERE path=$1`, [PATH]))[0];
    if (!row) return null;
    if (row.too_large || row.content == null) throw new Error("BLACKLIST_DOCUMENT_TOO_LARGE");
    if (row.content_encoding !== "utf8" || typeof row.content !== "string" || typeof row.sha256 !== "string" || sha(row.content) !== row.sha256) throw new Error("DOCUMENT_UNAVAILABLE");
    return row;
  }
  async function replay(id, payload) {
    const prior = (await sql.query(`SELECT payload_sha256,result FROM ${TABLE} WHERE id=$1`, [id]))[0];
    if (!prior) return null;
    const payloadHash = payloadFingerprint(payload);
    if (prior.payload_sha256 !== payloadHash) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    return { ...prior.result, replayed: true };
  }
  async function commit(id, payload, oldSha, content, result) {
    const payloadHash = payloadFingerprint(payload);
    const documentSha = sha(content);
    const statement = `WITH gate AS MATERIALIZED (
      SELECT NOT EXISTS (SELECT 1 FROM career_ops_documents WHERE path=$3 AND sha256 IS DISTINCT FROM $7) AS ok
    ), marker AS (
      INSERT INTO ${TABLE}(id,payload_sha256,result) SELECT $1,$2,$5::jsonb FROM gate WHERE ok
      ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
      RETURNING id,payload_sha256,result,(xmax=0) AS inserted
    ), writes AS (
      INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
      SELECT $3,$4,$6,'utf8',octet_length($4),now() FROM marker
      WHERE (SELECT sha256 FROM career_ops_documents WHERE path=$3) IS NOT DISTINCT FROM $7
      ON CONFLICT(path) DO UPDATE SET content=EXCLUDED.content,sha256=EXCLUDED.sha256,content_encoding='utf8',byte_size=EXCLUDED.byte_size,updated_at=now()
      WHERE career_ops_documents.sha256 IS NOT DISTINCT FROM $7
      RETURNING path
    ), asserted AS MATERIALIZED (
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM marker) OR totals.written=1 THEN TRUE ELSE 1/(totals.written-totals.written)=1 END AS ok
      FROM (SELECT (SELECT count(*) FROM writes) AS written) totals
    ) SELECT COALESCE((SELECT payload_sha256 FROM marker),(SELECT payload_sha256 FROM ${TABLE} WHERE id=$1)) AS stored_hash,
      COALESCE((SELECT result FROM marker),(SELECT result FROM ${TABLE} WHERE id=$1)) AS stored_result,
      COALESCE((SELECT inserted FROM marker),FALSE) AS applied,(SELECT count(*) FROM writes) AS written,
      (SELECT ok FROM gate) AS gate_ok,(SELECT ok FROM asserted) AS write_ok`;
    let out;
    try { out = (await sql.query(statement, [id, payloadHash, PATH, content, JSON.stringify({ ...result, sha256: documentSha }), documentSha, oldSha]))[0]; }
    catch (error) { if (/division by zero/i.test(String(error?.message))) throw new Error("WRITE_CONFLICT"); throw error; }
    if (!out?.stored_hash) throw new Error("WRITE_CONFLICT");
    if (out.stored_hash !== payloadHash) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if (!out.applied) return { ...(out.stored_result ?? result), replayed: true };
    if (!out.gate_ok || Number(out.written) !== 1 || out.write_ok !== true) throw new Error("WRITE_CONFLICT");
    return { ...result, replayed: false, sha256: documentSha };
  }
  async function list(url) {
    const { limit, offset } = parseLimitOffset(url);
    const doc = await readDocument();
    if (!doc) return { present: false, sha256: null, entries: [], pagination: { limit, offset, nextOffset: null } };
    const state = tableState(doc.content), entries = publicEntries(state.rows);
    const page = entries.slice(offset, offset + limit);
    return { present: true, sha256: doc.sha256, entries: page, pagination: { limit, offset, nextOffset: offset + page.length < entries.length ? offset + page.length : null } };
  }
  async function get(url) {
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => key !== "company" && key !== "scope") || url.searchParams.getAll("company").length !== 1 || url.searchParams.getAll("scope").length !== 1) throw new Error("INVALID_QUERY");
    const selector = validateSelector({ company: url.searchParams.get("company"), scope: url.searchParams.get("scope") });
    const doc = await readDocument();
    if (!doc) throw new Error("BLACKLIST_ENTRY_NOT_FOUND");
    const found = findExact(tableState(doc.content), selector);
    if (!found) throw new Error("BLACKLIST_ENTRY_NOT_FOUND");
    return { present: true, sha256: doc.sha256, entry: found.entry };
  }
  async function mutate(input) {
    const common = new Set(["operationId", "operation", "expectedSha256", "confirm"]);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_REQUEST");
    if (!UUID_RE.test(input.operationId ?? "")) throw new Error("INVALID_OPERATION_ID");
    if (!new Set(["add", "update", "delete"]).has(input.operation)) throw new Error("INVALID_OPERATION");
    if (input.confirm !== true) throw new Error("BLACKLIST_CONFIRMATION_REQUIRED");
    const allowed = new Set(common);
    if (input.operation === "add") allowed.add("entry");
    else allowed.add("selector");
    if (input.operation === "update") allowed.add("entry");
    assertShape(input, allowed);
    if (input.expectedSha256 !== null && (typeof input.expectedSha256 !== "string" || !SHA_RE.test(input.expectedSha256))) throw new Error("INVALID_REQUEST");
    if (input.operation !== "add" && input.expectedSha256 === null) throw new Error("INVALID_REQUEST");
    const payload = structuredClone(input);
    await ready();
    const prior = await replay(input.operationId, payload);
    if (prior) return prior;
    const doc = await readDocument();
    const actualSha = doc?.sha256 ?? null;
    if (actualSha !== input.expectedSha256) throw new Error("WRITE_CONFLICT");
    const content = doc?.content ?? "";
    const state = tableState(content);
    let nextContent, returnedEntry = null;
    if (input.operation === "add") {
      const entry = validateEntry(input.entry);
      if (state.rows.some(row => keyFor(row.entry.company, row.entry.scope) === keyFor(entry.company, "company"))) throw new Error("BLACKLIST_DUPLICATE_ENTRY");
      nextContent = serializeAdded(state, entry);
      returnedEntry = entry;
    } else {
      const selector = validateSelector(input.selector);
      if (selector.scope !== "company") throw new Error("BLACKLIST_INVALID_SCOPE");
      const found = findExact(state, selector);
      if (!found) throw new Error("BLACKLIST_ENTRY_NOT_FOUND");
      if (input.operation === "delete") {
        state.lines.splice(found.index, 1);
        nextContent = state.lines.join("\n").replace(/\n*$/, "\n");
      } else {
        const entry = validateEntry(input.entry);
        if (keyFor(entry.company, entry.scope) !== keyFor(selector.company, selector.scope)) throw new Error("BLACKLIST_IDENTITY_IMMUTABLE");
        if (state.rows.some(row => row.index !== found.index && keyFor(row.entry.company, row.entry.scope) === keyFor(entry.company, "company"))) throw new Error("BLACKLIST_DUPLICATE_ENTRY");
        state.lines[found.index] = `${state.lines[found.index].match(/^\s*/)?.[0] ?? ""}${formatEntry(entry)}`;
        nextContent = state.lines.join("\n").replace(/\n*$/, "\n");
        returnedEntry = entry;
      }
    }
    if (Buffer.byteLength(nextContent, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("BLACKLIST_DOCUMENT_TOO_LARGE");
    const result = { ok: true, operation: input.operation, replayed: false, sha256: sha(nextContent), entry: returnedEntry };
    return commit(input.operationId, payload, actualSha, nextContent, result);
  }
  return { list, get, mutate };
}

let store;
function storeFromEnv() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("CLOUD_DATA_UNAVAILABLE");
  if (!store) store = createCloudBlacklistManagement({ sql: neon(process.env.DATABASE_URL) });
  return store;
}

export async function handleCloudBlacklist(request, operation) {
  try {
    const url = new URL(request.url);
    const body = operation === "mutate" ? await readJson(request) : null;
    const data = operation === "list" ? await storeFromEnv().list(url)
      : operation === "get" ? await storeFromEnv().get(url)
        : operation === "mutate" ? await storeFromEnv().mutate(body)
          : (() => { throw new Error("INVALID_REQUEST"); })();
    return json(data);
  } catch (error) { return fail(error); }
}
