import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createCoverLetterTargetResolver } from "../../src/lib/cover-letter-target.mjs";

const reportPath = "reports/073-example-systems-platform-engineer-2026-10-31.md";
const archivedJd = "Seeking a platform engineer to improve internal systems. " + "The role collaborates with product teams and improves reliable workflows. ".repeat(3);
const reportContent = `# Evaluation: Example Systems — Platform Engineer\n\n## A) Role Summary\nA role summary.\n\n## Job Description (archived verbatim)\n\n${archivedJd}\n`;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const makeResolver = (overrides = {}) => {
  const calls = [];
  const resolver = createCoverLetterTargetResolver({
    readTrackerApplication: async (applicationNumber) => ({ n: applicationNumber, company: "Example Systems", role: "Platform Engineer", report: "[73](../" + reportPath + ")" }),
    readReport: async (path) => { calls.push(path); return { path, content: reportContent, sha256: sha(reportContent) }; },
    readCanonicalCv: async () => "Verified experience with internal systems.",
    readCanonicalProfile: async () => "narrative:\n  headline: Evidence-led builder\n",
    ...overrides,
  });
  return { resolver, calls };
};

test("trusted cover-letter resolver returns exact linked report and canonical sources", async () => {
  const { resolver, calls } = makeResolver();
  const result = await resolver({ applicationNumber: "12", reportNumber: "73" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], reportPath);
  assert.equal(result.applicationNumber, "12");
  assert.equal(result.reportNumber, "73");
  assert.equal(result.reportPath, reportPath);
  assert.equal(result.reportContent, reportContent);
  assert.equal(result.reportSha256, sha(reportContent));
  assert.equal(result.company, "Example Systems");
  assert.equal(result.role, "Platform Engineer");
  assert.equal(result.sources.canonicalCv, "Verified experience with internal systems.");
  assert.equal(result.sources.canonicalProfile, "narrative:\n  headline: Evidence-led builder\n");
  assert.equal(result.sources.archivedJd, archivedJd.trim());
  assert.equal(result.sources.reportContent, reportContent);
});

test("trusted cover-letter resolver rejects mismatched application or report target", async () => {
  const wrongApp = makeResolver({ readTrackerApplication: async () => ({ n: "99", company: "Example Systems", role: "Platform Engineer", report: `[73](../${reportPath})` }) });
  assert.equal(await wrongApp.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
  const wrongReport = makeResolver({ readTrackerApplication: async (n) => ({ n, company: "Example Systems", role: "Platform Engineer", report: `[74](../${reportPath})` }) });
  assert.equal(await wrongReport.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
});

test("trusted cover-letter resolver rejects unsafe report paths without reading them", async () => {
  const { resolver, calls } = makeResolver({ readTrackerApplication: async (n) => ({ n, company: "Example Systems", role: "Platform Engineer", report: "[73](../../secret/073-evil.md)" }) });
  assert.equal(await resolver({ applicationNumber: "12", reportNumber: "73" }), null);
  assert.deepEqual(calls, []);
});

test("trusted cover-letter resolver rejects missing or insubstantive archived JD sections", async () => {
  const missing = makeResolver({ readReport: async (path) => ({ path, content: "# Evaluation: Example Systems — Platform Engineer\n\n## Summary\nNo archived JD.", sha256: sha("# Evaluation: Example Systems — Platform Engineer\n\n## Summary\nNo archived JD.") }) });
  assert.equal(await missing.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
  const shortReport = "# Evaluation: Example Systems — Platform Engineer\n\n## Job Description (archived verbatim)\nShort.";
  const shortArchive = makeResolver({ readReport: async (path) => ({ path, content: shortReport, sha256: sha(shortReport) }) });
  assert.equal(await shortArchive.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
});

test("trusted cover-letter resolver rejects stale report digests and read-path mismatches", async () => {
  const stale = makeResolver({ readReport: async (path) => ({ path, content: reportContent, sha256: "0".repeat(64) }) });
  assert.equal(await stale.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
  const changedPath = makeResolver({ readReport: async () => ({ path: "reports/074-other.md", content: reportContent, sha256: sha(reportContent) }) });
  assert.equal(await changedPath.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
});


test("trusted cover-letter resolver rejects company or role mismatches", async () => {
  const wrongCompany = makeResolver({ readTrackerApplication: async (n) => ({ n, company: "Other Systems", role: "Platform Engineer", report: `[73](../${reportPath})` }) });
  assert.equal(await wrongCompany.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
  const wrongRoleContent = reportContent.replace("Platform Engineer", "Security Engineer");
  const wrongRole = makeResolver({ readReport: async (path) => ({ path, content: wrongRoleContent, sha256: sha(wrongRoleContent) }) });
  assert.equal(await wrongRole.resolver({ applicationNumber: "12", reportNumber: "73" }), null);
});
