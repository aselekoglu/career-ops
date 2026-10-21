import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isAlias, isMap, isSeq, Pair, Scalar, YAMLMap, YAMLSeq, parseDocument } from "yaml";

const PATH = "portals.yml";
const MUTATIONS = "career_ops_tracker_mutations";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/i;
const MAX_DOCUMENT_BYTES = 512_000;
const MAX_BODY_BYTES = 16_384;
const MAX_ENTRIES = 2_000;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;
const COLLECTIONS = new Set(["tracked_companies", "job_boards"]);
const TRACKED_FIELDS = new Set(["name", "enabled", "careers_url", "api", "provider", "scan_method", "scan_query", "notes"]);
const BOARD_FIELDS = new Set([
  "name", "enabled", "careers_url", "api", "provider", "notes", "consider_board", "consider_size",
  "getro_collection", "getro_max_pages", "getro_max_age_days", "countryCode", "searchKeywords",
  "searchLocation", "pageSize", "maxPages", "siteKey", "cat_id",
]);
const SENSITIVE_QUERY_KEYS = new Set(["token", "accesstoken", "secret", "password", "passwd", "apikey", "accesskey", "authorization", "auth", "credential", "signature", "sig", "clientsecret", "clientid"]);
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const fingerprint = payload => sha(stableJson({ kind: "portals.command", payload }));

const ERROR_STATUS = new Map([
  ["INVALID_REQUEST", 400], ["JSON_REQUIRED", 415], ["INVALID_QUERY", 400], ["INVALID_LIMIT", 400], ["INVALID_OFFSET", 400],
  ["INVALID_OPERATION_ID", 400], ["INVALID_OPERATION", 400], ["INVALID_COLLECTION", 400], ["PORTAL_CONFIRMATION_REQUIRED", 400],
  ["PORTAL_INVALID_ENTRY", 400], ["PORTAL_INVALID_NAME", 400], ["PORTAL_INVALID_URL", 400], ["PORTAL_INVALID_PROVIDER", 400],
  ["PORTAL_INVALID_FIELD", 400], ["PORTAL_IDENTITY_IMMUTABLE", 400], ["PORTAL_UNSUPPORTED_ENABLED_PROVIDER", 422],
  ["PORTAL_ENTRY_NOT_FOUND", 404], ["PORTAL_ENTRY_AMBIGUOUS", 409], ["PORTAL_DUPLICATE_ENTRY", 409], ["PORTAL_SHARED_ALIAS_MUTATION", 409],
  ["PORTALS_FORMAT_INVALID", 409], ["PORTALS_DOCUMENT_TOO_LARGE", 413], ["IDEMPOTENCY_KEY_CONFLICT", 409],
  ["WRITE_CONFLICT", 409], ["DOCUMENT_UNAVAILABLE", 503], ["CLOUD_DATA_UNAVAILABLE", 503],
]);

function fail(error) {
  const candidate = typeof error?.message === "string" ? error.message : "PORTAL_REQUEST_FAILED";
  const code = ERROR_STATUS.has(candidate) ? candidate : "PORTAL_REQUEST_FAILED";
  return json({ code }, ERROR_STATUS.get(code) ?? 500);
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function collectionFields(collection) {
  if (collection === "tracked_companies") return TRACKED_FIELDS;
  if (collection === "job_boards") return BOARD_FIELDS;
  throw new Error("INVALID_COLLECTION");
}

function validateName(value, required = true) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error("PORTAL_INVALID_NAME");
  const name = value.trim();
  if (!name || name.length > 180 || /[\r\n\x00-\x1f\x7f-\x9f]/u.test(name)) throw new Error("PORTAL_INVALID_NAME");
  return name;
}

function isPrivateLiteral(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) return true;
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
  }
  if (family === 6) return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  return false;
}

function safeUrl(value, { allowSensitiveQuery = false } = {}) {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("PORTAL_INVALID_URL");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("PORTAL_INVALID_URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443") || !parsed.hostname.includes(".") || isPrivateLiteral(parsed.hostname)) throw new Error("PORTAL_INVALID_URL");
  const sensitive = [...parsed.searchParams.keys()].some(key => SENSITIVE_QUERY_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (sensitive && !allowSensitiveQuery) throw new Error("PORTAL_INVALID_URL");
  if (sensitive) for (const key of [...parsed.searchParams.keys()]) if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) parsed.searchParams.delete(key);
  return parsed.toString();
}

