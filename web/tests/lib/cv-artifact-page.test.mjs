import test from "node:test";
import assert from "node:assert/strict";
import { cvArtifactApiPath, validateCvArtifactMetadata } from "../../src/lib/cv-artifact-page.mjs";

const id = "55555555-5555-4555-8555-555555555555";
const metadata = { runId: id, status: "completed", byteSize: 1200, sha256: "a".repeat(64) };

test("only canonical UUIDs produce a fixed metadata endpoint", () => {
  assert.equal(cvArtifactApiPath(id), `/api/cv-artifacts/${id}`);
  for (const invalid of ["", "../download", "not-a-uuid", `${id}/download`]) {
    assert.equal(cvArtifactApiPath(invalid), null);
  }
});

test("accepts completed metadata bound to the exact run and creates its fixed download path", () => {
  assert.deepEqual(validateCvArtifactMetadata(metadata, id), {
    ok: true, runId: id, byteSize: 1200, sha256: "a".repeat(64),
    downloadPath: `/api/cv-artifacts/${id}/download`,
  });
});

test("rejects non-completed, wrong-run, or incomplete metadata", () => {
  assert.equal(validateCvArtifactMetadata(null, id).ok, false);
  assert.equal(validateCvArtifactMetadata({ ...metadata, status: "running" }, id).code, "not-completed");
  assert.equal(validateCvArtifactMetadata({ ...metadata, runId: "66666666-6666-4666-8666-666666666666" }, id).code, "run-mismatch");
  assert.equal(validateCvArtifactMetadata({ ...metadata, sha256: "bad" }, id).code, "invalid-metadata");
  assert.equal(validateCvArtifactMetadata({ ...metadata, byteSize: null }, id).code, "invalid-metadata");
  assert.equal(validateCvArtifactMetadata({ ...metadata, byteSize: 9_000_001 }, id).code, "invalid-metadata");
});

test("rejects metadata that attempts to redirect download away from the fixed route", () => {
  for (const downloadUrl of ["https://evil.example/file.pdf", "//evil.example/file.pdf", "/other/path"]) {
    assert.equal(validateCvArtifactMetadata({ ...metadata, downloadUrl }, id).code, "invalid-download-route");
  }
});
