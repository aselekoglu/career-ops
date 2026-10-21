import { normalizeJobUrl } from "./job-import.mjs";
import { createHash } from "node:crypto";

const VERSION = 1;
export const TRACKER_TARGETS_PATH = "data/tracker-targets.json";
export const MAX_TRACKER_TARGETS_BYTES = 1_000_000;
export const MAX_TRACKER_TARGETS = 10_000;
export const MAX_LEGACY_REPORT_ROWS = 10_000;
const APP_NUMBER_RE = /^[1-9]\d{0,7}$/;
const TARGET_KEYS = new Set(["url", "company", "role"]);
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");
const trackerCell = value => String(value ?? "").replace(/[|\r\n]/g, " ").trim();

export function emptyTrackerTargets() {
  return { version: VERSION, targets: {} };
}

function validateTargetMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION ||
      Object.keys(value).some(key => !["version", "targets"].includes(key)) ||
      !value.targets || typeof value.targets !== "object" || Array.isArray(value.targets) || Object.keys(value.targets).length > MAX_TRACKER_TARGETS) {
    throw new Error("TRACKER_TARGETS_INVALID");
  }
  const seenUrls = new Set();
  for (const [applicationNumber, target] of Object.entries(value.targets)) {
    if (!APP_NUMBER_RE.test(applicationNumber) || !target || typeof target !== "object" || Array.isArray(target) ||
        Object.keys(target).some(key => !TARGET_KEYS.has(key)) || Object.keys(target).length !== TARGET_KEYS.size ||
        typeof target.company !== "string" || !target.company.trim() || target.company.length > 500 || target.company !== trackerCell(target.company) ||
        typeof target.role !== "string" || !target.role.trim() || target.role.length > 500 || target.role !== trackerCell(target.role) ||
        typeof target.url !== "string" || target.url.length > 2048 || target.url.includes("|")) {
      throw new Error("TRACKER_TARGETS_INVALID");
    }
    let canonical;
    try { canonical = normalizeJobUrl(target.url); } catch { throw new Error("TRACKER_TARGETS_INVALID"); }
    if (canonical !== target.url || seenUrls.has(canonical)) throw new Error("TRACKER_TARGETS_INVALID");
    seenUrls.add(canonical);
  }
  return value;
}

export function parseTrackerTargets(content) {
  if (content == null) return emptyTrackerTargets();
  if (typeof content === "string" && Buffer.byteLength(content, "utf8") > MAX_TRACKER_TARGETS_BYTES) throw new Error("TRACKER_TARGETS_TOO_LARGE");
  let parsed;
  try { parsed = typeof content === "string" ? JSON.parse(content) : content; }
  catch { throw new Error("TRACKER_TARGETS_INVALID"); }
  return validateTargetMap(parsed);
}

export function assertTargetUrlAvailable(targetMap, url, applicationNumber, legacyReportUrls = []) {
  const targets = validateTargetMap(targetMap);
  if (applicationNumber != null && !APP_NUMBER_RE.test(String(applicationNumber))) throw new Error("TRACKER_TARGET_APPLICATION_INVALID");
  let canonical;
  try { canonical = normalizeJobUrl(url); } catch { throw new Error("INVALID_URL"); }
  if (canonical.includes("|")) throw new Error("INVALID_URL");
  for (const [owner, target] of Object.entries(targets.targets)) {
    if (target.url === canonical && (applicationNumber == null || owner !== applicationNumber)) throw new Error("TRACKER_TARGET_URL_CONFLICT");
  }
  for (const report of legacyReportUrls) {
    const reportUrl = typeof report === "string" ? report : report?.url;
    const reportOwner = typeof report === "string" ? null : String(report?.applicationNumber ?? "");
    if (!reportUrl || applicationNumber != null && reportOwner === String(applicationNumber)) continue;
    try { if (normalizeJobUrl(reportUrl) === canonical) throw new Error("TRACKER_TARGET_URL_CONFLICT"); }
    catch (error) { if (error?.message === "TRACKER_TARGET_URL_CONFLICT") throw error; }
  }
  return canonical;
}

