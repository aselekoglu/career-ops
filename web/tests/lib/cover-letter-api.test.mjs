import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createCoverLetterApi } from '../../src/lib/cover-letter-api.mjs';
import { createCoverLetterRunService } from '../../src/lib/cover-letter-runs.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const prerequisites = {
  confirmedResearch: { confirmed: true, text: 'Company confirmed its current priority.' },
  confirmedKeywords: { confirmed: true, items: ['one','two','three','four','five','six','seven','eight'] },
  gapDecisions: [],
  answers: { whyThisRole: 'Specific reason', problemToSolve: 'The stated problem', approach: 'A concrete first step', tone: 'direct' },
};
const reportContent = '# Archived evaluation report';
const trusted = { applicationNumber: '12', reportNumber: '45', reportPath: 'reports/045-example-2026-10-31.md', reportSha256: sha(reportContent), reportContent, sources: { cv: 'trusted CV', jd: 'trusted JD', reportContent } };
const startInput = (operationId, applicationNumber = '12', reportNumber = '45') => ({ action: 'start', operationId, applicationNumber, reportNumber, ...prerequisites });
function fixture({ authorize = async () => true, trustedResult = trusted, generate = async () => 'A grounded draft.', serviceOverride = {} } = {}) {
  const rows = new Map(); const outbox = new Map();
  const store = {
    async resolveBinding(applicationNumber, reportNumber) {
      if (applicationNumber !== '12' || reportNumber !== '45') return null;
      return { applicationNumber, reportNumber, reportPath: 'reports/045-example-2026-10-31.md', reportSha256: trusted.reportSha256, company: 'Example', role: 'Engineer' };
    },
    async createIfAbsent(row) { const existing = [...rows.values()].find((item) => item.idempotencyKey === row.idempotencyKey); if (existing) return existing; rows.set(row.runId, structuredClone(row)); return rows.get(row.runId); },
    async get(id) { return rows.get(id) || null; },
    async update(id, version, patch) { const row = rows.get(id); if (!row || row.version !== version) return null; Object.assign(row, structuredClone(patch), { version: version + 1 }); return row; },
    async claimGeneration(id, version, now) { const row = rows.get(id); if (!row || row.version !== version || row.status !== 'draft_pending') return null; Object.assign(row, { status: 'draft_generating', updatedAt: now, version: version + 1 }); return row; },
    async approveAndEnqueue({ runId, expectedVersion, expectedDraftSha256, approvedSha256, now }) { const row = rows.get(runId); if (!row || row.version !== expectedVersion || row.status !== 'awaiting_review' || row.draftSha256 !== expectedDraftSha256) return null; const intent = { runId, approvedSha256, status: 'pending_dispatch' }; Object.assign(row, { status: 'render_pending_dispatch', approvedSha256, renderIntentStatus: 'pending_dispatch', updatedAt: now, version: expectedVersion + 1 }); outbox.set(runId, intent); return { run: row, intent }; },
  };
  const baseService = createCoverLetterRunService({ store });
  const service = typeof serviceOverride === 'function' ? serviceOverride(baseService) : { ...baseService, ...serviceOverride };
  const calls = { generated: 0, trusted: 0 };
  const handler = createCoverLetterApi({ service, authorizeOwner: authorize, resolveTrustedStart: async (ids) => { calls.trusted++; return typeof trustedResult === 'function' ? trustedResult(ids) : trustedResult; }, generateDraft: async (args) => { calls.generated++; return generate(args); } });
  const request = (body) => new Request('https://career-ops.test/api/cover-letter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { handler, request, rows, outbox, calls, service };
}
const body = async (response) => response.json();

test('start, status, edit, confirmed approval, and cancel form the review-first API sequence', async () => {
  const f = fixture(); const operationId = randomUUID();
  const startedResponse = await f.handler(f.request(startInput(operationId)));
  assert.equal(startedResponse.status, 201); const started = (await body(startedResponse)).run;
  assert.equal(started.status, 'awaiting_review'); assert.equal(started.binding.reportPath, 'reports/045-example-2026-10-31.md'); assert.equal(f.calls.generated, 1); assert.equal(f.outbox.size, 0);
  const status = await body(await f.handler(f.request({ action: 'status', runId: started.runId })));
  assert.equal(status.run.draft, 'A grounded draft.');
  const edited = (await body(await f.handler(f.request({ action: 'edit', runId: started.runId, expectedSha256: started.draftSha256, text: 'Reviewed edit.' })))).run;
  assert.equal(edited.draft, 'Reviewed edit.'); assert.notEqual(edited.draftSha256, started.draftSha256);
  const approvedResponse = await f.handler(f.request({ action: 'approve', runId: started.runId, expectedSha256: edited.draftSha256, confirm: true }));
  const approvedBody = await body(approvedResponse); assert.equal(approvedResponse.status, 200, JSON.stringify(approvedBody)); const approved = approvedBody.run;
  assert.equal(approved.status, 'render_pending_dispatch'); assert.equal(approved.approvedSha256, edited.draftSha256); assert.equal(f.outbox.size, 1);
  const replayResponse = await f.handler(f.request(startInput(operationId)));
  assert.equal((await body(replayResponse)).run.runId, started.runId); assert.equal(f.calls.generated, 1);
  const second = await f.handler(f.request(startInput(randomUUID())));
  const secondRun = (await body(second)).run;
  assert.equal((await f.handler(f.request({ action: 'cancel', runId: secondRun.runId }))).status, 200);
});

test('rejects wrong binding, stale hash, and approval without explicit confirmation', async () => {
  const wrong = fixture({ trustedResult: null });
  assert.equal((await wrong.handler(wrong.request(startInput(randomUUID(), '12', '46')))).status, 404);
  const f = fixture(); const started = (await body(await f.handler(f.request(startInput(randomUUID()))))).run;
  assert.equal((await f.handler(f.request({ action: 'edit', runId: started.runId, expectedSha256: '0'.repeat(64), text: 'stale edit' }))).status, 409);
  assert.equal((await f.handler(f.request({ action: 'approve', runId: started.runId, expectedSha256: started.draftSha256, confirm: false }))).status, 400);
  assert.equal(f.outbox.size, 0);
});

test('authorizes before parsing and bounds streamed JSON bodies', async () => {
  const denied = fixture({ authorize: async () => false });
  const unauthorized = await denied.handler(new Request('https://career-ops.test', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json' }));
  assert.equal(unauthorized.status, 401); assert.equal(denied.calls.trusted, 0);
  const bounded = fixture();
  const tooLarge = await bounded.handler(new Request('https://career-ops.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'x', padding: 'x'.repeat(71_000) }) }));
  assert.equal(tooLarge.status, 413);
});

test('never trusts client CV or JD and hides unsupported internal errors', async () => {
  let received;
  const f = fixture({ generate: async (args) => { received = args; return 'Trusted generated text.'; } });
  const response = await f.handler(f.request({ ...startInput(randomUUID()), cv: 'attacker CV', jd: 'attacker JD' }));
  assert.equal(response.status, 400); assert.equal(received, undefined);
  const badService = fixture({ serviceOverride: { get: async () => { throw new Error('database password/details'); } } });
  const failure = await body(await badService.handler(badService.request({ action: 'status', runId: randomUUID() })));
  assert.deepEqual(failure, { error: 'COVER_LETTER_API_FAILED' });
});




test('fails closed when trusted report resolution differs from persisted binding', async () => {
  const cases = [
    { ...trusted, reportPath: 'reports/046-other.md' },
    { ...trusted, reportSha256: 'b'.repeat(64) },
    { ...trusted, reportContent: 'changed archived report' },
    { ...trusted, reportPath: '../private.md' },
  ];
  for (const trustedResult of cases) {
    const f = fixture({ trustedResult });
    const response = await f.handler(f.request(startInput(randomUUID())));
    assert.equal(response.status, 409);
    assert.equal(f.calls.generated, 0);
    const persisted = [...f.rows.values()][0];
    if (persisted) assert.equal(persisted.status, 'draft_pending');
  }
});

test('fails closed when persisted report binding changes between trusted resolution and start', async () => {
  const f = fixture({ serviceOverride: (base) => ({ ...base, start: async (input) => {
    const run = await base.start(input);
    return { ...run, binding: { ...run.binding, reportSha256: 'c'.repeat(64) } };
  } }) });
  const response = await f.handler(f.request(startInput(randomUUID())));
  assert.equal(response.status, 409); assert.equal(f.calls.generated, 0);
});

test('concurrent idempotent starts claim generation once and replay returns 202 without regenerating', async () => {
  let signalStarted; let release;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const generationGate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ generate: async () => { signalStarted(); await generationGate; return 'Single generated draft.'; } });
  const operationId = randomUUID();
  const first = f.handler(f.request(startInput(operationId)));
  await started;
  const replayResponse = await f.handler(f.request(startInput(operationId)));
  assert.equal(replayResponse.status, 202);
  const replay = await body(replayResponse);
  assert.equal(replay.run.status, 'draft_generating');
  assert.equal(replay.generationStatus, 'in_progress_or_unknown');
  assert.equal(f.calls.generated, 1);
  release();
  assert.equal((await first).status, 201);
  assert.equal(f.calls.generated, 1);
});

test('cancellation during generation remains terminal when the model later returns', async () => {
  let signalStarted; let release;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const generationGate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ generate: async () => { signalStarted(); await generationGate; return 'Late generated draft.'; } });
  const first = f.handler(f.request(startInput(randomUUID())));
  await started;
  const run = [...f.rows.values()][0];
  const canceledResponse = await f.handler(f.request({ action: 'cancel', runId: run.runId }));
  assert.equal((await body(canceledResponse)).run.status, 'canceled');
  release();
  assert.equal((await first).status, 409);
  assert.equal((await f.service.get(run.runId)).status, 'canceled');
  assert.equal((await f.service.get(run.runId)).draft, null);
});

test('ambiguous generator failure remains inspectable and is never silently regenerated', async () => {
  const f = fixture({ generate: async () => { throw new Error('private provider detail'); } });
  const input = startInput(randomUUID());
  const first = await f.handler(f.request(input));
  assert.equal(first.status, 503); assert.deepEqual(await body(first), { error: 'GENERATION_STATUS_UNKNOWN' });
  assert.equal(f.calls.generated, 1);
  const replay = await f.handler(f.request(input));
  assert.equal(replay.status, 202);
  assert.equal((await body(replay)).run.status, 'draft_generating');
  assert.equal(f.calls.generated, 1);
});