function visibleUrl(value) {
  if (typeof value !== "string") return { value: undefined, redacted: false };
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => SENSITIVE_QUERY_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")))) return { value: undefined, redacted: true };
    return { value: safeUrl(value), redacted: false };
  } catch { return { value: undefined, redacted: true }; }
}

function hostOf(value) {
  try { const url = new URL(value); return { host: url.hostname.toLowerCase(), path: url.pathname.toLowerCase() }; }
  catch { return null; }
}
const exactOrSubdomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function providerMatches(collection, entry) {
  if (!entry || typeof entry !== "object" || entry.parser || entry.provider === "local-parser") return false;
  const urls = [entry.api, entry.careers_url].filter(value => typeof value === "string").map(hostOf).filter(Boolean);
  const has = fn => urls.some(fn);
  const provider = entry.provider;
  if (collection === "tracked_companies" && !provider) {
    return has(({ host }) => host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host.endsWith(".greenhouse.io")) ||
      has(({ host }) => host === "jobs.lever.co") || has(({ host }) => host === "jobs.ashbyhq.com") ||
      has(({ host }) => host.endsWith(".myworkdayjobs.com"));
  }
  if (!provider) return false;
  if (provider === "greenhouse") return has(({ host }) => exactOrSubdomain(host, "greenhouse.io"));
  if (provider === "lever") return has(({ host }) => host === "jobs.lever.co" || host === "api.lever.co");
  if (provider === "ashby") return has(({ host }) => host === "jobs.ashbyhq.com" || host === "api.ashbyhq.com");
  if (provider === "workday") return has(({ host }) => host.endsWith(".myworkdayjobs.com"));
  if (collection !== "job_boards") return false;
  if (provider === "solidjobs") return has(({ host, path }) => host === "solid.jobs" && /^\/public-api\/offers\/(it|engineering|marketing|sales|hr|logistics|finances|other)$/.test(path));
  if (provider === "justjoin") return has(({ host, path }) => host === "justjoin.it" && path.startsWith("/job-offers/"));
  if (provider === "nofluffjobs") return has(({ host }) => host === "nofluffjobs.com" || host.endsWith(".nofluffjobs.com"));
  if (provider === "getro") return Number.isInteger(Number(entry.getro_collection)) && has(({ host }) => host.startsWith("jobs.") && host.split(".").length >= 3);
  if (provider === "consider") return Boolean(entry.consider_board) && has(({ host }) => host.startsWith("jobs.") && !host.endsWith(".ashbyhq.com"));
  if (provider === "jobstreet") return Boolean(entry.siteKey && entry.searchKeywords && entry.searchLocation) && has(({ host, path }) => new Set(["id.jobstreet.com", "www.jobstreet.com", "www.jobstreet.co.id", "jobstreet.com", "jobstreet.co.id", "sg.jobstreet.com", "my.jobstreet.com", "www.seek.com.au", "www.seek.co.nz"]).has(host) && path === "/api/jobsearch/v5/search");
  if (provider === "glints") return Boolean(entry.searchKeywords && entry.countryCode) && has(({ host, path }) => new Set(["glints.com", "www.glints.com", "glints.id"]).has(host) && path === "/api/v2-alc/graphql");
  if (provider === "joinup") return has(({ host }) => host === "joinup.ch");
  if (provider === "higheredjobs") return Number.isInteger(Number(entry.cat_id));
  return false;
}

function supportsCloudScan(collection, entry) {
  if (entry?.scan_method === "websearch" && typeof entry.scan_query === "string" && entry.scan_query.trim()) return false;
  return providerMatches(collection, entry);
}

