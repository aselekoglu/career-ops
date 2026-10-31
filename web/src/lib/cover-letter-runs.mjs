import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const NUMBER_ID = /^[1-9][0-9]{0,5}$/;
const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_PATH = /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.md$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_DRAFT_BYTES = 50_000;
const SAFE_ERRORS = new Set(['COVER_LETTER_INPUT_INVALID', 'COVER_LETTER_BINDING_NOT_FOUND', 'COVER_LETTER_IDEMPOTENCY_CONFLICT', 'COVER_LETTER_RUN_NOT_FOUND', 'COVER_LETTER_STATE_INVALID', 'COVER_LETTER_DRAFT_CHANGED', 'COVER_LETTER_RENDER_UNAVAILABLE', 'COVER_LETTER_STORE_UNAVAILABLE']);
const error = (code) => Object.assign(new Error(code), { code });
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const sameHash = (left, right) => typeof left === 'string' && typeof right === 'string' && HASH.test(left) && HASH.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const clone = (row) => ({ runId: row.runId, status: row.status, binding: { ...row.binding }, draft: row.draft, draftSha256: row.draftSha256, approvedSha256: row.approvedSha256 ?? null, renderIntentStatus: row.renderIntentStatus ?? null, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt });

function validStart(input) {
  const allowed = new Set(['applicationNumber', 'reportNumber', 'idempotencyKey', 'confirmedResearch', 'confirmedKeywords', 'gapDecisions', 'answers']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key)) || !NUMBER_ID.test(String(input.applicationNumber)) || !NUMBER_ID.test(String(input.reportNumber)) || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) throw error('COVER_LETTER_INPUT_INVALID');
  const { confirmedResearch: research, confirmedKeywords: keywords, gapDecisions: gaps, answers } = input;
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
  const validText = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
  if (!exactKeys(research, ['confirmed', 'text']) || research.confirmed !== true || !validText(research.text, 4_000) || !exactKeys(keywords, ['confirmed', 'items']) || keywords.confirmed !== true || !Array.isArray(keywords.items) || keywords.items.length < 8 || keywords.items.length > 10 || keywords.items.some((item) => !validText(item, 120)) || !Array.isArray(gaps) || gaps.length > 30 || gaps.some((item) => (!exactKeys(item, ['gap', 'decision']) && !exactKeys(item, ['gap', 'decision', 'text'])) || !validText(item.gap, 160) || !['address', 'omit', 'user-angle', 'not-applicable'].includes(item.decision) || item.text !== undefined && !validText(item.text, 500) || item.decision === 'user-angle' && !validText(item.text, 500)) || !exactKeys(answers, ['whyThisRole', 'problemToSolve', 'approach', 'tone']) || ['whyThisRole', 'problemToSolve', 'approach'].some((key) => !validText(answers[key], 2_000)) || !['formal', 'direct', 'conversational', 'mirror-jd'].includes(answers.tone)) throw error('COVER_LETTER_INPUT_INVALID');
  return structuredClone(input);
}

/**
 * Store contract: resolveBinding, createIfAbsent, get, update, claimGeneration,
 * and approveAndEnqueue.
 * approveAndEnqueue must atomically compare run version/state/draft hash, record
 * approvedSha256, transition to render_pending_dispatch, and persist a durable
 * outbox intent. Dispatch is deliberately outside this service.
 */
