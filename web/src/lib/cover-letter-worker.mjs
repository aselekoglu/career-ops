import { createHash, timingSafeEqual } from 'node:crypto';

const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_PATH_RE = /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.md$/;
const MAX_PDF_BYTES = 8_000_000;
const MIN_PDF_BYTES = 500;
const fail = (code) => Object.assign(new Error(code), { code });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equalHash = (a, b) => typeof a === 'string' && typeof b === 'string' && HASH_RE.test(a) && HASH_RE.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

function validateBinding(binding) {
  return Boolean(binding && /^[1-9][0-9]{0,5}$/.test(binding.applicationNumber) &&
    /^[1-9][0-9]{0,5}$/.test(binding.reportNumber) && REPORT_PATH_RE.test(binding.reportPath || '') &&
    !binding.reportPath.includes('..') && HASH_RE.test(binding.reportSha256 || ''));
}

function validateReceipt(receipt, run) {
  if (!receipt || receipt.runId !== run.runId || receipt.applicationNumber !== run.binding.applicationNumber ||
      receipt.reportNumber !== run.binding.reportNumber || receipt.reportPath !== run.binding.reportPath ||
      receipt.reportSha256 !== run.binding.reportSha256 || receipt.approvedSha256 !== run.approvedSha256 ||
      receipt.contentType !== 'application/pdf' || !Number.isSafeInteger(receipt.byteSize) ||
      receipt.byteSize < MIN_PDF_BYTES || receipt.byteSize > MAX_PDF_BYTES || !HASH_RE.test(receipt.sha256 || '')) return false;
  return true;
}

/**
 * Isolated, injected rendering worker core. Store contract: get, getRenderIntent,
 * claimRenderIntent and completeRenderReceipt. Claiming is durable and has no
 * expiry/retry lease; ambiguous interrupted work requires owner intervention.
 * This core does not dispatch, access a filesystem, or contact external services.
 */
export function createCoverLetterRenderWorker({ authorize, store, render, now = () => new Date() } = {}) {
  if (typeof authorize !== 'function' || typeof render !== 'function' || !store ||
      ['get','getRenderIntent','claimRenderIntent','completeRenderReceipt'].some((method) => typeof store[method] !== 'function')) {
    throw fail('COVER_LETTER_WORKER_UNAVAILABLE');
  }

  return Object.freeze({
    async run({ request, runId } = {}) {
      let authorized = false;
      try { authorized = await authorize(request); } catch { authorized = false; }
      if (authorized !== true) throw fail('COVER_LETTER_WORKER_UNAUTHORIZED');
      if (typeof runId !== 'string' || !UUID_RE.test(runId)) throw fail('COVER_LETTER_WORKER_INPUT_INVALID');

      let run, intent;
      try { [run, intent] = await Promise.all([store.get(runId), store.getRenderIntent(runId)]); }
      catch { throw fail('COVER_LETTER_WORKER_STORE_UNAVAILABLE'); }
      if (!run || run.runId !== runId) throw fail('COVER_LETTER_WORKER_RUN_NOT_FOUND');
      if (!validateBinding(run.binding) || typeof run.draft !== 'string' || !run.draft ||
          !equalHash(sha256(Buffer.from(run.draft, 'utf8')), run.draftSha256) || !equalHash(run.approvedSha256, run.draftSha256)) {
        throw fail('COVER_LETTER_WORKER_RUN_NOT_APPROVED');
      }
      if (!intent || intent.runId !== runId || !equalHash(intent.approvedSha256, run.approvedSha256)) throw fail('COVER_LETTER_WORKER_INTENT_INVALID');

      // Completed state and receipt are durable outputs. Read them before the
      // pending-state gate so a replay can safely return without rendering.
      if (run.status === 'rendered' && intent.status === 'completed') {
        if (!validateReceipt(intent.receipt, run)) throw fail('COVER_LETTER_WORKER_RECEIPT_INVALID');
        return { status:'already_rendered', receipt:structuredClone(intent.receipt) };
      }
      if (run.status !== 'render_pending_dispatch' || intent.status !== 'pending_dispatch') throw fail('COVER_LETTER_WORKER_RUN_NOT_APPROVED');

      let claim;
      try { claim = await store.claimRenderIntent({ runId, expectedVersion:run.version, approvedSha256:run.approvedSha256, now:now().toISOString() }); }
      catch { throw fail('COVER_LETTER_WORKER_STORE_UNAVAILABLE'); }
      if (!claim) throw fail('COVER_LETTER_WORKER_STALE');
      if (claim.claimed !== true || claim.run?.runId !== runId || claim.run.status !== 'rendering' ||
          claim.run.version !== run.version + 1 || claim.intent?.status !== 'rendering' || !equalHash(claim.intent.approvedSha256, run.approvedSha256)) throw fail('COVER_LETTER_WORKER_STALE');

      let rendered;
      try { rendered = await render(Object.freeze({ runId, draft:run.draft, approvedSha256:run.approvedSha256, binding:Object.freeze({ ...run.binding }) })); }
      catch { throw fail('COVER_LETTER_WORKER_RENDER_FAILED'); }
      const pdf = Buffer.isBuffer(rendered) ? rendered : rendered instanceof Uint8Array ? Buffer.from(rendered) : null;
      if (!pdf || pdf.length < MIN_PDF_BYTES || pdf.length > MAX_PDF_BYTES || pdf.subarray(0,5).toString('ascii') !== '%PDF-') throw fail('COVER_LETTER_WORKER_PDF_INVALID');
      const receipt = Object.freeze({ runId, applicationNumber:run.binding.applicationNumber, reportNumber:run.binding.reportNumber,
        reportPath:run.binding.reportPath, reportSha256:run.binding.reportSha256, approvedSha256:run.approvedSha256,
        contentType:'application/pdf', byteSize:pdf.length, sha256:sha256(pdf) });
      let saved;
      try { saved = await store.completeRenderReceipt({ runId, expectedVersion:claim.run.version, approvedSha256:run.approvedSha256, receipt, pdf, now:now().toISOString() }); }
      catch { throw fail('COVER_LETTER_WORKER_STORE_UNAVAILABLE'); }
      if (!validateReceipt(saved, run) || !equalHash(saved.sha256, receipt.sha256)) throw fail('COVER_LETTER_WORKER_STALE');
      return { status:'rendered', receipt:structuredClone(saved) };
    },
  });
}