function validateScalar(field, value) {
  if (value === null) {
    if (field === "name") throw new Error("PORTAL_INVALID_NAME");
    return null;
  }
  if (field === "name") return validateName(value);
  if (field === "enabled") {
    if (typeof value !== "boolean") throw new Error("PORTAL_INVALID_FIELD");
    return value;
  }
  if (field === "careers_url" || field === "api") return safeUrl(value);
  if (field === "provider") {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value) || value === "local-parser") throw new Error("PORTAL_INVALID_PROVIDER");
    return value;
  }
  if (["pageSize", "maxPages", "consider_size", "getro_max_pages", "getro_max_age_days", "cat_id", "getro_collection"].includes(field)) {
    const min = field === "getro_max_age_days" ? 0 : 1;
    const max = field === "pageSize" ? 100 : field === "maxPages" ? 20 : field === "consider_size" ? 2_000 :
      field === "getro_max_pages" ? 200 : field === "getro_max_age_days" ? 3_650 : field === "getro_collection" ? 999_999_999 : 100_000;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("PORTAL_INVALID_FIELD");
    return value;
  }
  if (field === "countryCode") {
    if (typeof value !== "string" || !/^(ID|SG|MY|VN)$/i.test(value)) throw new Error("PORTAL_INVALID_FIELD");
    return value.toUpperCase();
  }
  if (field === "siteKey") {
    if (typeof value !== "string" || !/^[A-Z]{2}-Main$/.test(value)) throw new Error("PORTAL_INVALID_FIELD");
    return value;
  }
  if (field === "scan_method") {
    if (value !== "websearch") throw new Error("PORTAL_INVALID_FIELD");
    return value;
  }
  if (typeof value !== "string" || value.length > (field === "scan_query" || field === "searchKeywords" ? 2_000 : field === "notes" ? 4_000 : 500) || /[\x00\r]/u.test(value)) throw new Error("PORTAL_INVALID_FIELD");
  if (["scan_query", "searchKeywords", "notes"].includes(field) && /(?:token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]/i.test(value)) throw new Error("PORTAL_INVALID_FIELD");
  return value.trim();
}

function validateEntry(collection, value, { adding = false } = {}) {
  const fields = collectionFields(collection);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) throw new Error("PORTAL_INVALID_ENTRY");
  const entry = {};
  for (const [field, raw] of Object.entries(value)) {
    if (adding && raw === null) throw new Error("PORTAL_INVALID_FIELD");
    entry[field] = validateScalar(field, raw);
  }
  if (adding && !entry.name) throw new Error("PORTAL_INVALID_NAME");
  if (entry.name !== undefined && !normalizeName(entry.name)) throw new Error("PORTAL_INVALID_NAME");
  if (entry.scan_method === "websearch" && !entry.scan_query && adding && entry.enabled !== false) throw new Error("PORTAL_INVALID_FIELD");
  return entry;
}

function parsePortals(content) {
  const doc = parseDocument(content, { uniqueKeys: true, strict: true, version: "1.2" });
  if (doc.errors?.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error("PORTALS_FORMAT_INVALID");
  try { doc.toJS({ maxAliasCount: 50 }); } catch { throw new Error("PORTALS_FORMAT_INVALID"); }
  return doc;
}

function getPair(map, key) {
  return map?.items?.find(pair => pair.key?.value === key) ?? null;
}

function getSequence(doc, collection, { create = false } = {}) {
  if (doc.contents === null && create) doc.contents = new YAMLMap();
  if (!isMap(doc.contents)) throw new Error("PORTALS_FORMAT_INVALID");
  const pair = getPair(doc.contents, collection);
  if (!pair) {
    if (!create) return null;
    const sequence = new YAMLSeq();
    doc.contents.items.push(new Pair(new Scalar(collection), sequence));
    return sequence;
  }
  if (!isSeq(pair.value)) throw new Error("PORTALS_FORMAT_INVALID");
  return pair.value;
}

function documentValue(doc) {
  try { return doc.toJS({ maxAliasCount: 50 }); }
  catch { throw new Error("PORTALS_FORMAT_INVALID"); }
}

function entriesFor(doc, collection) {
  const root = documentValue(doc) ?? {};
  const values = root[collection];
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > MAX_ENTRIES) throw new Error("PORTALS_FORMAT_INVALID");
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PORTALS_FORMAT_INVALID");
    const name = validateName(value.name);
    return { index, raw: value, name, key: normalizeName(name) };
  });
}

