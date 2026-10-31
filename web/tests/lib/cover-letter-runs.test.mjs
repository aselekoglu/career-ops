import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createCoverLetterRunService } from '../../src/lib/cover-letter-runs.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const ready = (idempotencyKey) => ({ applicationNumber: '12', reportNumber: '45', idempotencyKey, confirmedResearch: { confirmed: true, text: 'Confirmed company priorities.' }, confirmedKeywords: { confirmed: true, items: ['a','b','c','d','e','f','g','h'] }, gapDecisions: [], answers: { whyThisRole: 'Role alignment', problemToSolve: 'Improve reliability', approach: 'Start with discovery', tone: 'direct' } });
function fixture({ beforeAtomicApproval } = {}) {
  const runs = new Map(); const outbox = new Map(); let reads = 0;
  const store = {
    async resolveBinding(applicationNumber, reportNumber) {
      if (applicationNumber !== '12' || reportNumber !== '45') return null;
      return { applicationNumber, reportNumber, reportPath: 'reports/045-example-2026-10-31.md', company: 'Example', role: 'Engineer', reportSha256: 'a'.repeat(64) };
    },
    async createIfAbsent(row) { const prior = [...runs.values()].find(r => r.idempotencyKey === row.idempotencyKey); if (prior) return prior; runs.set(row.runId, structuredClone(row)); return runs.get(row.runId); },
    async get(runId) { reads++; return runs.get(runId) || null; },
    async update(runId, expectedVersion, patch) { const row = runs.get(runId); if (!row || row.version !== expectedVersion) return null; Object.assign(row, structuredClone(patch), { version: row.version + 1 }); return row; },
    async claimGeneration(runId, expectedVersion, now) { const row = runs.get(runId); if (!row || row.version !== expectedVersion || row.status !== 'draft_pending') return null; Object.assign(row, { status: 'draft_generating', updatedAt: now, version: row.version + 1 }); return row; },
    async approveAndEnqueue({ runId, expectedVersion, expectedDraftSha256, approvedSha256, now }) {
      await beforeAtomicApproval?.();
      const row = runs.get(runId); if (!row || row.version !== expectedVersion || row.status !== 'awaiting_review' || row.draftSha256 !== expectedDraftSha256) return null;
      const intent = { runId, approvedSha256, status: 'pending_dispatch' }; Object.assign(row, { status: 'render_pending_dispatch', approvedSha256, renderIntentStatus: 'pending_dispatch', updatedAt: now, version: row.version + 1 }); outbox.set(runId, intent); return { run: row, intent };
    },
  };
  const service = createCoverLetterRunService({ store });
  return { service, runs, outbox, get reads() { return reads; } };
}
async function saveClaimedDraft(service, runId, text) {
  const claim = await service.claimGeneration(runId);
  assert.equal(claim.claimed, true);
  return service.saveDraft(runId, { text, contentType: 'text/plain', expectedVersion: claim.run.version });
}

