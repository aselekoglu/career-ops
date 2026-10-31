/**
 * Single-owner Postgres persistence for cover-letter runs. This schema does not
 * provide cross-tenant isolation; callers must enforce owner authentication.
 * Binding data always comes from the injected canonical resolver.
 */
const RUNS_TABLE = 'career_ops_cover_letter_runs';
const OUTBOX_TABLE = 'career_ops_cover_letter_render_outbox';
const ARTIFACTS_TABLE = 'career_ops_cover_letter_artifacts';
const MAX_PDF_BYTES = 8_000_000;
const MIN_PDF_BYTES = 500;
const HASH_RE = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const COVER_LETTER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (
  run_id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('draft_pending','draft_generating','awaiting_review','render_pending_dispatch','rendering','rendered','canceled')),
  binding JSONB NOT NULL,
  prerequisites JSONB NOT NULL,
  draft TEXT,
  draft_sha256 TEXT,
  approved_sha256 TEXT,
  render_intent_status TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
  run_id UUID PRIMARY KEY REFERENCES ${RUNS_TABLE}(run_id),
  approved_sha256 TEXT NOT NULL CHECK (approved_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending_dispatch','rendering','completed','dispatched','failed')),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS ${ARTIFACTS_TABLE} (
  run_id UUID PRIMARY KEY REFERENCES ${RUNS_TABLE}(run_id),
  receipt JSONB NOT NULL,
  pdf_bytes BYTEA NOT NULL CHECK (octet_length(pdf_bytes) BETWEEN ${MIN_PDF_BYTES} AND ${MAX_PDF_BYTES}),
  created_at TIMESTAMPTZ NOT NULL
);`;

function parseJson(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}
function mapRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    binding: parseJson(row.binding),
    prerequisites: parseJson(row.prerequisites),
    draft: row.draft,
    draftSha256: row.draft_sha256,
    approvedSha256: row.approved_sha256,
    renderIntentStatus: row.render_intent_status,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
function safeFailure(code) { return Object.assign(new Error(code), { code }); }
function validReceiptForRun(receipt, run, bytes) {
  return receipt && receipt.runId === run.runId && receipt.applicationNumber === run.binding.applicationNumber &&
    receipt.reportNumber === run.binding.reportNumber && receipt.reportPath === run.binding.reportPath &&
    receipt.reportSha256 === run.binding.reportSha256 && receipt.approvedSha256 === run.approvedSha256 &&
    receipt.contentType === 'application/pdf' && Number.isSafeInteger(receipt.byteSize) &&
    receipt.byteSize >= MIN_PDF_BYTES && receipt.byteSize <= MAX_PDF_BYTES && HASH_RE.test(receipt.sha256 || '') &&
    Buffer.isBuffer(bytes) && bytes.length === receipt.byteSize && digest(bytes) === receipt.sha256 && bytes.subarray(0,5).toString('ascii') === '%PDF-';
}

/**
 * @param {{pool:{query:Function,connect:Function}, resolveBinding:Function}} options
 * pool follows the node-postgres Pool contract. Schema creation is explicit via
 * ensureSchema so application startup owns migrations, not request handlers.
 */
export function createPostgresCoverLetterStore({ pool, resolveBinding } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function' || typeof resolveBinding !== 'function') {
    throw Object.assign(new Error('COVER_LETTER_STORE_UNAVAILABLE'), { code: 'COVER_LETTER_STORE_UNAVAILABLE' });
  }

  async function createIfAbsent(run) {
    const inserted = await pool.query(`INSERT INTO ${RUNS_TABLE}
      (run_id,idempotency_key,request_fingerprint,status,binding,prerequisites,draft,draft_sha256,approved_sha256,render_intent_status,version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [run.runId, run.idempotencyKey, run.requestFingerprint, run.status, JSON.stringify(run.binding), JSON.stringify(run.prerequisites), run.draft, run.draftSha256, run.approvedSha256, run.renderIntentStatus, run.version, run.createdAt, run.updatedAt]);
    if (inserted.rows[0]) return mapRun(inserted.rows[0]);
    const existing = await pool.query(`SELECT * FROM ${RUNS_TABLE} WHERE idempotency_key=$1`, [run.idempotencyKey]);
    return mapRun(existing.rows[0]);
  }

  async function update(runId, expectedVersion, patch) {
    const allowed = new Set(['status','draft','draftSha256','approvedSha256','renderIntentStatus','updatedAt']);
    if (Object.keys(patch).some((key) => !allowed.has(key))) throw new TypeError('Unsupported cover-letter run update');
    const updated = await pool.query(`UPDATE ${RUNS_TABLE} SET
      status=COALESCE($3,status), draft=CASE WHEN $4::boolean THEN $5 ELSE draft END,
      draft_sha256=CASE WHEN $6::boolean THEN $7 ELSE draft_sha256 END,
      approved_sha256=CASE WHEN $8::boolean THEN $9 ELSE approved_sha256 END,
      render_intent_status=CASE WHEN $10::boolean THEN $11 ELSE render_intent_status END,
      updated_at=COALESCE($12::timestamptz,updated_at), version=version+1
      WHERE run_id=$1 AND version=$2 RETURNING *`, [runId, expectedVersion,
      patch.status ?? null, Object.hasOwn(patch,'draft'), patch.draft ?? null,
      Object.hasOwn(patch,'draftSha256'), patch.draftSha256 ?? null,
      Object.hasOwn(patch,'approvedSha256'), patch.approvedSha256 ?? null,
      Object.hasOwn(patch,'renderIntentStatus'), patch.renderIntentStatus ?? null, patch.updatedAt ?? null]);
    return mapRun(updated.rows[0]);
  }

  async function claimGeneration(runId, expectedVersion, now) {
    const result = await pool.query(`UPDATE ${RUNS_TABLE} SET status='draft_generating', updated_at=$3, version=version+1
      WHERE run_id=$1 AND version=$2 AND status='draft_pending' RETURNING *`, [runId, expectedVersion, now]);
    return mapRun(result.rows[0]);
  }

  async function approveAndEnqueue({ runId, expectedVersion, expectedDraftSha256, approvedSha256, now }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updateResult = await client.query(`UPDATE ${RUNS_TABLE} SET status='render_pending_dispatch', approved_sha256=$4,
        render_intent_status='pending_dispatch', updated_at=$5, version=version+1
        WHERE run_id=$1 AND version=$2 AND status='awaiting_review' AND draft_sha256=$3
        RETURNING *`, [runId, expectedVersion, expectedDraftSha256, approvedSha256, now]);
      if (!updateResult.rows[0]) { await client.query('ROLLBACK'); return null; }
      const intentResult = await client.query(`INSERT INTO ${OUTBOX_TABLE}(run_id,approved_sha256,status,created_at)
        VALUES ($1,$2,'pending_dispatch',$3) ON CONFLICT (run_id) DO NOTHING RETURNING *`, [runId, approvedSha256, now]);
      let intent = intentResult.rows[0];
      if (!intent) {
        const existing = await client.query(`SELECT * FROM ${OUTBOX_TABLE} WHERE run_id=$1`, [runId]);
        intent = existing.rows[0];
      }
      if (!intent || intent.approved_sha256 !== approvedSha256) throw new Error('Conflicting render intent');
      await client.query('COMMIT');
      return { run: mapRun(updateResult.rows[0]), intent: { runId: intent.run_id, approvedSha256: intent.approved_sha256, status: intent.status } };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async function getRenderIntent(runId) {
    const result = await pool.query(`SELECT r.*,o.run_id AS intent_run_id,o.approved_sha256 AS intent_approved_sha256,o.status AS intent_status,a.receipt,a.pdf_bytes
      FROM ${OUTBOX_TABLE} o JOIN ${RUNS_TABLE} r ON r.run_id=o.run_id
      LEFT JOIN ${ARTIFACTS_TABLE} a ON a.run_id=o.run_id WHERE o.run_id=$1`, [runId]);
    const row = result.rows[0];
    if (!row) return null;
    const intent = { runId:row.intent_run_id, approvedSha256:row.intent_approved_sha256, status:row.intent_status };
    if (row.receipt != null) {
      const receipt=parseJson(row.receipt), run=mapRun(row), bytes=Buffer.isBuffer(row.pdf_bytes)?row.pdf_bytes:Buffer.from(row.pdf_bytes);
      if (run.status!=='rendered' || intent.status!=='completed' || !validReceiptForRun(receipt,run,bytes)) throw safeFailure('COVER_LETTER_STORE_ARTIFACT_INVALID');
      intent.receipt=receipt;
    } else if (row.intent_status==='completed') throw safeFailure('COVER_LETTER_STORE_ARTIFACT_INVALID');
    return intent;
  }

  async function claimRenderIntent({ runId, expectedVersion, approvedSha256, now }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimedRun = await client.query(`UPDATE ${RUNS_TABLE} SET status='rendering',render_intent_status='rendering',updated_at=$4,version=version+1
        WHERE run_id=$1 AND version=$2 AND status='render_pending_dispatch' AND approved_sha256=$3 RETURNING *`, [runId, expectedVersion, approvedSha256, now]);
      if (!claimedRun.rows[0]) { await client.query('ROLLBACK'); return null; }
      const claimedIntent = await client.query(`UPDATE ${OUTBOX_TABLE} SET status='rendering'
        WHERE run_id=$1 AND approved_sha256=$2 AND status='pending_dispatch' RETURNING *`, [runId, approvedSha256]);
      if (!claimedIntent.rows[0]) { await client.query('ROLLBACK'); return null; }
      await client.query('COMMIT');
      return { claimed:true, run:mapRun(claimedRun.rows[0]), intent:{ runId:claimedIntent.rows[0].run_id, approvedSha256:claimedIntent.rows[0].approved_sha256, status:claimedIntent.rows[0].status } };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async function completeRenderReceipt({ runId, expectedVersion, approvedSha256, receipt, pdf, now }) {
    const bytes = Buffer.isBuffer(pdf) ? pdf : pdf instanceof Uint8Array ? Buffer.from(pdf) : null;
    if (!bytes || bytes.length < MIN_PDF_BYTES || bytes.length > MAX_PDF_BYTES || bytes.subarray(0,5).toString('ascii') !== '%PDF-' ||
        !receipt || !HASH_RE.test(receipt.sha256 || '') || digest(bytes) !== receipt.sha256 || receipt.byteSize !== bytes.length) throw safeFailure('COVER_LETTER_STORE_RECEIPT_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(`SELECT * FROM ${RUNS_TABLE} WHERE run_id=$1 FOR UPDATE`, [runId]);
      const row = selected.rows[0];
      if (!row) { await client.query('ROLLBACK'); return null; }
      const run = mapRun(row);
      if (run.status === 'rendered') {
        const prior = await client.query(`SELECT receipt,pdf_bytes FROM ${ARTIFACTS_TABLE} WHERE run_id=$1`, [runId]);
        const priorIntent = await client.query(`SELECT approved_sha256,status FROM ${OUTBOX_TABLE} WHERE run_id=$1 FOR UPDATE`, [runId]);
        const priorReceipt = prior.rows[0] ? parseJson(prior.rows[0].receipt) : null;
        const priorBytes = prior.rows[0]?.pdf_bytes;
        if (!priorIntent.rows[0] || priorIntent.rows[0].status !== 'completed' || priorIntent.rows[0].approved_sha256 !== approvedSha256 ||
            !validReceiptForRun(priorReceipt, run, priorBytes) || !validReceiptForRun(receipt, run, bytes) || priorReceipt.sha256 !== receipt.sha256) throw safeFailure('COVER_LETTER_STORE_RECEIPT_CONFLICT');
        await client.query('COMMIT'); return priorReceipt;
      }
      if (run.status !== 'rendering' || run.version !== expectedVersion || !HASH_RE.test(approvedSha256 || '') || run.approvedSha256 !== approvedSha256 ||
          !validReceiptForRun(receipt, run, bytes)) { await client.query('ROLLBACK'); return null; }
      const intent = await client.query(`SELECT * FROM ${OUTBOX_TABLE} WHERE run_id=$1 FOR UPDATE`, [runId]);
      if (!intent.rows[0] || intent.rows[0].status !== 'rendering' || intent.rows[0].approved_sha256 !== approvedSha256) { await client.query('ROLLBACK'); return null; }
      await client.query(`INSERT INTO ${ARTIFACTS_TABLE}(run_id,receipt,pdf_bytes,created_at) VALUES ($1,$2::jsonb,$3,$4)`, [runId, JSON.stringify(receipt), bytes, now]);
      await client.query(`UPDATE ${OUTBOX_TABLE} SET status='completed' WHERE run_id=$1 AND status='rendering'`, [runId]);
      const updated = await client.query(`UPDATE ${RUNS_TABLE} SET status='rendered',render_intent_status='completed',updated_at=$3,version=version+1
        WHERE run_id=$1 AND version=$2 AND status='rendering' AND approved_sha256=$4 RETURNING *`, [runId, expectedVersion, now, approvedSha256]);
      if (!updated.rows[0]) throw safeFailure('COVER_LETTER_STORE_STALE');
      await client.query('COMMIT'); return structuredClone(receipt);
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async function getArtifact(runId) {
    const result = await pool.query(`SELECT r.*,a.receipt,a.pdf_bytes FROM ${RUNS_TABLE} r JOIN ${ARTIFACTS_TABLE} a ON a.run_id=r.run_id WHERE r.run_id=$1`, [runId]);
    const row = result.rows[0];
    if (!row) return null;
    const run = mapRun(row), receipt = parseJson(row.receipt), bytes = Buffer.isBuffer(row.pdf_bytes) ? row.pdf_bytes : Buffer.from(row.pdf_bytes);
    if (run.status !== 'rendered' || !validReceiptForRun(receipt, run, bytes)) throw safeFailure('COVER_LETTER_STORE_ARTIFACT_INVALID');
    return { receipt:structuredClone(receipt), pdf:Buffer.from(bytes) };
  }

  return Object.freeze({
    ensureSchema: () => pool.query(COVER_LETTER_SCHEMA_SQL),
    resolveBinding: (applicationNumber, reportNumber) => resolveBinding(applicationNumber, reportNumber),
    createIfAbsent,
    async get(runId) { const result = await pool.query(`SELECT * FROM ${RUNS_TABLE} WHERE run_id=$1`, [runId]); return mapRun(result.rows[0]); },
    update,
    claimGeneration,
    approveAndEnqueue,
    getRenderIntent,
    claimRenderIntent,
    completeRenderReceipt,
    getArtifact,
  });
}
import { createHash } from 'node:crypto';