function projectEntry(collection, raw, ambiguous = false) {
  const fields = collectionFields(collection);
  const entry = {};
  const redactedFields = [];
  const hasOpaqueSettings = Object.keys(raw).some(key => !fields.has(key));
  for (const field of fields) {
    if (!Object.hasOwn(raw, field) || raw[field] === undefined || raw[field] === null) continue;
    if (field === "careers_url" || field === "api") {
      const projected = visibleUrl(raw[field]);
      if (projected.value !== undefined) entry[field] = projected.value;
      else if (projected.redacted) redactedFields.push(field);
    } else if (["name", "provider", "scan_method", "scan_query", "notes", "consider_board", "countryCode", "searchKeywords", "searchLocation", "siteKey"].includes(field) && typeof raw[field] === "string") {
      if (!["scan_query", "notes", "searchKeywords"].includes(field) || !/(?:token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]/i.test(raw[field])) entry[field] = raw[field];
      else redactedFields.push(field);
    } else if (["enabled"].includes(field) && typeof raw[field] === "boolean") entry[field] = raw[field];
    else if (typeof raw[field] === "number" && Number.isFinite(raw[field])) entry[field] = raw[field];
    else redactedFields.push(field);
  }
  entry.enabled = raw.enabled !== false;
  entry.handoffRequired = raw.scan_method === "websearch" && typeof raw.scan_query === "string" && Boolean(raw.scan_query.trim());
  entry.scanSupported = supportsCloudScan(collection, raw) && redactedFields.length === 0;
  entry.hasOpaqueSettings = hasOpaqueSettings || redactedFields.length > 0;
  if (redactedFields.length) entry.redactedFields = redactedFields;
  if (ambiguous) entry.identityAmbiguous = true;
  return entry;
}

function normalizedQuery(url, allowed) {
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new Error("INVALID_QUERY");
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) throw new Error("INVALID_QUERY");
}

function parsePage(url) {
  normalizedQuery(url, new Set(["collection", "limit", "offset"]));
  const collection = url.searchParams.get("collection");
  collectionFields(collection);
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 25;
  const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("INVALID_LIMIT");
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new Error("INVALID_OFFSET");
  return { collection, limit, offset };
}

function safeSelector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "name")) throw new Error("INVALID_REQUEST");
  const name = validateName(value.name);
  return { name, key: normalizeName(name) };
}

function mapAt(seq, index) {
  const node = seq?.items?.[index];
  if (!isMap(node)) throw new Error("PORTALS_FORMAT_INVALID");
  return node;
}

function collectYamlNodes(node, into = new Set()) {
  if (!node || typeof node !== "object" || into.has(node)) return into;
  into.add(node);
  if (isMap(node)) for (const pair of node.items) { collectYamlNodes(pair.key, into); collectYamlNodes(pair.value, into); }
  else if (isSeq(node)) for (const item of node.items) collectYamlNodes(item, into);
  return into;
}

