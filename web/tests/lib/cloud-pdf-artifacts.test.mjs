import assert from "node:assert/strict";
import test from "node:test";

import {
  matchArtifactToApplication,
  prepareArtifactAssociation,
  validatePdfDocument,
} from "../../src/lib/cloud-pdf-artifacts.mjs";

const aliases = { "#": "num", date: "date", company: "company", role: "role", score: "score", status: "status", pdf: "pdf", report: "report", notes: "notes" };
const url = "https://careers-kinaxis.icims.com/jobs/35379/co-op-intern-forward-deployed-engineer/job";
const tracker = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|---|---|---|---|---|---|---|---|
| 52 | 2026-10-02 | Kinaxis | Co-op Intern | 4.2/5 | Evaluated | ❌ | [52](../reports/052-kinaxis-2026-10-02.md) | Keep this note |
| 53 | 2026-10-02 | Kinaxis | Other role | 3.0/5 | Applied | ❌ | [53](../reports/053-kinaxis-other.md) | Preserve this row |
`;
const app = { n: "52", company: "Kinaxis", role: "Co-op Intern", report: "[52](../reports/052-kinaxis-2026-10-02.md)" };
const report = `# Evaluation: Kinaxis\n\n**URL:** ${url}\n`;
const pdf = Buffer.from("%PDF-1.7\nvalid stored pdf payload".padEnd(600, "x"));
const artifact = {
  id: "451cd973-d7e2-4e76-b1fc-50c32771a9e9",
  state: "completed",
  artifact_path: "output/cv-kinaxis-forward-deployed-2026-10-02.pdf",
  format: "letter",
  request: { url },
};
const pdfDocument = {
  path: artifact.artifact_path,
  content: pdf.toString("base64"),
  content_encoding: "base64",
  byte_size: pdf.length,
  sha256: (await import("node:crypto")).createHash("sha256").update(pdf).digest("hex"),
};

test("validates canonical base64 PDF bytes against stored hash and size", () => {
  assert.equal(validatePdfDocument(pdfDocument).length, pdf.length);
  assert.throws(() => validatePdfDocument({ ...pdfDocument, sha256: "0".repeat(64) }), { message: "CV_ARTIFACT_INVALID" });
  assert.throws(() => validatePdfDocument({ ...pdfDocument, byte_size: pdf.length + 1 }), { message: "CV_ARTIFACT_INVALID" });
  assert.throws(() => validatePdfDocument({ ...pdfDocument, content: Buffer.from("not PDF".padEnd(600, "x")).toString("base64") }), { message: "CV_ARTIFACT_INVALID" });
  assert.throws(() => validatePdfDocument({ ...pdfDocument, content: "%%%" }), { message: "CV_ARTIFACT_INVALID" });
});

test("matches CV artifacts by exact report URL or the same explicitly selected application", () => {
  assert.equal(matchArtifactToApplication(artifact, app, report), true);
  assert.equal(matchArtifactToApplication({ ...artifact, request: { url: url + "?tracking=1" } }, app, report), false);
  assert.equal(matchArtifactToApplication({ ...artifact, request: { url: "https://other.example/job" } }, app, report), false);
  assert.equal(matchArtifactToApplication({ ...artifact, request: { applicationNumber: "52" } }, app, report), false);
  assert.equal(matchArtifactToApplication({ ...artifact, request: { applicationNumber: "52", reportUrl: url, reportPath: "reports/052-kinaxis-2026-10-02.md" } }, app, report), true);
  assert.equal(matchArtifactToApplication({ ...artifact, request: { applicationNumber: "53" } }, app, report), false);
});

test("prepares an exact application association while preserving unrelated tracker and pdf-index rows", () => {
  const result = prepareArtifactAssociation({
    run: artifact,
    app,
    reportContent: report,
    pdfDocument,
    trackerContent: tracker,
    trackerSha: "tracker-old",
    pdfIndexContent: "# report\tpdf\thtml\tformat\tdate\n51\toutput/old.pdf\toutput/old.html\tletter\t2026-10-01\n052\toutput/older.pdf\toutput/older.html\tletter\t2026-10-01\n",
    pdfIndexSha: "index-old",
    aliases,
    idempotencyKey: "associate:451cd973:52",
    completedAt: "2026-10-02T12:30:00.000Z",
  });
  assert.equal(result.applicationNumber, "52");
  assert.equal(result.reportPath, "reports/052-kinaxis-2026-10-02.md");
  assert.match(result.trackerContent, /\| 52 \|[^\n]*\| ✅ \|/);
  assert.match(result.trackerContent, /Keep this note/);
  assert.match(result.trackerContent, /Preserve this row/);
  assert.match(result.pdfIndexContent, /^51\toutput\/old\.pdf/m);
  assert.match(result.pdfIndexContent, /^052\toutput\/cv-kinaxis-forward-deployed-2026-10-02\.pdf\toutput\/cv-kinaxis-forward-deployed-2026-10-02\.html\tletter\t2026-10-02$/m);
  assert.doesNotMatch(result.pdfIndexContent, /^0*52\toutput\/older\.pdf/m);
  assert.equal(result.trackerSha, "tracker-old");
  assert.equal(result.pdfIndexSha, "index-old");
});

test("refuses company-only matches, mismatched URL identity, invalid PDFs, and ambiguous application numbers", () => {
  const prepare = (overrides = {}) => prepareArtifactAssociation({
    run: artifact, app, reportContent: report, pdfDocument, trackerContent: tracker, trackerSha: "t",
    pdfIndexContent: "", pdfIndexSha: null, aliases, idempotencyKey: "key-1", completedAt: "2026-10-02T12:30:00.000Z", ...overrides,
  });
  assert.throws(() => prepare({ run: { ...artifact, request: { url: "https://other.example/kinaxis" } } }), { message: "CV_ARTIFACT_IDENTITY_MISMATCH" });
  assert.throws(() => prepare({ pdfDocument: { ...pdfDocument, sha256: "bad" } }), { message: "CV_ARTIFACT_INVALID" });
  assert.throws(() => prepare({ trackerContent: tracker + tracker.split("\n").find(line => line.startsWith("| 52 |")) + "\n" }), { message: "CV_ARTIFACT_APPLICATION_AMBIGUOUS" });
  assert.equal(matchArtifactToApplication({ ...artifact, request: { url: "https://example.com/Kinaxis" } }, app, report), false);
});
