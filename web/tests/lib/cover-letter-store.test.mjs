import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresCoverLetterStore, COVER_LETTER_SCHEMA_SQL } from '../../src/lib/cover-letter-store.mjs';

function fakePool() {
  const runs = new Map(), outbox = new Map(), artifacts = new Map(), calls = [];
  let transactionSnapshot;
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (/INSERT INTO career_ops_cover_letter_runs/.test(sql)) {
      const existing = [...runs.values()].find((row) => row.idempotency_key === values[1]);
      if (existing) return { rows: [] };
      const row = { run_id: values[0], idempotency_key: values[1], request_fingerprint: values[2], status: values[3], binding: JSON.parse(values[4]), prerequisites: JSON.parse(values[5]), draft: values[6], draft_sha256: values[7], approved_sha256: values[8], render_intent_status: values[9], version: values[10], created_at: values[11], updated_at: values[12] };
      runs.set(row.run_id, row); return { rows: [row] };
    }
    if (/SELECT \* FROM career_ops_cover_letter_runs WHERE idempotency_key/.test(sql)) return { rows: [[...runs.values()].find((r) => r.idempotency_key === values[0])].filter(Boolean) };
    if (/SELECT \* FROM career_ops_cover_letter_runs WHERE run_id/.test(sql)) return { rows: [runs.get(values[0])].filter(Boolean) };
    if (/UPDATE career_ops_cover_letter_runs SET\s+status=COALESCE/.test(sql)) {
      const row = runs.get(values[0]); if (!row || row.version !== values[1]) return { rows: [] };
      if (values[2] !== null) row.status = values[2];
      if (values[3]) row.draft = values[4]; if (values[5]) row.draft_sha256 = values[6];
      if (values[7]) row.approved_sha256 = values[8]; if (values[9]) row.render_intent_status = values[10];
      if (values[11]) row.updated_at = values[11]; row.version++; return { rows: [row] };
    }
    if (/UPDATE career_ops_cover_letter_runs SET status='draft_generating'/.test(sql)) {
      const row = runs.get(values[0]); if (!row || row.version !== values[1] || row.status !== 'draft_pending') return { rows: [] };
      row.status = 'draft_generating'; row.updated_at = values[2]; row.version++; return { rows:[row] };
    }
    if (sql === 'BEGIN') { transactionSnapshot = structuredClone({ runs: [...runs], outbox: [...outbox], artifacts:[...artifacts] }); return { rows: [] }; }
    if (sql === 'ROLLBACK') { runs.clear(); outbox.clear(); artifacts.clear(); for (const [k,v] of transactionSnapshot.runs) runs.set(k,v); for (const [k,v] of transactionSnapshot.outbox) outbox.set(k,v); for (const [k,v] of transactionSnapshot.artifacts) artifacts.set(k,v); return { rows: [] }; }
    if (sql === 'COMMIT') return { rows: [] };
    if (/UPDATE career_ops_cover_letter_runs SET status='render_pending_dispatch'/.test(sql)) {
      const row = runs.get(values[0]); if (!row || row.version !== values[1] || row.status !== 'awaiting_review' || row.draft_sha256 !== values[2]) return { rows: [] };
      Object.assign(row, { status:'render_pending_dispatch', approved_sha256:values[3], render_intent_status:'pending_dispatch', updated_at:values[4], version:row.version+1 }); return { rows:[row] };
    }
    if (/INSERT INTO career_ops_cover_letter_render_outbox/.test(sql)) {
      if (outbox.has(values[0])) return { rows: [] };
      const row = { run_id:values[0], approved_sha256:values[1], status:'pending_dispatch', created_at:values[2] }; outbox.set(row.run_id,row); return { rows:[row] };
    }
    if (/SELECT r\.\*,o\.run_id AS intent_run_id/.test(sql)) { const o=outbox.get(values[0]),a=artifacts.get(values[0]),r=runs.get(values[0]); return { rows:o&&r?[{...r,intent_run_id:o.run_id,intent_approved_sha256:o.approved_sha256,intent_status:o.status,receipt:a?.receipt??null,pdf_bytes:a?.pdf_bytes??null}]:[] }; }
    if (/UPDATE career_ops_cover_letter_runs SET status='rendering'/.test(sql)) {
      const row=runs.get(values[0]); if(!row||row.version!==values[1]||row.status!=='render_pending_dispatch'||row.approved_sha256!==values[2])return{rows:[]};
      Object.assign(row,{status:'rendering',render_intent_status:'rendering',updated_at:values[3],version:row.version+1});return{rows:[row]};
    }
    if (/UPDATE career_ops_cover_letter_render_outbox SET status='rendering'/.test(sql)) {
      const row=outbox.get(values[0]);if(!row||row.status!=='pending_dispatch'||row.approved_sha256!==values[1])return{rows:[]};row.status='rendering';return{rows:[row]};
    }
    if (/SELECT \* FROM career_ops_cover_letter_runs WHERE run_id=\$1 FOR UPDATE/.test(sql)) return { rows:[runs.get(values[0])].filter(Boolean) };
    if (/SELECT \* FROM career_ops_cover_letter_artifacts WHERE run_id/.test(sql)) return { rows:[artifacts.get(values[0])].filter(Boolean) };
    if (/SELECT receipt,pdf_bytes FROM career_ops_cover_letter_artifacts WHERE run_id/.test(sql)) { const a=artifacts.get(values[0]); return { rows:a?[{receipt:a.receipt,pdf_bytes:a.pdf_bytes}]:[] }; }
    if (/SELECT approved_sha256,status FROM career_ops_cover_letter_render_outbox WHERE run_id/.test(sql)) { const o=outbox.get(values[0]); return { rows:o?[{approved_sha256:o.approved_sha256,status:o.status}]:[] }; }
    if (/SELECT \* FROM career_ops_cover_letter_render_outbox WHERE run_id/.test(sql)) return { rows:[outbox.get(values[0])].filter(Boolean) };
    if (/INSERT INTO career_ops_cover_letter_artifacts/.test(sql)) { const row={run_id:values[0],receipt:JSON.parse(values[1]),pdf_bytes:values[2],created_at:values[3]};artifacts.set(row.run_id,row);return{rows:[row]}; }
    if (/UPDATE career_ops_cover_letter_render_outbox SET status='completed'/.test(sql)) {const row=outbox.get(values[0]);if(!row||row.status!=='rendering')return{rows:[]};row.status='completed';return{rows:[row]};}
    if (/UPDATE career_ops_cover_letter_runs SET status='rendered'/.test(sql)) {const row=runs.get(values[0]);if(!row||row.version!==values[1]||row.status!=='rendering'||row.approved_sha256!==values[3])return{rows:[]};Object.assign(row,{status:'rendered',render_intent_status:'completed',updated_at:values[2],version:row.version+1});return{rows:[row]};}
    if (/SELECT r\.\*,a\.receipt,a\.pdf_bytes/.test(sql)) {const row=runs.get(values[0]),a=artifacts.get(values[0]);return{rows:row&&a?[{...row,receipt:a.receipt,pdf_bytes:a.pdf_bytes}]:[]};}
    throw new Error(`Unhandled SQL: ${sql}`);
  };
  return { pool: { query, async connect() { return { query, release() {} }; } }, runs, outbox, artifacts, calls };
}

