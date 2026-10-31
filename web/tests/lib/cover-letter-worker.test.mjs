import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCoverLetterRenderWorker } from '../../src/lib/cover-letter-worker.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const draft = 'Approved cover letter';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(500, 0x20)]);
function fixture(overrides = {}) {
  const run = { runId, status:'render_pending_dispatch', binding:{ applicationNumber:'7', reportNumber:'9', reportPath:'reports/009-example.md', reportSha256:'a'.repeat(64), company:'Example', role:'Engineer' }, draft, draftSha256:hash(draft), approvedSha256:hash(draft), version:4 };
  const intent = { runId, approvedSha256:hash(draft), status:'pending_dispatch' };
  const calls = { render:0, complete:0, claim:0 };
  const receipt = () => ({ runId, applicationNumber:'7', reportNumber:'9', reportPath:'reports/009-example.md', reportSha256:'a'.repeat(64), approvedSha256:hash(draft), contentType:'application/pdf', byteSize:pdf.length, sha256:hash(pdf) });
  const store = {
    async get(id) { return id === runId ? structuredClone(run) : null; },
    async getRenderIntent(id) { return id === runId ? structuredClone(intent) : null; },
    async claimRenderIntent(input) { calls.claim++; if (input.expectedVersion !== run.version || intent.status !== 'pending_dispatch') return null; intent.status='rendering'; run.status='rendering'; run.version++; return { claimed:true, run:structuredClone(run), intent:structuredClone(intent) }; },
    async completeRenderReceipt(input) { calls.complete++; return structuredClone(receipt()); },
  };
  Object.assign(run, overrides.run || {}); Object.assign(intent, overrides.intent || {});
  const worker = createCoverLetterRenderWorker({ authorize:overrides.authorize || (async () => true), store:overrides.store || store, render:overrides.render || (async () => { calls.render++; return pdf; }), now:() => new Date('2026-10-31T03:00:00.000Z') });
  return { worker, run, intent, store, calls, receipt };
}

test('worker requires all injected dependencies and denies unauthenticated requests before reads', async () => {
  assert.throws(() => createCoverLetterRenderWorker(), { code:'COVER_LETTER_WORKER_UNAVAILABLE' });
  const f = fixture({ authorize:async () => false });
  await assert.rejects(f.worker.run({ request:{}, runId }), { code:'COVER_LETTER_WORKER_UNAUTHORIZED' });
  assert.equal(f.calls.render, 0); assert.equal(f.calls.claim, 0);
});

test('unapproved, tampered, stale, canceled, or missing-intent runs never render', async () => {
  for (const overrides of [
    { run:{ status:'awaiting_review' } },
    { run:{ status:'canceled' } },
    { run:{ draft:'Tampered text' } },
    { intent:{ approvedSha256:'b'.repeat(64) } },
    { intent:{ status:'dispatched' } },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(f.worker.run({ request:{}, runId }));
    assert.equal(f.calls.render, 0);
  }
  const stale = fixture({ store:{ ...fixture().store, async claimRenderIntent(){ return null; } } });
  await assert.rejects(stale.worker.run({ request:{}, runId }), { code:'COVER_LETTER_WORKER_STALE' });
  assert.equal(stale.calls.render, 0);
});

test('renders exact approved text and binds receipt to immutable run/application/report metadata', async () => {
  const f = fixture(); let captured;
  const worker = createCoverLetterRenderWorker({ authorize:async () => true, store:f.store, render:async (input) => { captured=input; f.calls.render++; return pdf; }, now:() => new Date('2026-10-31T03:00:00.000Z') });
  const result = await worker.run({ request:{}, runId });
  assert.equal(result.status, 'rendered'); assert.equal(captured.draft, draft); assert.equal(captured.approvedSha256, hash(draft));
  assert.equal(captured.binding.applicationNumber, '7'); assert.equal(captured.binding.reportPath, 'reports/009-example.md');
  assert.deepEqual(result.receipt, f.receipt()); assert.equal(f.calls.complete, 1);
});

test('rejects malformed and oversized PDFs, render failures, and mismatched persisted receipts', async () => {
  for (const render of [async () => { throw new Error('raw renderer stderr secret'); }, async () => Buffer.from('not a pdf'), async () => Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(8_000_001)])]) {
    const f = fixture({ render });
    await assert.rejects(f.worker.run({ request:{}, runId }), (error) => !String(error.message).includes('stderr') && error.code.startsWith('COVER_LETTER_WORKER_'));
    assert.equal(f.calls.complete, 0);
  }
  const f = fixture();
  const store = { ...f.store, async completeRenderReceipt() { return { ...f.receipt(), reportPath:'reports/other.md' }; } };
  const worker = createCoverLetterRenderWorker({ authorize:async () => true, store, render:async () => pdf });
  await assert.rejects(worker.run({ request:{}, runId }), { code:'COVER_LETTER_WORKER_STALE' });
});

test('completed run and outbox replay returns durable receipt without a second render', async () => {
  const f = fixture({ run:{ status:'rendered' }, intent:{ status:'completed' } });
  f.intent.receipt = f.receipt();
  const result = await f.worker.run({ request:{}, runId });
  assert.equal(result.status, 'already_rendered'); assert.deepEqual(result.receipt, f.receipt()); assert.equal(f.calls.render, 0);
  assert.equal(f.calls.claim, 0);
});