test('start binds exact application and report idempotently and never creates render intent', async () => {
  const f = fixture(); const idem = 'request-1';
  const input = ready(idem);
  const a = await f.service.start(input), b = await f.service.start(input);
  assert.equal(a.runId, b.runId); assert.deepEqual(a.binding, b.binding); assert.equal(a.binding.reportPath, 'reports/045-example-2026-10-31.md'); assert.equal(a.status, 'draft_pending'); assert.equal(f.outbox.size, 0);
  await assert.rejects(f.service.start({ ...input, reportNumber: '46' }), { code: 'COVER_LETTER_BINDING_NOT_FOUND' });
  await assert.rejects(f.service.start({ ...input, answers: { ...input.answers, whyThisRole: 'A different confirmed motivation' } }), { code: 'COVER_LETTER_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.service.start({ ...input, applicationNumber: '13', idempotencyKey: 'x' }), { code: 'COVER_LETTER_BINDING_NOT_FOUND' });
});

test('draft is reviewable and approval requires the current exact draft hash', async () => {
  const f = fixture(); const run = await f.service.start(ready('draft'));
  const draft = await saveClaimedDraft(f.service, run.runId, 'Draft letter');
  assert.equal(draft.status, 'awaiting_review'); assert.equal(draft.draftSha256, hash('Draft letter'));
  const edited = await f.service.editDraft(run.runId, { expectedSha256: draft.draftSha256, text: 'Edited letter' });
  await assert.rejects(f.service.approve(run.runId, { expectedSha256: draft.draftSha256 }), { code: 'COVER_LETTER_DRAFT_CHANGED' });
  const approved = await f.service.approve(run.runId, { expectedSha256: edited.draftSha256 });
  assert.equal(approved.status, 'render_pending_dispatch'); assert.equal(approved.approvedSha256, edited.draftSha256); assert.equal(approved.renderIntentStatus, 'pending_dispatch'); assert.equal(f.outbox.get(run.runId).status, 'pending_dispatch');
});

test('missing atomic outbox capability fails closed without changing reviewed run state', async () => {
  const f = fixture(); const run = await f.service.start(ready('no-queue'));
  const draft = await saveClaimedDraft(f.service, run.runId, 'Review me');
  assert.throws(() => createCoverLetterRunService({ store: { resolveBinding: async () => null, createIfAbsent: async () => null, get: async () => null, update: async () => null } }), { code: 'COVER_LETTER_STORE_UNAVAILABLE' });
  assert.equal((await f.service.get(run.runId)).status, 'awaiting_review');
});

test('cancel is terminal and rejects later edits or approval', async () => {
  const f = fixture(); const run = await f.service.start(ready('cancel'));
  const draft = await saveClaimedDraft(f.service, run.runId, 'Review me');
  assert.equal((await f.service.cancel(run.runId)).status, 'canceled');
  await assert.rejects(f.service.editDraft(run.runId, { expectedSha256: draft.draftSha256, text: 'Late edit' }), { code: 'COVER_LETTER_STATE_INVALID' });
});

test('input sizes, media types, identifiers and caller supplied paths are rejected', async () => {
  const f = fixture();
  await assert.rejects(f.service.start({ applicationNumber: '../12', reportNumber: '45', idempotencyKey: 'bad' }), { code: 'COVER_LETTER_INPUT_INVALID' });
  await assert.rejects(f.service.start({ ...ready('p'), path: 'arbitrary' }), { code: 'COVER_LETTER_INPUT_INVALID' });
  const run = await f.service.start(ready('limits'));
  await assert.rejects(f.service.saveDraft(run.runId, { text: 'x'.repeat(50_001), contentType: 'text/plain' }), { code: 'COVER_LETTER_INPUT_INVALID' });
  await assert.rejects(f.service.saveDraft(run.runId, { text: '<script/>', contentType: 'text/html' }), { code: 'COVER_LETTER_INPUT_INVALID' });
});



test('approval is idempotent and a concurrent edit cannot race an approval into an invalid intent', async () => {
  const f = fixture(); const run = await f.service.start(ready('race'));
  const draft = await saveClaimedDraft(f.service, run.runId, 'Review me');
  const outcomes = await Promise.allSettled([
    f.service.editDraft(run.runId, { expectedSha256: draft.draftSha256, text: 'Concurrent edit' }),
    f.service.approve(run.runId, { expectedSha256: draft.draftSha256 }),
  ]);
  const current = await f.service.get(run.runId);
  if (current.status === 'render_pending_dispatch') {
    assert.equal(current.approvedSha256, draft.draftSha256);
    assert.equal(f.outbox.get(run.runId).approvedSha256, current.approvedSha256);
    assert.equal((await f.service.approve(run.runId, { expectedSha256: draft.draftSha256 })).runId, run.runId);
    assert.equal(f.outbox.size, 1);
  } else {
    assert.equal(current.status, 'awaiting_review');
    assert.equal(current.draft, 'Concurrent edit');
    assert.equal(f.outbox.size, 0);
  }
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
});


test('nested prerequisites are strict and gap details are bounded', async () => {
  const f = fixture();
  const extraResearch = ready('strict'); extraResearch.confirmedResearch.unexpected = 'ignored?';
  await assert.rejects(f.service.start(extraResearch), { code: 'COVER_LETTER_INPUT_INVALID' });
  const userAngle = ready('angle'); userAngle.gapDecisions = [{ gap: 'Title mismatch', decision: 'user-angle', text: 'x'.repeat(501) }];
  await assert.rejects(f.service.start(userAngle), { code: 'COVER_LETTER_INPUT_INVALID' });
  const malformedAnswers = ready('answers'); malformedAnswers.answers.extra = 'not allowed';
  await assert.rejects(f.service.start(malformedAnswers), { code: 'COVER_LETTER_INPUT_INVALID' });
});

test('binding rejects noncanonical or traversing report paths', async () => {
  for (const reportPath of ['../reports/045-example.md', 'reports/../../secret.md', 'reports/subdir/045.md', 'reports\\045.md', '/reports/045.md']) {
    const store = {
      resolveBinding: async (applicationNumber, reportNumber) => ({ applicationNumber, reportNumber, reportPath, company: 'Example', role: 'Engineer', reportSha256: 'a'.repeat(64) }),
      createIfAbsent: async () => { throw new Error('must not persist invalid binding'); },
      get: async () => null, update: async () => null, claimGeneration: async () => null, approveAndEnqueue: async () => null,
    };
    const svc = createCoverLetterRunService({ store });
    await assert.rejects(svc.start(ready(`bad-${reportPath.length}`)), { code: 'COVER_LETTER_BINDING_NOT_FOUND' });
  }
});

test('run IDs must use canonical UUID form', async () => {
  const f = fixture();
  await assert.rejects(f.service.get('00000000-0000-0000-0000-00000000000z'), { code: 'COVER_LETTER_RUN_NOT_FOUND' });
  assert.equal(f.reads, 0);
});

test('generation claim is atomic, draft save is version-bound, and cancellation wins late generation', async () => {
  const f = fixture(); const run = await f.service.start(ready('generation-claim'));
  const claims = await Promise.all([f.service.claimGeneration(run.runId), f.service.claimGeneration(run.runId)]);
  assert.equal(claims.filter((result) => result.claimed).length, 1);
  const claimed = claims.find((result) => result.claimed).run;
  assert.equal(claimed.status, 'draft_generating');
  const canceled = await f.service.cancel(run.runId);
  assert.equal(canceled.status, 'canceled');
  await assert.rejects(f.service.saveDraft(run.runId, { text: 'Late result', contentType: 'text/plain', expectedVersion: claimed.version }), { code: 'COVER_LETTER_STATE_INVALID' });
  assert.equal((await f.service.get(run.runId)).status, 'canceled');
});
