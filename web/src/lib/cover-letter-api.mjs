import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const APP_ID = /^[1-9][0-9]{0,5}$/;
const MAX_BODY_BYTES = 70_000;
const MAX_DRAFT_BYTES = 50_000;
const MAX_REPORT_BYTES = 2_000_000;
const REPORT_PATH = /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.md$/;
const SAFE_ERROR_STATUS = new Map([
  ['COVER_LETTER_INPUT_INVALID', 400], ['COVER_LETTER_BINDING_NOT_FOUND', 404],
  ['COVER_LETTER_IDEMPOTENCY_CONFLICT', 409], ['COVER_LETTER_RUN_NOT_FOUND', 404],
  ['COVER_LETTER_STATE_INVALID', 409], ['COVER_LETTER_DRAFT_CHANGED', 409],
  ['COVER_LETTER_BINDING_CHANGED', 409],
  ['COVER_LETTER_STATE_INVALID', 409],
  ['COVER_LETTER_RENDER_UNAVAILABLE', 503], ['COVER_LETTER_STORE_UNAVAILABLE', 503],
]);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const apiError = (code, status) => Object.assign(new Error(code), { code, status });
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

async function readJson(request, limit) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) throw apiError('INVALID_REQUEST', 415);
  if (!request.body) throw apiError('INVALID_REQUEST', 400);
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw apiError('REQUEST_TOO_LARGE', 413); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw apiError('INVALID_REQUEST', 400); }
}

function validateOperation(input) {
  if (typeof input.action !== 'string') throw apiError('INVALID_REQUEST', 400);
  switch (input.action) {
    case 'start':
      if (!exactKeys(input, ['action', 'operationId', 'applicationNumber', 'reportNumber', 'confirmedResearch', 'confirmedKeywords', 'gapDecisions', 'answers']) || !UUID.test(input.operationId) || !APP_ID.test(String(input.applicationNumber)) || !APP_ID.test(String(input.reportNumber))) throw apiError('INVALID_REQUEST', 400);
      break;
    case 'status':
      if (!exactKeys(input, ['action', 'runId']) || !UUID.test(input.runId)) throw apiError('INVALID_REQUEST', 400);
      break;
    case 'edit':
      if (!exactKeys(input, ['action', 'runId', 'expectedSha256', 'text']) || !UUID.test(input.runId) || !SHA.test(input.expectedSha256) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > MAX_DRAFT_BYTES) throw apiError('INVALID_REQUEST', 400);
      break;
    case 'approve':
      if (!exactKeys(input, ['action', 'runId', 'expectedSha256', 'confirm']) || !UUID.test(input.runId) || !SHA.test(input.expectedSha256) || input.confirm !== true) throw apiError('INVALID_REQUEST', 400);
      break;
    case 'cancel':
      if (!exactKeys(input, ['action', 'runId']) || !UUID.test(input.runId)) throw apiError('INVALID_REQUEST', 400);
      break;
    default: throw apiError('INVALID_REQUEST', 400);
  }
  return input;
}

/**
 * Create an authenticated JSON API adapter. `resolveTrustedStart` must load the
 * exact app/report and return source material; user-confirmed research,
 * keywords, gap decisions and answers arrive as validated request fields.
 * Source material must never be accepted from the client. Generation uses an
 * atomic durable claim. A claim remains `draft_generating` after a crash or
 * ambiguous model result; callers must inspect status and must not retry it.
 */