const base = (overrides = {}) => ({ runId:'11111111-1111-4111-8111-111111111111', idempotencyKey:'key-1', requestFingerprint:'a'.repeat(64), status:'draft_pending', binding:{ applicationNumber:'7', reportNumber:'9', company:'Canonical Co', role:'Engineer', reportSha256:'b'.repeat(64) }, prerequisites:{ answers:{ tone:'direct' } }, draft:null, draftSha256:null, approvedSha256:null, renderIntentStatus:null, version:1, createdAt:'2026-10-31T00:00:00.000Z', updatedAt:'2026-10-31T00:00:00.000Z', ...overrides });

test('adapter requires injected pool and canonical binding resolver; schema is dedicated', () => {
  assert.throws(() => createPostgresCoverLetterStore(), { code:'COVER_LETTER_STORE_UNAVAILABLE' });
  assert.match(COVER_LETTER_SCHEMA_SQL, /career_ops_cover_letter_runs/);
  assert.match(COVER_LETTER_SCHEMA_SQL, /career_ops_cover_letter_render_outbox/);
  assert.doesNotMatch(COVER_LETTER_SCHEMA_SQL, /application.*report.*(content|text)/i);
});

test('createIfAbsent is atomic by unique idempotency key and persists request fingerprint', async () => {
  const f = fakePool(); const store = createPostgresCoverLetterStore({ pool:f.pool, resolveBinding:async (app, report) => ({ applicationNumber:app, reportNumber:report, reportSha256:'c'.repeat(64) }) });
  const first = await store.createIfAbsent(base());
  const second = await store.createIfAbsent(base({ runId:'22222222-2222-4222-8222-222222222222' }));
  assert.equal(first.runId, second.runId); assert.equal(second.requestFingerprint, 'a'.repeat(64));
  assert.match(f.calls[0].sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  const binding = await store.resolveBinding('7','9'); assert.deepEqual(binding, { applicationNumber:'7', reportNumber:'9', reportSha256:'c'.repeat(64) });
});

test('update uses compare-and-swap version and increments only on success', async () => {
  const f = fakePool(), store = createPostgresCoverLetterStore({ pool:f.pool, resolveBinding:async()=>null });
  await store.createIfAbsent(base());
  const updated = await store.update(base().runId, 1, { status:'awaiting_review', draft:'Draft', draftSha256:'d'.repeat(64), updatedAt:'2026-10-31T01:00:00.000Z' });
  assert.equal(updated.version, 2); assert.equal(updated.draft, 'Draft');
  assert.equal(await store.update(base().runId, 1, { status:'canceled' }), null);
  assert.match(f.calls.find((call) => /UPDATE career_ops_cover_letter_runs SET/.test(call.sql)).sql, /WHERE run_id=\$1 AND version=\$2/);
  await assert.rejects(store.update(base().runId, 2, { binding:{} }), /Unsupported/);
});

test('generation claim is a single-winner CAS and preserves canonical report path', async () => {
  const f = fakePool(), store = createPostgresCoverLetterStore({ pool:f.pool, resolveBinding:async()=>null });
  const run = base({ binding:{ applicationNumber:'7', reportNumber:'9', reportPath:'reports/009-canonical.md', reportSha256:'b'.repeat(64) } });
  await store.createIfAbsent(run);
  const claims = await Promise.all([
    store.claimGeneration(run.runId, 1, '2026-10-31T01:00:00.000Z'),
    store.claimGeneration(run.runId, 1, '2026-10-31T01:00:00.000Z'),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean).status, 'draft_generating');
  assert.equal(claims.find(Boolean).version, 2);
  assert.equal(claims.find(Boolean).binding.reportPath, 'reports/009-canonical.md');
  assert.match(f.calls.find((call) => /status='draft_generating'/.test(call.sql)).sql, /version=\$2 AND status='draft_pending'/);
  assert.equal(await store.claimGeneration(run.runId, 1, '2026-10-31T01:00:00.000Z'), null);
});

test('approval atomically transitions run and inserts one durable outbox intent', async () => {
  const f = fakePool(), store = createPostgresCoverLetterStore({ pool:f.pool, resolveBinding:async()=>null });
  await store.createIfAbsent(base({ status:'awaiting_review', draft:'Draft', draftSha256:'d'.repeat(64), version:3 }));
  const result = await store.approveAndEnqueue({ runId:base().runId, expectedVersion:3, expectedDraftSha256:'d'.repeat(64), approvedSha256:'d'.repeat(64), now:'2026-10-31T02:00:00.000Z' });
  assert.equal(result.run.status, 'render_pending_dispatch'); assert.equal(result.run.version, 4);
  assert.deepEqual(result.intent, { runId:base().runId, approvedSha256:'d'.repeat(64), status:'pending_dispatch' });
  assert.equal(f.outbox.size, 1); assert.deepEqual(f.calls.filter((c) => ['BEGIN','COMMIT'].includes(c.sql)).map((c) => c.sql), ['BEGIN','COMMIT']);
});

test('render claim atomically changes run and intent to rendering and advances version once', async () => {
  const f = fakePool(), store = createPostgresCoverLetterStore({ pool:f.pool, resolveBinding:async()=>null });
  const value = 'd'.repeat(64);
  await store.createIfAbsent(base({ status:'render_pending_dispatch', approvedSha256:value, draft:'Approved', draftSha256:value, version:4 }));
  f.outbox.set(base().runId, { run_id:base().runId, approved_sha256:value, status:'pending_dispatch', created_at:base().createdAt });
  const result = await store.claimRenderIntent({ runId:base().runId, expectedVersion:4, approvedSha256:value, now:'2026-10-31T02:30:00.000Z' });
  assert.equal(result.run.status,'rendering'); assert.equal(result.run.version,5); assert.equal(result.intent.status,'rendering');
  assert.equal(f.outbox.get(base().runId).status,'rendering');
  assert.deepEqual(await store.claimRenderIntent({ runId:base().runId, expectedVersion:4, approvedSha256:value, now:'2026-10-31T02:30:01.000Z' }),null);
});

test('completion atomically stores private PDF bytes, immutable receipt, and completed states; reads verify integrity', async () => {
  const f = fakePool(), store = createPostgresCoverLetterStore({ pool:f.pool, resolveBinding:async()=>null });
  const pdf=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(500,0x31)]), hash=createHash('sha256').update(pdf).digest('hex');
  const binding={applicationNumber:'7',reportNumber:'9',reportPath:'reports/009-bound.md',reportSha256:'b'.repeat(64)};
  const baseRun=base({status:'rendering',binding,draft:'Approved text',draftSha256:'d'.repeat(64),approvedSha256:'d'.repeat(64),renderIntentStatus:'rendering',version:5});
  await store.createIfAbsent(baseRun); f.outbox.set(baseRun.runId,{run_id:baseRun.runId,approved_sha256:'d'.repeat(64),status:'rendering',created_at:baseRun.createdAt});
  const receipt={runId:baseRun.runId,...binding,approvedSha256:'d'.repeat(64),contentType:'application/pdf',byteSize:pdf.length,sha256:hash};
  const saved=await store.completeRenderReceipt({runId:baseRun.runId,expectedVersion:5,approvedSha256:'d'.repeat(64),receipt,pdf,now:'2026-10-31T03:00:00.000Z'});
  assert.deepEqual(saved,receipt); assert.equal((await store.get(baseRun.runId)).status,'rendered');
  assert.equal((await store.getRenderIntent(baseRun.runId)).status,'completed');
  const artifact=await store.getArtifact(baseRun.runId); assert.deepEqual(artifact.receipt,receipt); assert.deepEqual(artifact.pdf,pdf);
  assert.deepEqual(await store.completeRenderReceipt({runId:baseRun.runId,expectedVersion:5,approvedSha256:'d'.repeat(64),receipt,pdf,now:'2026-10-31T03:01:00.000Z'}),receipt);
  f.artifacts.get(baseRun.runId).pdf_bytes[20]^=1;
  await assert.rejects(store.getArtifact(baseRun.runId),{code:'COVER_LETTER_STORE_ARTIFACT_INVALID'});
});

