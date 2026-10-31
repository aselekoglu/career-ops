const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export function cvArtifactApiPath(runId) {
  return UUID_RE.test(String(runId || "")) ? `/api/cv-artifacts/${runId}` : null;
}

export function validateCvArtifactMetadata(value, runId) {
  if (!cvArtifactApiPath(runId)) return { ok: false, code: "invalid-id" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "invalid-metadata" };
  if (value.runId !== runId) return { ok: false, code: "run-mismatch" };
  if (value.status !== "completed") return { ok: false, code: "not-completed" };
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 500 || value.byteSize > 9_000_000 || !SHA256_RE.test(String(value.sha256 || ""))) {
    return { ok: false, code: "invalid-metadata" };
  }
  const downloadPath = `/api/cv-artifacts/${runId}/download`;
  if (value.downloadUrl !== undefined && value.downloadUrl !== downloadPath) {
    return { ok: false, code: "invalid-download-route" };
  }
  return { ok: true, runId, byteSize: value.byteSize, sha256: value.sha256, downloadPath };
}