export function createCoverLetterRunService({ store, now = () => new Date() } = {}) {
  if (!store || ['resolveBinding', 'createIfAbsent', 'get', 'update', 'claimGeneration', 'approveAndEnqueue'].some((method) => typeof store[method] !== 'function')) throw error('COVER_LETTER_STORE_UNAVAILABLE');
  async function get(runId) {
    if (typeof runId !== 'string' || !RUN_UUID.test(runId)) throw error('COVER_LETTER_RUN_NOT_FOUND');
    const row = await store.get(runId);
    if (!row) throw error('COVER_LETTER_RUN_NOT_FOUND');
    return clone(row);
  }
  async function change(runId, predicate, patch) {
    const row = await store.get(runId);
    if (!row) throw error('COVER_LETTER_RUN_NOT_FOUND');
    if (!predicate(row)) throw error('COVER_LETTER_STATE_INVALID');
    const updated = await store.update(runId, row.version, { ...patch, updatedAt: now().toISOString() });
    if (!updated) throw error('COVER_LETTER_DRAFT_CHANGED');
    return clone(updated);
  }
  async function start(raw) {
    const input = validStart(raw);
    const binding = await store.resolveBinding(input.applicationNumber, input.reportNumber);
    if (!binding || binding.applicationNumber !== input.applicationNumber || binding.reportNumber !== input.reportNumber || !REPORT_PATH.test(binding.reportPath || '') || binding.reportPath.includes('..') || !HASH.test(binding.reportSha256 || '')) throw error('COVER_LETTER_BINDING_NOT_FOUND');
    const stamped = now().toISOString();
    const requestFingerprint = hash(stableStringify(input));
    const row = await store.createIfAbsent({ runId: randomUUID(), requestFingerprint, idempotencyKey: input.idempotencyKey, status: 'draft_pending', binding: Object.freeze({ applicationNumber: binding.applicationNumber, reportNumber: binding.reportNumber, reportPath: binding.reportPath, reportSha256: binding.reportSha256, company: binding.company, role: binding.role }), prerequisites: { confirmedResearch: input.confirmedResearch, confirmedKeywords: input.confirmedKeywords, gapDecisions: input.gapDecisions, answers: input.answers }, draft: null, draftSha256: null, approvedSha256: null, renderIntentStatus: null, version: 1, createdAt: stamped, updatedAt: stamped });
    if (!row || row.idempotencyKey !== input.idempotencyKey || row.requestFingerprint !== requestFingerprint || row.binding.applicationNumber !== input.applicationNumber || row.binding.reportNumber !== input.reportNumber) throw error('COVER_LETTER_IDEMPOTENCY_CONFLICT');
    return clone(row);
  }
  async function claimGeneration(runId) {
    if (typeof runId !== 'string' || !RUN_UUID.test(runId)) throw error('COVER_LETTER_RUN_NOT_FOUND');
    const row = await store.get(runId);
    if (!row) throw error('COVER_LETTER_RUN_NOT_FOUND');
    if (row.status !== 'draft_pending') return { claimed: false, run: clone(row) };
    const claimed = await store.claimGeneration(runId, row.version, now().toISOString());
    if (claimed) return { claimed: true, run: clone(claimed) };
    const current = await store.get(runId);
    if (!current) throw error('COVER_LETTER_RUN_NOT_FOUND');
    return { claimed: false, run: clone(current) };
  }
  async function saveDraft(runId, input) {
    if (typeof runId !== 'string' || !RUN_UUID.test(runId)) throw error('COVER_LETTER_RUN_NOT_FOUND');
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['text', 'contentType', 'expectedVersion'].includes(key)) || input.contentType !== 'text/plain' || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > MAX_DRAFT_BYTES || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw error('COVER_LETTER_INPUT_INVALID');
    const digest = hash(input.text);
    const row = await store.get(runId);
    if (!row) throw error('COVER_LETTER_RUN_NOT_FOUND');
    if (row.status !== 'draft_generating' || row.version !== input.expectedVersion) throw error('COVER_LETTER_STATE_INVALID');
    const saved = await store.update(runId, input.expectedVersion, { status: 'awaiting_review', draft: input.text, draftSha256: digest, updatedAt: now().toISOString() });
    if (!saved) throw error('COVER_LETTER_STATE_INVALID');
    return clone(saved);
  }
  async function editDraft(runId, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['text', 'expectedSha256'].includes(key)) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > MAX_DRAFT_BYTES || !HASH.test(input.expectedSha256 || '')) throw error('COVER_LETTER_INPUT_INVALID');
    const current = await get(runId);
    if (current.status !== 'awaiting_review') throw error('COVER_LETTER_STATE_INVALID');
    if (!sameHash(current.draftSha256, input.expectedSha256)) throw error('COVER_LETTER_DRAFT_CHANGED');
    return change(runId, (row) => row.status === 'awaiting_review' && sameHash(row.draftSha256, input.expectedSha256), { draft: input.text, draftSha256: hash(input.text) });
  }
  async function approve(runId, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => key !== 'expectedSha256') || !HASH.test(input.expectedSha256 || '')) throw error('COVER_LETTER_INPUT_INVALID');
    const current = await get(runId);
    if (current.status === 'render_pending_dispatch' && sameHash(current.approvedSha256, input.expectedSha256)) return current;
    if (current.status !== 'awaiting_review') throw error('COVER_LETTER_STATE_INVALID');
    if (!sameHash(current.draftSha256, input.expectedSha256) || !sameHash(hash(current.draft), input.expectedSha256)) throw error('COVER_LETTER_DRAFT_CHANGED');
    let result;
    try {
      result = await store.approveAndEnqueue({ runId, expectedVersion: current.version, expectedDraftSha256: input.expectedSha256, approvedSha256: input.expectedSha256, now: now().toISOString() });
    } catch { throw error('COVER_LETTER_RENDER_UNAVAILABLE'); }
    if (!result?.run || !result?.intent || result.run.status !== 'render_pending_dispatch' || !sameHash(result.run.approvedSha256, input.expectedSha256)) throw error('COVER_LETTER_DRAFT_CHANGED');
    return clone(result.run);
  }
  async function cancel(runId) {
    return change(runId, (row) => ['draft_pending', 'draft_generating', 'awaiting_review'].includes(row.status), { status: 'canceled' });
  }
  return Object.freeze({ start, get, claimGeneration, saveDraft, editDraft, approve, cancel });
}

export function safeCoverLetterError(errorValue) { return SAFE_ERRORS.has(errorValue?.code) ? errorValue.code : 'COVER_LETTER_RUN_FAILED'; }
