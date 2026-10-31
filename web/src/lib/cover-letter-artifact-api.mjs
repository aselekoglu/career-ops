import { createHash, timingSafeEqual } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_PATH_RE = /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.md$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const MIN_PDF_BYTES = 500;
const MAX_PDF_BYTES = 8_000_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameHash = (left, right) => typeof left === 'string' && typeof right === 'string' && HASH_RE.test(left) && HASH_RE.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

function errorResponse(code, status) {
  return Response.json({ error:code }, { status, headers:{ 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff' } });
}

function validArtifact(runId, artifact) {
  const receipt = artifact?.receipt;
  const pdf = Buffer.isBuffer(artifact?.pdf) ? artifact.pdf : artifact?.pdf instanceof Uint8Array ? Buffer.from(artifact.pdf) : null;
  if (!receipt || !pdf || receipt.runId !== runId || !UUID_RE.test(receipt.runId) ||
      !/^[1-9][0-9]{0,5}$/.test(receipt.applicationNumber || '') || !/^[1-9][0-9]{0,5}$/.test(receipt.reportNumber || '') ||
      !REPORT_PATH_RE.test(receipt.reportPath || '') || receipt.reportPath.includes('..') ||
      !HASH_RE.test(receipt.reportSha256 || '') || !HASH_RE.test(receipt.approvedSha256 || '') ||
      receipt.contentType !== 'application/pdf' || !Number.isSafeInteger(receipt.byteSize) ||
      receipt.byteSize < MIN_PDF_BYTES || receipt.byteSize > MAX_PDF_BYTES || pdf.length !== receipt.byteSize ||
      pdf.subarray(0, 5).toString('ascii') !== '%PDF-' || !sameHash(sha256(pdf), receipt.sha256)) return null;
  return { receipt, pdf };
}

/** Authenticated fixed-identifier artifact read. No caller path or URL is accepted. */
export function createCoverLetterArtifactApi({ authorize, store } = {}) {
  if (typeof authorize !== 'function' || !store || typeof store.getArtifact !== 'function') {
    throw Object.assign(new Error('COVER_LETTER_ARTIFACT_API_UNAVAILABLE'), { code:'COVER_LETTER_ARTIFACT_API_UNAVAILABLE' });
  }
  return Object.freeze({
    async handle(request, runId) {
      let authorized = false;
      try { authorized = await authorize(request); } catch { authorized = false; }
      if (authorized !== true) return errorResponse('COVER_LETTER_ARTIFACT_UNAUTHORIZED', 401);
      if (typeof runId !== 'string' || !UUID_RE.test(runId)) return errorResponse('COVER_LETTER_ARTIFACT_NOT_FOUND', 404);
      let artifact;
      try { artifact = await store.getArtifact(runId); }
      catch { return errorResponse('COVER_LETTER_ARTIFACT_UNAVAILABLE', 503); }
      if (!artifact) return errorResponse('COVER_LETTER_ARTIFACT_NOT_FOUND', 404);
      const verified = validArtifact(runId, artifact);
      if (!verified) return errorResponse('COVER_LETTER_ARTIFACT_INVALID', 503);
      const { receipt, pdf } = verified;
      return new Response(pdf, { status:200, headers:{
        'Content-Type':'application/pdf',
        'Content-Length':String(pdf.length),
        'Content-Disposition':`attachment; filename="cover-letter-${runId}.pdf"`,
        'Cache-Control':'private, no-store',
        'X-Content-Type-Options':'nosniff',
        'X-Cover-Letter-Run-Id':receipt.runId,
        'X-Cover-Letter-Application-Number':receipt.applicationNumber,
        'X-Cover-Letter-Report-Number':receipt.reportNumber,
        'X-Cover-Letter-Report-SHA256':receipt.reportSha256,
        'X-Cover-Letter-Approved-SHA256':receipt.approvedSha256,
        'X-Cover-Letter-PDF-SHA256':receipt.sha256,
      } });
    },
  });
}
