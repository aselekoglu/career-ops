import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createCoverLetterRuntime } from '../../src/lib/cover-letter-runtime.mjs';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const archivedJd = 'Senior Systems Engineer responsibilities include building reliable systems, collaborating with product teams, improving service resilience, and maintaining clear operational practices. '.repeat(2);
const reportContent = `# Evaluation: Canonical Co — Systems Engineer\n\n## A) Role Summary\nPlatform role.\n\n## Job Description (archived verbatim)\n\n${archivedJd}\n`;
const answers = { confirmedResearch: { confirmed: true, text: 'Company confirmed platform reliability is a priority.' }, confirmedKeywords: { confirmed: true, items: ['systems','reliability','platform','engineering','operations','design','delivery','leadership'] }, gapDecisions: [], answers: { whyThisRole: 'I want to work on reliable systems.', problemToSolve: 'Improve service reliability.', approach: 'Map failure modes first.', tone: 'direct' } };
function poolFixture() {
  const runs = new Map(), outbox = new Map(), calls = []; let snapshot;
  const query = async (sql, values = []) => {
    calls.push(sql);
    if (/CREATE TABLE/.test(sql)) return { rows: [] };
    if (/INSERT INTO career_ops_cover_letter_runs/.test(sql)) {
      const existing = [...runs.values()].find((row) => row.idempotency_key === values[1]);
      if (existing) return { rows: [] };
      const row = { run_id: values[0], idempotency_key: values[1], request_fingerprint: values[2], status: values[3], binding: JSON.parse(values[4]), prerequisites: JSON.parse(values[5]), draft: values[6], draft_sha256: values[7], approved_sha256: values[8], render_intent_status: values[9], version: values[10], created_at: values[11], updated_at: values[12] };
      runs.set(row.run_id, row); return { rows: [row] };
    }
    if (/SELECT \* FROM career_ops_cover_letter_runs WHERE idempotency_key/.test(sql)) return { rows: [[...runs.values()].find((row) => row.idempotency_key === values[0])].filter(Boolean) };
    if (/SELECT \* FROM career_ops_cover_letter_runs WHERE run_id/.test(sql)) return { rows: [runs.get(values[0])].filter(Boolean) };
    if (/UPDATE career_ops_cover_letter_runs SET\s+status=COALESCE/.test(sql)) {
      const row = runs.get(values[0]); if (!row || row.version !== values[1]) return { rows: [] };
      if (values[2] !== null) row.status = values[2]; if (values[3]) row.draft = values[4]; if (values[5]) row.draft_sha256 = values[6];
      if (values[7]) row.approved_sha256 = values[8]; if (values[9]) row.render_intent_status = values[10]; if (values[11]) row.updated_at = values[11]; row.version++;
      return { rows: [row] };
    }
    if (/UPDATE career_ops_cover_letter_runs SET status='draft_generating'/.test(sql)) {
      const row = runs.get(values[0]); if (!row || row.version !== values[1] || row.status !== 'draft_pending') return { rows: [] };
      Object.assign(row, { status: 'draft_generating', updated_at: values[2], version: row.version + 1 }); return { rows: [row] };
    }
    if (sql === 'BEGIN') { snapshot = structuredClone({ runs: [...runs], outbox: [...outbox] }); return { rows: [] }; }
    if (sql === 'COMMIT') return { rows: [] };
    if (sql === 'ROLLBACK') { runs.clear(); outbox.clear(); for (const [k,v] of snapshot.runs) runs.set(k,v); for (const [k,v] of snapshot.outbox) outbox.set(k,v); return { rows: [] }; }
    if (/UPDATE career_ops_cover_letter_runs SET status='render_pending_dispatch'/.test(sql)) {
      const row = runs.get(values[0]); if (!row || row.version !== values[1] || row.status !== 'awaiting_review' || row.draft_sha256 !== values[2]) return { rows: [] };
      Object.assign(row, { status: 'render_pending_dispatch', approved_sha256: values[3], render_intent_status: 'pending_dispatch', updated_at: values[4], version: row.version + 1 }); return { rows: [row] };
    }
    if (/INSERT INTO career_ops_cover_letter_render_outbox/.test(sql)) {
      const row = { run_id: values[0], approved_sha256: values[1], status: 'pending_dispatch', created_at: values[2] }; outbox.set(row.run_id, row); return { rows: [row] };
    }
    if (/SELECT \* FROM career_ops_cover_letter_render_outbox/.test(sql)) return { rows: [outbox.get(values[0])].filter(Boolean) };
    throw new Error(`Unexpected test SQL: ${sql}`);
  };
  return { pool: { query, async connect() { return { query, release() {} }; } }, runs, outbox, calls };
}
function deps(overrides = {}) {
  const db = poolFixture(); let promptInput;
  const runtime = createCoverLetterRuntime({
    pool: db.pool,
    authorizeOwner: async () => true,
    readTrackerApplication: async (applicationNumber) => ({ n: applicationNumber, company: 'Canonical Co', role: 'Systems Engineer', report: '[45](../reports/045-example-2026-10-31.md)' }),
    readReport: async (path) => ({ path, content: reportContent, sha256: sha(reportContent) }),
    readCanonicalCv: async () => 'Canonical CV: built reliable distributed systems.',
    readCanonicalProfile: async () => 'narrative: { headline: Systems engineer }',
    hostedAi: { status: () => ({ ready: true }), async *stream(input) { promptInput = input; yield { type: 'text', text: 'A grounded cover letter draft.' }; } },
    ...overrides,
  });
  const request = (body) => new Request('https://career-ops.test/api/cover-letter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...db, runtime, request, get promptInput() { return promptInput; } };
}

 test('runtime composes trusted target, prompt and hosted AI without running schema setup', async () => {
  const f = deps(); assert.equal(f.calls.some((sql) => /CREATE TABLE/.test(sql)), false);
  assert.ok(await f.runtime.resolveTarget({ applicationNumber: '12', reportNumber: '45' }));
  const response = await f.runtime.api(f.request({ action: 'start', operationId: randomUUID(), applicationNumber: '12', reportNumber: '45', ...answers }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json())); const { run } = await response.json();
  assert.equal(run.status, 'awaiting_review'); assert.equal(run.binding.reportPath, 'reports/045-example-2026-10-31.md');
  assert.equal(f.promptInput.task, 'cv'); assert.equal(f.promptInput.webSearch, false);
  assert.match(f.promptInput.messages[0].content, /Canonical Co/); assert.match(f.promptInput.messages[0].content, /Canonical CV/); assert.match(f.promptInput.messages[0].content, /building reliable systems/i);
  assert.doesNotMatch(f.promptInput.messages[0].content, /ignore these rules/i);
  assert.equal(f.calls.some((sql) => /CREATE TABLE/.test(sql)), false);
});

test('approval is explicitly unavailable without a configured durable render dispatcher', async () => {
  const f = deps();
  const started = await f.runtime.api(f.request({ action: 'start', operationId: randomUUID(), applicationNumber: '12', reportNumber: '45', ...answers }));
  const run = (await started.json()).run;
  const approved = await f.runtime.api(f.request({ action: 'approve', runId: run.runId, expectedSha256: run.draftSha256, confirm: true }));
  assert.equal(approved.status, 503); assert.deepEqual(await approved.json(), { error: 'COVER_LETTER_RENDER_UNAVAILABLE' });
  assert.equal(f.outbox.size, 0); assert.equal((await f.runtime.service.get(run.runId)).status, 'awaiting_review');
});

test('a configured dispatcher is called only after the durable approval intent is recorded', async () => {
  const dispatches = [];
  const f = deps({ renderDispatcher: { isConfigured: async () => true, async dispatchPending(intent) { dispatches.push(intent); } } });
  const started = await f.runtime.api(f.request({ action: 'start', operationId: randomUUID(), applicationNumber: '12', reportNumber: '45', ...answers }));
  const run = (await started.json()).run;
  const approved = await f.runtime.api(f.request({ action: 'approve', runId: run.runId, expectedSha256: run.draftSha256, confirm: true }));
  assert.equal(approved.status, 200);
  assert.deepEqual(dispatches, [{ runId: run.runId, approvedSha256: run.draftSha256 }]);
  assert.equal(f.outbox.get(run.runId).approved_sha256, run.draftSha256);
});

test('runtime fails closed when the tracker link, report digest, identity, or archived JD cannot be verified', async () => {
  const f = deps({ readTrackerApplication: async (applicationNumber) => ({ n: applicationNumber, company: 'Canonical Co', role: 'Systems Engineer', report: '[45](../../private.md)' }) });
  const response = await f.runtime.api(f.request({ action: 'start', operationId: randomUUID(), applicationNumber: '12', reportNumber: '45', ...answers }));
  assert.equal(response.status, 404); assert.equal(f.runs.size, 0);
  const staleDigest = deps({ readReport: async (path) => ({ path, content: reportContent, sha256: '0'.repeat(64) }) });
  const staleResponse = await staleDigest.runtime.api(staleDigest.request({ action: 'start', operationId: randomUUID(), applicationNumber: '12', reportNumber: '45', ...answers }));
  assert.equal(staleResponse.status, 404); assert.equal(staleDigest.runs.size, 0);
  assert.equal(staleDigest.calls.some((sql) => /INSERT INTO career_ops_cover_letter_runs/.test(sql)), false);
  const noJdContent = reportContent.replace(/^## Job Description \(archived verbatim\)[\s\S]*$/m, '## B) Another Section');
  const noJd = deps({ readReport: async (path) => ({ path, content: noJdContent, sha256: sha(noJdContent) }) });
  const noJdResponse = await noJd.runtime.api(noJd.request({ action: 'start', operationId: randomUUID(), applicationNumber: '12', reportNumber: '45', ...answers }));
  assert.equal(noJdResponse.status, 404); assert.equal(noJd.runs.size, 0);
});

test('runtime requires all security-sensitive dependencies and schema initialization is explicit', async () => {
  assert.throws(() => createCoverLetterRuntime(), { code: 'COVER_LETTER_RUNTIME_NOT_CONFIGURED' });
  const f = deps(); await f.runtime.ensureSchema(); assert.equal(f.calls.some((sql) => /CREATE TABLE/.test(sql)), true);
});