test('a competing claim loses its CAS and a failed artifact write rolls back completion', async () => {
  const f=fakePool(),store=createPostgresCoverLetterStore({pool:f.pool,resolveBinding:async()=>null});
  const value='d'.repeat(64),pdf=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(500,0x32)]),sha=createHash('sha256').update(pdf).digest('hex');
  const run=base({status:'render_pending_dispatch',binding:{applicationNumber:'7',reportNumber:'9',reportPath:'reports/009-bound.md',reportSha256:'b'.repeat(64)},draft:'Approved',draftSha256:value,approvedSha256:value,version:4});
  await store.createIfAbsent(run); f.outbox.set(run.runId,{run_id:run.runId,approved_sha256:value,status:'pending_dispatch',created_at:run.createdAt});
  const first=await store.claimRenderIntent({runId:run.runId,expectedVersion:4,approvedSha256:value,now:run.updatedAt});
  assert.equal(await store.claimRenderIntent({runId:run.runId,expectedVersion:4,approvedSha256:value,now:run.updatedAt}),null);
  const receipt={runId:run.runId,...run.binding,approvedSha256:value,contentType:'application/pdf',byteSize:pdf.length,sha256:sha};
  const originalConnect=f.pool.connect;
  f.pool.connect=async()=>{const client=await originalConnect();const q=client.query;client.query=async(sql,args)=>{if(/INSERT INTO career_ops_cover_letter_artifacts/.test(sql))throw new Error('synthetic artifact insert failure');return q(sql,args);};return client;};
  await assert.rejects(store.completeRenderReceipt({runId:run.runId,expectedVersion:first.run.version,approvedSha256:value,receipt,pdf,now:'2026-10-31T04:00:00.000Z'}),/synthetic artifact insert failure/);
  assert.equal((await store.get(run.runId)).status,'rendering');assert.equal(f.outbox.get(run.runId).status,'rendering');assert.equal(f.artifacts.size,0);
  assert.ok(f.calls.some((call)=>call.sql==='ROLLBACK'));
});

test('failed outbox insert rolls the state transition back', async () => {
  const f = fakePool(), originalQuery = f.pool.query;
  f.pool.query = async (sql, values) => { if (/INSERT INTO career_ops_cover_letter_render_outbox/.test(sql)) throw new Error('db unavailable'); return originalQuery(sql, values); };
  f.pool.connect = async () => ({ query:f.pool.query, release() {} });
  const store = createPostgresCoverLetterStore({ pool:f.pool, resolveBinding:async()=>null });
  await store.createIfAbsent(base({ status:'awaiting_review', draft:'Draft', draftSha256:'d'.repeat(64), version:3 }));
  await assert.rejects(store.approveAndEnqueue({ runId:base().runId, expectedVersion:3, expectedDraftSha256:'d'.repeat(64), approvedSha256:'d'.repeat(64), now:'2026-10-31T02:00:00.000Z' }), /db unavailable/);
  assert.equal((await store.get(base().runId)).status, 'awaiting_review'); assert.equal(f.outbox.size, 0);
  assert.ok(f.calls.some((call) => call.sql === 'ROLLBACK'));
});