function assertNoSharedAliases(doc, targets, ignoredAliasSites = new Set()) {
  const aliases = [];
  const visited = new Set();
  function visit(node, ancestors = []) {
    if (!node || typeof node !== "object") return;
    if (isAlias(node)) {
      let target;
      try { target = node.resolve(doc); } catch { throw new Error("PORTALS_FORMAT_INVALID"); }
      if (targets.has(target)) aliases.push(ancestors);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    const next = [...ancestors, node];
    if (isMap(node)) for (const pair of node.items) { visit(pair.key, next); visit(pair.value, next); }
    else if (isSeq(node)) for (const item of node.items) visit(item, next);
  }
  visit(doc.contents);
  if (aliases.some(ancestors => !ancestors.some(node => ignoredAliasSites.has(node)))) throw new Error("PORTAL_SHARED_ALIAS_MUTATION");
}

function assertNoAmbiguity(entries, key) {
  const matched = entries.filter(item => item.key === key);
  if (matched.length > 1) throw new Error("PORTAL_ENTRY_AMBIGUOUS");
  return matched[0] ?? null;
}

function validateMutationSupport(collection, raw, { adding = false, current = null, patch = null } = {}) {
  const hasParser = Boolean(raw?.parser || raw?.provider === "local-parser");
  if (hasParser && raw?.enabled !== false) throw new Error("PORTAL_UNSUPPORTED_ENABLED_PROVIDER");
  if (raw?.enabled === false) return;
  const support = supportsCloudScan(collection, raw);
  const changedRouting = !current || ["provider", "careers_url", "api", "scan_method", "scan_query", "getro_collection", "consider_board", "siteKey", "searchKeywords", "searchLocation", "countryCode", "cat_id"].some(key => patch && Object.hasOwn(patch, key));
  const enabling = adding || (patch && patch.enabled === true) || current?.enabled === false || changedRouting;
  if (enabling && !support) throw new Error("PORTAL_UNSUPPORTED_ENABLED_PROVIDER");
  if (collection === "job_boards") {
    if (raw.provider === "getro" && !Number.isInteger(Number(raw.getro_collection))) throw new Error("PORTAL_INVALID_FIELD");
    if (raw.provider === "consider" && !raw.consider_board) throw new Error("PORTAL_INVALID_FIELD");
    if (raw.provider === "jobstreet" && (!raw.api || !raw.siteKey || !raw.searchKeywords || !raw.searchLocation)) throw new Error("PORTAL_INVALID_FIELD");
    if (raw.provider === "glints" && (!raw.api || !raw.searchKeywords || !raw.countryCode)) throw new Error("PORTAL_INVALID_FIELD");
    if (raw.provider === "higheredjobs" && !Number.isInteger(Number(raw.cat_id))) throw new Error("PORTAL_INVALID_FIELD");
  }
  if (adding && raw.enabled === undefined) raw.enabled = true;
}

function validateSelectorForMutation(value) {
  const selector = safeSelector(value);
  return selector;
}

function setMapValue(doc, map, field, value) {
  if (value === null) map.delete(field);
  else map.set(field, doc.createNode(value));
}

function makeYamlContent(doc) {
  const text = doc.toString({ lineWidth: 0 });
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("PORTALS_DOCUMENT_TOO_LARGE");
  return text;
}

export function createCloudPortalManagement({ sql }) {
  let initialized;
  const ready = () => initialized ??= sql.query(`CREATE TABLE IF NOT EXISTS ${MUTATIONS} (id UUID PRIMARY KEY, payload_sha256 TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`, []);

  async function readDocument() {
    const row = (await sql.query(`SELECT path,CASE WHEN octet_length(content)<=${MAX_DOCUMENT_BYTES} THEN content ELSE NULL END AS content,sha256,content_encoding,octet_length(content)>${MAX_DOCUMENT_BYTES} AS too_large FROM career_ops_documents WHERE path=$1`, [PATH]))[0];
    if (!row) return null;
    if (row.too_large || row.content == null) throw new Error("PORTALS_DOCUMENT_TOO_LARGE");
    if (row.content_encoding !== "utf8" || typeof row.content !== "string" || typeof row.sha256 !== "string" || sha(row.content) !== row.sha256) throw new Error("DOCUMENT_UNAVAILABLE");
    return row;
  }

  async function replay(id, payload) {
    const prior = (await sql.query(`SELECT payload_sha256,result FROM ${MUTATIONS} WHERE id=$1`, [id]))[0];
    if (!prior) return null;
    const bodyHash = fingerprint(payload);
    if (prior.payload_sha256 !== bodyHash) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    return { ...prior.result, replayed: true };
  }

  async function commit(id, payload, oldSha, content, result) {
    const bodyHash = fingerprint(payload), nextSha = sha(content);
    const statement = `WITH gate AS MATERIALIZED (
      SELECT NOT EXISTS (SELECT 1 FROM career_ops_documents WHERE path=$3 AND sha256 IS DISTINCT FROM $7) AS ok
    ), marker AS (
      INSERT INTO ${MUTATIONS}(id,payload_sha256,result) SELECT $1,$2,$5::jsonb FROM gate WHERE ok
      ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
      RETURNING id,payload_sha256,result,(xmax=0) AS inserted
    ), writes AS (
      INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
      SELECT $3,$4,$6,'utf8',octet_length($4),now() FROM marker WHERE (SELECT sha256 FROM career_ops_documents WHERE path=$3) IS NOT DISTINCT FROM $7
      ON CONFLICT(path) DO UPDATE SET content=EXCLUDED.content,sha256=EXCLUDED.sha256,content_encoding='utf8',byte_size=EXCLUDED.byte_size,updated_at=now()
      WHERE career_ops_documents.sha256 IS NOT DISTINCT FROM $7 RETURNING path
    ), asserted AS MATERIALIZED (
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM marker) OR totals.written=1 THEN TRUE ELSE 1/(totals.written-totals.written)=1 END AS ok
      FROM (SELECT (SELECT count(*) FROM writes) AS written) totals
    ) SELECT COALESCE((SELECT payload_sha256 FROM marker),(SELECT payload_sha256 FROM ${MUTATIONS} WHERE id=$1)) AS stored_hash,
      COALESCE((SELECT result FROM marker),(SELECT result FROM ${MUTATIONS} WHERE id=$1)) AS stored_result,
      COALESCE((SELECT inserted FROM marker),FALSE) AS applied,(SELECT count(*) FROM writes) AS written,
      (SELECT ok FROM gate) AS gate_ok,(SELECT ok FROM asserted) AS write_ok`;
    let out;
    try { out = (await sql.query(statement, [id, bodyHash, PATH, content, JSON.stringify({ ...result, sha256: nextSha }), nextSha, oldSha]))[0]; }
    catch (error) { if (/division by zero/i.test(String(error?.message))) throw new Error("WRITE_CONFLICT"); throw error; }
    if (!out?.stored_hash) throw new Error("WRITE_CONFLICT");
    if (out.stored_hash !== bodyHash) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if (!out.applied) return { ...(out.stored_result ?? result), replayed: true };
    if (!out.gate_ok || Number(out.written) !== 1 || out.write_ok !== true) throw new Error("WRITE_CONFLICT");
    return { ...result, replayed: false, sha256: nextSha };
  }

  async function list(url) {
    const { collection, limit, offset } = parsePage(url);
    const docRow = await readDocument();
    if (!docRow) return { present: false, sha256: null, entries: [], pagination: { limit, offset, nextOffset: null } };
    const doc = parsePortals(docRow.content);
    const all = entriesFor(doc, collection);
    const counts = new Map();
    for (const item of all) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
    const slice = all.slice(offset, offset + limit);
    const entries = slice.map(item => projectEntry(collection, item.raw, counts.get(item.key) > 1));
    return { present: true, sha256: docRow.sha256, entries, pagination: { limit, offset, nextOffset: offset + slice.length < all.length ? offset + slice.length : null } };
  }

  async function get(url) {
    normalizedQuery(url, new Set(["collection", "name"]));
    if (url.searchParams.getAll("collection").length !== 1 || url.searchParams.getAll("name").length !== 1) throw new Error("INVALID_QUERY");
    const collection = url.searchParams.get("collection"), selector = safeSelector({ name: url.searchParams.get("name") });
    collectionFields(collection);
    const docRow = await readDocument();
    if (!docRow) throw new Error("PORTAL_ENTRY_NOT_FOUND");
    const doc = parsePortals(docRow.content), found = assertNoAmbiguity(entriesFor(doc, collection), selector.key);
    if (!found) throw new Error("PORTAL_ENTRY_NOT_FOUND");
    return { present: true, sha256: docRow.sha256, entry: projectEntry(collection, found.raw) };
  }

  async function mutate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_REQUEST");
    if (!UUID_RE.test(input.operationId ?? "")) throw new Error("INVALID_OPERATION_ID");
    if (!["add", "update", "delete"].includes(input.operation)) throw new Error("INVALID_OPERATION");
    if (input.confirm !== true) throw new Error("PORTAL_CONFIRMATION_REQUIRED");
    if (!COLLECTIONS.has(input.collection)) throw new Error("INVALID_COLLECTION");
    const allowed = new Set(["operationId", "operation", "collection", "expectedSha256", "confirm", ...(input.operation === "add" ? ["entry"] : ["selector"]), ...(input.operation === "update" ? ["entry"] : [])]);
    if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("INVALID_REQUEST");
    if (input.expectedSha256 !== null && (typeof input.expectedSha256 !== "string" || !SHA_RE.test(input.expectedSha256))) throw new Error("INVALID_REQUEST");
    if (input.operation !== "add" && input.expectedSha256 === null) throw new Error("INVALID_REQUEST");
    const payload = structuredClone(input);
    await ready();
    const previous = await replay(input.operationId, payload);
    if (previous) return previous;
    const docRow = await readDocument(), oldSha = docRow?.sha256 ?? null;
    if (oldSha !== input.expectedSha256) throw new Error("WRITE_CONFLICT");
    const doc = parsePortals(docRow?.content ?? "");
    const seq = getSequence(doc, input.collection, { create: input.operation === "add" });
    const entries = seq ? entriesFor(doc, input.collection) : [];
    let operationEntry = null;
    if (input.operation === "add") {
      const entry = validateEntry(input.collection, input.entry, { adding: true });
      if (assertNoAmbiguity(entries, normalizeName(entry.name))) throw new Error("PORTAL_DUPLICATE_ENTRY");
      validateMutationSupport(input.collection, entry, { adding: true });
      if (entry.enabled === undefined) entry.enabled = true;
      assertNoSharedAliases(doc, new Set([seq]));
      seq.items.push(doc.createNode(entry));
      operationEntry = entry;
    } else {
      const selector = validateSelectorForMutation(input.selector);
      const found = assertNoAmbiguity(entries, selector.key);
      if (!found) throw new Error("PORTAL_ENTRY_NOT_FOUND");
      const sequenceNodes = new Set([seq]);
      assertNoSharedAliases(doc, sequenceNodes);
      const map = mapAt(seq, found.index);
      if (input.operation === "delete") {
        const targetNodes = collectYamlNodes(map);
        assertNoSharedAliases(doc, targetNodes, targetNodes);
        seq.items.splice(found.index, 1);
      } else {
        assertNoSharedAliases(doc, new Set([map]), new Set([map]));
        const patch = validateEntry(input.collection, input.entry);
        if (patch.name !== undefined && normalizeName(patch.name) !== selector.key) throw new Error("PORTAL_IDENTITY_IMMUTABLE");
        const updated = { ...found.raw, ...patch, name: found.name };
        validateMutationSupport(input.collection, updated, { current: found.raw, patch });
        for (const [field, value] of Object.entries(patch)) {
          const oldValue = getPair(map, field)?.value;
          if (oldValue) {
            const oldNodes = collectYamlNodes(oldValue);
            assertNoSharedAliases(doc, oldNodes, oldNodes);
          }
          setMapValue(doc, map, field, value);
        }
        operationEntry = updated;
      }
    }
    const nextContent = makeYamlContent(doc);
    const returned = operationEntry ? projectEntry(input.collection, operationEntry) : null;
    const result = { ok: true, operation: input.operation, collection: input.collection, replayed: false, entry: returned };
    return commit(input.operationId, payload, oldSha, nextContent, result);
  }
  return { list, get, mutate };
}

let store;
function storeFromEnv() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("CLOUD_DATA_UNAVAILABLE");
  if (!store) store = createCloudPortalManagement({ sql: neon(process.env.DATABASE_URL) });
  return store;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) throw new Error("JSON_REQUIRED");
  if (!request.body) throw new Error("INVALID_REQUEST");
  const reader = request.body.getReader(), chunks = [];
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

export async function handleCloudPortal(request, operation) {
  try {
    const url = new URL(request.url);
    const body = operation === "mutate" ? await readJson(request) : null;
    const result = operation === "list" ? await storeFromEnv().list(url)
      : operation === "get" ? await storeFromEnv().get(url)
        : operation === "mutate" ? await storeFromEnv().mutate(body)
          : (() => { throw new Error("INVALID_REQUEST"); })();
    return json(result);
  } catch (error) { return fail(error); }
}