export function createCoverLetterApi({ service, authorizeOwner, resolveTrustedStart, generateDraft, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  if (!service || ['start', 'get', 'claimGeneration', 'saveDraft', 'editDraft', 'approve', 'cancel'].some((name) => typeof service[name] !== 'function') || typeof authorizeOwner !== 'function' || typeof resolveTrustedStart !== 'function' || typeof generateDraft !== 'function' || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 100_000) throw new TypeError('COVER_LETTER_API_NOT_CONFIGURED');
  return async function handle(request) {
    try {
      if (request.method !== 'POST') throw apiError('METHOD_NOT_ALLOWED', 405);
      let authorized = false;
      try { authorized = await authorizeOwner(request) === true; } catch { authorized = false; }
      if (!authorized) throw apiError('UNAUTHORIZED', 401);
      const input = validateOperation(await readJson(request, maxBodyBytes));
      if (input.action === 'start') {
        let trusted;
        try { trusted = await resolveTrustedStart({ applicationNumber: String(input.applicationNumber), reportNumber: String(input.reportNumber) }); }
        catch { throw apiError('START_UNAVAILABLE', 503); }
        if (!trusted || trusted.applicationNumber !== String(input.applicationNumber) || trusted.reportNumber !== String(input.reportNumber) || !trusted.sources) throw apiError('COVER_LETTER_BINDING_NOT_FOUND', 404);
        if (typeof trusted.reportPath !== 'string' || !REPORT_PATH.test(trusted.reportPath) || trusted.reportPath.includes('..') || !SHA.test(trusted.reportSha256 || '') || typeof trusted.reportContent !== 'string' || Buffer.byteLength(trusted.reportContent, 'utf8') > MAX_REPORT_BYTES || trusted.sources.reportContent !== trusted.reportContent || sha(trusted.reportContent) !== trusted.reportSha256) throw apiError('COVER_LETTER_BINDING_CHANGED', 409);
        const prerequisites = { confirmedResearch: input.confirmedResearch, confirmedKeywords: input.confirmedKeywords, gapDecisions: input.gapDecisions, answers: input.answers };
        const run = await service.start({ applicationNumber: String(input.applicationNumber), reportNumber: String(input.reportNumber), idempotencyKey: input.operationId, ...prerequisites });
        if (run.binding?.applicationNumber !== String(input.applicationNumber) || run.binding?.reportNumber !== String(input.reportNumber) || run.binding?.reportPath !== trusted.reportPath || run.binding?.reportSha256 !== trusted.reportSha256) throw apiError('COVER_LETTER_BINDING_CHANGED', 409);
        if (!['draft_pending', 'draft_generating'].includes(run.status)) return json({ run });
        const claim = await service.claimGeneration(run.runId);
        if (!claim.claimed) {
          const status = claim.run.status === 'draft_generating' ? 202 : 200;
          return json({ run: claim.run, generationStatus: claim.run.status === 'draft_generating' ? 'in_progress_or_unknown' : claim.run.status }, status);
        }
        const claimedRun = claim.run;
        let draft;
        try { draft = await generateDraft({ binding: claimedRun.binding, sources: trusted.sources, prerequisites }); }
        catch { throw apiError('GENERATION_STATUS_UNKNOWN', 503); }
        if (typeof draft !== 'string' || !draft.trim() || Buffer.byteLength(draft, 'utf8') > MAX_DRAFT_BYTES) throw apiError('DRAFT_UNAVAILABLE', 503);
        const saved = await service.saveDraft(run.runId, { text: draft, contentType: 'text/plain', expectedVersion: claimedRun.version });
        return json({ run: saved, draftSha256: sha(draft) }, 201);
      }
      if (input.action === 'status') return json({ run: await service.get(input.runId) });
      if (input.action === 'edit') return json({ run: await service.editDraft(input.runId, { expectedSha256: input.expectedSha256, text: input.text }) });
      if (input.action === 'approve') return json({ run: await service.approve(input.runId, { expectedSha256: input.expectedSha256 }) });
      return json({ run: await service.cancel(input.runId) });
    } catch (error) {
      const code = error?.code;
      const status = SAFE_ERROR_STATUS.get(code) || error?.status || 500;
      const safeCode = SAFE_ERROR_STATUS.has(code) || ['INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'METHOD_NOT_ALLOWED', 'UNAUTHORIZED', 'DRAFT_UNAVAILABLE', 'START_UNAVAILABLE', 'GENERATION_STATUS_UNKNOWN'].includes(code) ? code : 'COVER_LETTER_API_FAILED';
      return json({ error: safeCode }, status);
    }
  };
}
