import { createCloudTrackerManagementFromEnv } from "./cloud-tracker-management.mjs";
import { importPosting, importedPostingPath, normalizeJobUrl } from "./job-import.mjs";

const MAX_REQUEST_BYTES = 4096;
const MAX_URL_CHARS = 2048;
const MAX_SOURCE_CHARS = 500;
const SAFE_ERRORS = new Set([
  "INVALID_URL", "UNSUPPORTED_SCHEME", "PRIVATE_NETWORK_BLOCKED", "DNS_FAILED", "FETCH_FAILED",
  "FETCH_TIMEOUT", "FETCH_TOO_LARGE", "TOO_MANY_REDIRECTS", "POSTING_NOT_FOUND", "PARSE_FAILED",
  "DATABASE_WRITE_FAILED", "UPSTREAM_UNAVAILABLE",
]);
const ERROR_MESSAGES = {
  INVALID_URL: "Enter a valid public job posting URL.",
  UNSUPPORTED_SCHEME: "Use an HTTP or HTTPS job posting URL.",
  PRIVATE_NETWORK_BLOCKED: "The job posting URL must point to a public host.",
  DNS_FAILED: "The job posting host could not be resolved.",
  FETCH_FAILED: "The job posting could not be fetched.",
  FETCH_TIMEOUT: "The job posting request timed out.",
  FETCH_TOO_LARGE: "The job posting is too large to import.",
  TOO_MANY_REDIRECTS: "The job posting redirected too many times.",
  POSTING_NOT_FOUND: "No active job posting was found at that URL.",
  PARSE_FAILED: "The page did not contain complete job posting details.",
  DATABASE_WRITE_FAILED: "The imported posting could not be saved.",
  UPSTREAM_UNAVAILABLE: "The job import service is not available.",
};
const ERROR_STATUS = {
  INVALID_URL: 400, UNSUPPORTED_SCHEME: 400, PRIVATE_NETWORK_BLOCKED: 400,
  FETCH_TIMEOUT: 504, FETCH_TOO_LARGE: 413, TOO_MANY_REDIRECTS: 502,
  POSTING_NOT_FOUND: 404, PARSE_FAILED: 422,
  DATABASE_WRITE_FAILED: 503, UPSTREAM_UNAVAILABLE: 503,
};

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(code, originalUrl) {
  const safeCode = SAFE_ERRORS.has(code) ? code : "UPSTREAM_UNAVAILABLE";
  return json({
    status: "failed",
    ...(typeof originalUrl === "string" ? { originalUrl } : {}),
    error: { code: safeCode, message: ERROR_MESSAGES[safeCode] },
  }, ERROR_STATUS[safeCode] ?? 502);
}

async function readJsonBody(request) {
  const mime = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mime !== "application/json") return { response: json({ status: "failed", error: { code: "JSON_REQUIRED", message: "Send a JSON request body." } }, 415) };
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    return { response: json({ status: "failed", error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } }, 413) };
  }
  if (!request.body) return { response: json({ status: "failed", error: { code: "INVALID_REQUEST", message: "Provide a job posting URL." } }, 400) };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { response: json({ status: "failed", error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } }, 413) };
      }
      chunks.push(value);
    }
  } catch {
    return { response: json({ status: "failed", error: { code: "INVALID_REQUEST", message: "The request body could not be read." } }, 400) };
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { response: json({ status: "failed", error: { code: "INVALID_REQUEST", message: "The request body must be valid JSON." } }, 400) };
  }
}

function validateBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["url", "source", "forceRefresh"].includes(key))) return false;
  if (typeof value.url !== "string" || value.url.length < 8 || value.url.length > MAX_URL_CHARS) return false;
  if (value.source !== undefined && (typeof value.source !== "string" || value.source.length > MAX_SOURCE_CHARS)) return false;
  if (value.forceRefresh !== undefined && typeof value.forceRefresh !== "boolean") return false;
  return true;
}

/** Read one imported sidecar only when it describes this exact canonical URL. */
export async function readStoredJobDescription(url, readDocument, maxChars = 24_000) {
  if (typeof url !== "string" || typeof readDocument !== "function") return null;
  let document;
  try { document = await readDocument(importedPostingPath(url)); } catch { return null; }
  if (!document || (document.content_encoding && document.content_encoding !== "utf8") || typeof document.content !== "string") return null;
  try {
    const record = JSON.parse(document.content);
    const jobDescription = record?.jobDescription;
    if (record?.normalizedUrl !== url || typeof jobDescription !== "string") return null;
    const trimmed = jobDescription.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxChars);
  } catch {
    return null;
  }
}

/** Use exact-URL stored evidence when safe; otherwise preserve the existing fetch path. */
export async function loadJobDescription(url, { readDocument, fetchFallback, maxChars = 24_000 }) {
  const imported = await readStoredJobDescription(url, readDocument, maxChars);
  return imported ?? fetchFallback(url);
}

/** @param {Request} request */
export async function handleJobImportRequest(request, options = {}) {
  const parsed = await readJsonBody(request);
  if (parsed.response) return parsed.response;
  const input = parsed.value;
  const originalUrl = input && typeof input === "object" && typeof input.url === "string" ? input.url : undefined;
  if (!validateBody(input)) return json({ status: "failed", ...(originalUrl ? { originalUrl } : {}), error: { code: "INVALID_REQUEST", message: "Provide a URL, an optional source, and an optional boolean forceRefresh." } }, 400);

  let normalizedUrl;
  try { normalizedUrl = normalizeJobUrl(input.url); }
  catch (error) { return failure(error?.message, input.url); }

  let store;
  try {
    store = (options.getStore || getCloudStore)();
  } catch (error) {
    const code = error?.message === "JOB_IMPORT_STORAGE_UNAVAILABLE" ? "UPSTREAM_UNAVAILABLE" : "DATABASE_WRITE_FAILED";
    return failure(code, input.url);
  }

  let existing;
  try {
    existing = await store.findImport({ originalUrl: input.url, normalizedUrl, source: input.source, forceRefresh: input.forceRefresh === true });
  } catch {
    return failure("DATABASE_WRITE_FAILED", input.url);
  }
  if (existing) return json(existing);

  let imported;
  try { imported = await (options.importFn || importPosting)(input.url, { source: input.source }); }
  catch { return failure("FETCH_FAILED", input.url); }
  if (!imported?.ok) return failure(imported?.error, input.url);

  try {
    const result = await store.importPosting({
      ...imported,
      originalUrl: input.url,
      requestedNormalizedUrl: imported.requestedNormalizedUrl || normalizedUrl,
      source: input.source,
      forceRefresh: input.forceRefresh === true,
    });
    return json(result);
  } catch (error) {
    const code = error?.message === "UPSTREAM_UNAVAILABLE" ? "UPSTREAM_UNAVAILABLE" : "DATABASE_WRITE_FAILED";
    return failure(code, input.url);
  }
}

function getCloudStore() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("JOB_IMPORT_STORAGE_UNAVAILABLE");
  return createCloudTrackerManagementFromEnv();
}