export function bindTrackerTarget(targetMap, input) {
  const current = validateTargetMap(targetMap);
  const applicationNumber = String(input?.applicationNumber ?? "");
  if (!APP_NUMBER_RE.test(applicationNumber) || typeof input.company !== "string" || !input.company.trim() || input.company.length > 500 ||
      typeof input.role !== "string" || !input.role.trim() || input.role.length > 500) throw new Error("TRACKER_TARGET_INVALID");
  const url = assertTargetUrlAvailable(current, input.url, applicationNumber);
  const company = trackerCell(input.company), role = trackerCell(input.role);
  const existing = current.targets[applicationNumber];
  if (existing && (existing.url !== url || existing.company !== company || existing.role !== role)) throw new Error("TRACKER_TARGET_IMMUTABLE");
  if (existing) return current;
  if (Object.keys(current.targets).length >= MAX_TRACKER_TARGETS) throw new Error("TRACKER_TARGETS_TOO_LARGE");
  return { version: VERSION, targets: { ...current.targets, [applicationNumber]: { url, company, role } } };
}

export function unbindTrackerTarget(targetMap, applicationNumber) {
  const current = validateTargetMap(targetMap);
  if (!APP_NUMBER_RE.test(String(applicationNumber ?? ""))) throw new Error("TRACKER_TARGET_APPLICATION_INVALID");
  if (!Object.hasOwn(current.targets, applicationNumber)) return current;
  const targets = { ...current.targets };
  delete targets[applicationNumber];
  return { version: VERSION, targets };
}

export function serializeTrackerTargets(targetMap) {
  const content = JSON.stringify(validateTargetMap(targetMap));
  if (Buffer.byteLength(content, "utf8") > MAX_TRACKER_TARGETS_BYTES) throw new Error("TRACKER_TARGETS_TOO_LARGE");
  return content;
}

export function readLegacyReportUrls(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_LEGACY_REPORT_ROWS) throw new Error("TRACKER_TARGET_REPORT_SCAN_TOO_LARGE");
  return rows.map(row => row?.url).filter(url => typeof url === "string" && url.length > 0);
}

export async function readTrackerTargets(sql) {
  const row = (await sql.query(`SELECT path,
    CASE WHEN octet_length(content)<=$2 THEN content ELSE NULL END AS content,
    sha256,content_encoding,octet_length(content)>$2 AS too_large
    FROM career_ops_documents WHERE path=$1 LIMIT 1`, [TRACKER_TARGETS_PATH, MAX_TRACKER_TARGETS_BYTES]))[0] ?? null;
  if (!row) return { document: null, targets: emptyTrackerTargets() };
  if (row.too_large || row.content == null) throw new Error("TRACKER_TARGETS_TOO_LARGE");
  if (row.content_encoding !== "utf8" || Buffer.byteLength(row.content, "utf8") > MAX_TRACKER_TARGETS_BYTES || sha(row.content) !== row.sha256) throw new Error("TRACKER_TARGETS_INVALID");
  return { document: row, targets: parseTrackerTargets(row.content) };
}

export function resolveTrackerTarget({ applicationNumber, application, reportUrl = null, targets }) {
  if (!APP_NUMBER_RE.test(String(applicationNumber ?? "")) || !application || String(application.n) !== applicationNumber) throw new Error("APPLICATION_NOT_FOUND");
  const map = validateTargetMap(targets);
  const bound = map.targets[applicationNumber];
  let canonicalReportUrl = null;
  if (reportUrl != null) {
    try { canonicalReportUrl = normalizeJobUrl(reportUrl); } catch { throw new Error("TRACKER_TARGET_REPORT_MISMATCH"); }
  }
  const hasReportReference = typeof application.report === "string" && application.report.trim().length > 0;
  if (bound) {
    if (bound.company !== application.company || bound.role !== application.role) throw new Error("TRACKER_TARGET_ROW_MISMATCH");
    if (hasReportReference && !canonicalReportUrl || canonicalReportUrl && canonicalReportUrl !== bound.url) throw new Error("TRACKER_TARGET_REPORT_MISMATCH");
    return { url: bound.url, company: bound.company, role: bound.role, source: "binding" };
  }
  if (hasReportReference && canonicalReportUrl) return { url: canonicalReportUrl, company: application.company, role: application.role, source: "report" };
  throw new Error("TRACKER_TARGET_NOT_FOUND");
}
