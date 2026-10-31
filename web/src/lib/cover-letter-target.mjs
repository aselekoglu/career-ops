import { createHash } from "node:crypto";

const APP_ID = /^[1-9][0-9]{0,5}$/;
const REPORT_ID = /^[1-9][0-9]{0,5}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPORT_LINK = /^\[(\d{1,6})\]\(((?:\.\.\/)?reports\/([A-Za-z0-9][A-Za-z0-9._-]{0,190}\.md))\)$/;
const REPORT_FILE = /^(\d{1,6})-[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.md$/;
const MAX_REPORT_BYTES = 2_000_000;
const MAX_CV_BYTES = 250_000;
const MAX_PROFILE_BYTES = 200_000;
const MAX_ARCHIVED_JD_BYTES = 1_000_000;
const MIN_ARCHIVED_JD_CHARS = 120;

const byteLength = (value) => Buffer.byteLength(value, "utf8");
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonicalRelativeReportPath = (cell) => {
  if (typeof cell !== "string") return null;
  const match = cell.trim().match(REPORT_LINK);
  if (!match) return null;
  const [, label, , filename] = match;
  const fileMatch = filename.match(REPORT_FILE);
  if (!fileMatch || Number.parseInt(label, 10) !== Number.parseInt(fileMatch[1], 10)) return null;
  return { labelNumber: String(Number.parseInt(label, 10)), path: `reports/${filename}`, filenameNumber: String(Number.parseInt(fileMatch[1], 10)) };
};

const normalizeIdentity = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") : "";

function reportIdentityMatches(reportContent, company, role) {
  const title = reportContent.split(/\r?\n/, 1)[0].match(/^# Evaluation:\s*(.*?)\s+[—–-]\s+(.*?)\s*$/);
  return Boolean(title && normalizeIdentity(title[1]) === normalizeIdentity(company) && normalizeIdentity(title[2]) === normalizeIdentity(role));
}

function extractSubstantiveArchivedJd(reportContent) {
  const lines = reportContent.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^## Job Description \(archived verbatim\)\s*$/.test(line.trim()));
  if (headingIndex < 0) return null;
  let end = headingIndex + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  const section = lines.slice(headingIndex + 1, end).join("\n").trim();
  if (section.length < MIN_ARCHIVED_JD_CHARS || byteLength(section) > MAX_ARCHIVED_JD_BYTES) return null;
  return section;
}

/**
 * Create a resolver around trusted read functions. The tracker reader returns
 * one exact row; the report reader receives only a validated relative path and
 * returns { path, content, sha256 }. No source text or paths are accepted from
 * the request beyond the application and report numbers.
 */
export function createCoverLetterTargetResolver({ readTrackerApplication, readReport, readCanonicalCv, readCanonicalProfile } = {}) {
  if ([readTrackerApplication, readReport, readCanonicalCv, readCanonicalProfile].some((read) => typeof read !== "function")) throw new TypeError("COVER_LETTER_TARGET_NOT_CONFIGURED");

  return async function resolveTrustedStart(request) {
    if (!request || typeof request !== "object" || !APP_ID.test(String(request.applicationNumber)) || !REPORT_ID.test(String(request.reportNumber))) return null;
    const applicationNumber = String(request.applicationNumber);
    const reportNumber = String(request.reportNumber);
    const row = await readTrackerApplication(applicationNumber);
    if (!row || String(row.n ?? row.applicationNumber ?? "") !== applicationNumber || typeof row.company !== "string" || !row.company.trim() || typeof row.role !== "string" || !row.role.trim()) return null;

    const linkedReport = canonicalRelativeReportPath(row.report);
    if (!linkedReport || linkedReport.labelNumber !== reportNumber || linkedReport.filenameNumber !== reportNumber) return null;

    const report = await readReport(linkedReport.path);
    if (!report || report.path !== linkedReport.path || typeof report.content !== "string" || byteLength(report.content) > MAX_REPORT_BYTES || !SHA256.test(report.sha256 || "") || sha256(report.content) !== report.sha256) return null;
    if (!reportIdentityMatches(report.content, row.company, row.role)) return null;
    const archivedJd = extractSubstantiveArchivedJd(report.content);
    if (!archivedJd) return null;

    const [canonicalCv, canonicalProfile] = await Promise.all([readCanonicalCv(), readCanonicalProfile()]);
    if (typeof canonicalCv !== "string" || !canonicalCv.trim() || byteLength(canonicalCv) > MAX_CV_BYTES || typeof canonicalProfile !== "string" || !canonicalProfile.trim() || byteLength(canonicalProfile) > MAX_PROFILE_BYTES) return null;

    return {
      applicationNumber,
      reportNumber,
      company: row.company.trim(),
      role: row.role.trim(),
      reportPath: linkedReport.path,
      reportContent: report.content,
      reportSha256: report.sha256,
      sources: {
        canonicalCv,
        canonicalProfile,
        archivedJd,
        reportContent: report.content,
      },
    };
  };
}
