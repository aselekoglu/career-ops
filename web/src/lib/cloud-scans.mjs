import { neon } from '@neondatabase/serverless';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { UUID_RE, validateScanInput, selectScanConfig, buildLiveResult, pipelineAdditions } from './live-scan-contract.mjs';

const TABLE = `CREATE TABLE IF NOT EXISTS career_ops_live_scans (
  id UUID PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('queued','running','completed','partial','failed')),
  request JSONB NOT NULL, result JSONB, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, lease UUID, error_code TEXT, workflow_url TEXT
)`;
const ACTIVE_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS career_ops_one_active_scan ON career_ops_live_scans ((true)) WHERE state IN ('queued','running')";
const INPUT_PATHS = ['portals.yml', 'config/profile.yml', 'data/applications.md', 'data/pipeline.md', 'data/scan-history.tsv', 'data/blacklist.md'];
const sha = text => createHash('sha256').update(text).digest('hex');
export const workerConfigured = (env = process.env) => Boolean(env.DATABASE_URL && env.CAREER_OPS_SCAN_DISPATCH_TOKEN && env.CAREER_OPS_SCAN_WORKER_SECRET && env.CAREER_OPS_SCAN_REF);
export function workerAuthorized(value, env = process.env) {
  const expected = env.CAREER_OPS_SCAN_WORKER_SECRET;
  if (!expected || !value?.startsWith('Bearer ')) return false;
  return timingSafeEqual(createHash('sha256').update(value.slice(7)).digest(), createHash('sha256').update(expected).digest());
}

function publicRun(row, limit = row?.request?.limit ?? 50, offset = 0) {
  if (!row) return null;
  const result = row.result;
  return { ...(result ?? {}), scanId: row.id, status: row.state, fresh: Boolean(result),
    requestedAt: new Date(row.requested_at).toISOString(), startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    errorCode: row.error_code ?? null, workflowUrl: row.workflow_url ?? null,
    ...(result ? { jobs: result.jobs.slice(offset, offset + limit), unknownJobs: result.unknownJobs.slice(offset, offset + limit),
      pagination: { offset, limit, nextOffset: offset + limit < Math.max(result.jobs.length, result.unknownJobs.length) ? offset + limit : null } } : {}) };
}

export async function dispatchScan(id, env, fetchFn = fetch) {
  const response = await fetchFn('https://api.github.com/repos/aselekoglu/career-ops/actions/workflows/career-ops-live-scan.yml/dispatches', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + env.CAREER_OPS_SCAN_DISPATCH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.CAREER_OPS_SCAN_REF, inputs: { scan_id: id } }),
  });
  if (!response.ok) throw new Error('WORKER_DISPATCH_FAILED');
}

export function createCloudScanStore({ sql, env = process.env, dispatch = dispatchScan }) {
  let initialized;
  async function ready() {
    if (!initialized) initialized = (async () => { await sql.query(TABLE, []); await sql.query(ACTIVE_INDEX, []); })().catch(e => { initialized = null; throw e; });
    await initialized;
    await sql.query("UPDATE career_ops_live_scans SET state='failed', error_code='WORKER_TIMEOUT', completed_at=now() WHERE state IN ('queued','running') AND requested_at < now() - interval '45 minutes'", []);
  }
  const readDocument = async path => (await sql.query('SELECT content,sha256 FROM career_ops_documents WHERE path=$1 AND content_encoding=\'utf8\'', [path]))[0] ?? null;
  const find = async id => (await sql.query('SELECT * FROM career_ops_live_scans WHERE id=$1', [id]))[0] ?? null;
  return {
    async start(input) {
      if (!workerConfigured(env)) throw new Error('SCAN_WORKER_NOT_CONFIGURED');
      const request = validateScanInput(input);
      const portals = await readDocument('portals.yml');
      if (!portals) throw new Error('PORTALS_NOT_IMPORTED');
      selectScanConfig(parseYaml(portals.content), request);
      await ready(); const id = randomUUID();
      try { await sql.query("INSERT INTO career_ops_live_scans(id,state,request) VALUES($1,'queued',$2::jsonb)", [id, JSON.stringify(request)]); }
      catch (error) {
        if (error.code === '23505') {
          const active = (await sql.query("SELECT id FROM career_ops_live_scans WHERE state IN ('queued','running') ORDER BY requested_at LIMIT 1", []))[0];
          const busy = new Error('SCAN_ALREADY_ACTIVE'); busy.scanId = active?.id ?? null; throw busy;
        }
        throw error;
      }
      try { await dispatch(id, env); }
      catch { await sql.query("UPDATE career_ops_live_scans SET state='failed',error_code='WORKER_DISPATCH_FAILED',completed_at=now() WHERE id=$1 AND state='queued'", [id]); }
      return publicRun(await find(id));
    },
    async get(id, limit, offset = 0) {
      if (!UUID_RE.test(id)) throw new Error('INVALID_SCAN_ID');
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw new Error('INVALID_LIMIT');
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('INVALID_OFFSET');
      await ready(); return publicRun(await find(id), limit, offset);
    },
    async claim(id) {
      if (!UUID_RE.test(id)) throw new Error('INVALID_SCAN_ID');
      await ready(); const lease = randomUUID();
      const rows = await sql.query("UPDATE career_ops_live_scans SET state='running',lease=$2,started_at=now() WHERE id=$1 AND state='queued' RETURNING *", [id, lease]);
      const row = rows[0]; if (!row) return null;
      try {
        const documents = {};
        for (const path of INPUT_PATHS) {
          const doc = await readDocument(path);
          if (doc) documents[path] = doc.content;
        }
        const config = selectScanConfig(parseYaml(documents['portals.yml']), row.request);
        documents['portals.yml'] = dumpYaml(config, { noRefs: true });
        const profile = parseYaml(documents['config/profile.yml']?.trim() || '{}') ?? {};
        documents['config/profile.yml'] = dumpYaml({ location: { country: profile.location?.country ?? '' }, re_apply_windows: profile.re_apply_windows ?? {} }, { noRefs: true });
        // Only company/role and URLs are needed for dedup; avoid sending tracker notes to the worker.
        documents['data/applications.md'] = (documents['data/applications.md'] ?? '').split('\n').map(line => line.startsWith('|') ? line.split('|').slice(0, 8).join('|') + '|' : '').join('\n');
        return { scanId: id, lease, request: row.request, documents };
      } catch (error) { await this.fail(id, 'WORKER_INPUT_FAILED', lease); throw error; }
    },
    async complete(id, lease, receipt) {
      if (!UUID_RE.test(id) || !UUID_RE.test(lease)) throw new Error('INVALID_WORKER_CLAIM');
      await ready(); const row = await find(id);
      if (!row || row.lease !== lease) throw new Error('INVALID_WORKER_CLAIM');
      if (!['running'].includes(row.state)) return publicRun(row);
      const result = buildLiveResult(receipt, row.request);
      // The worker receipt uses its actual scanner timestamps; requestedAt/startedAt
      // stay distinct from queue time and claim time in the record.
      result.scanStartedAt = result.startedAt; result.scanCompletedAt = result.completedAt;
      for (let attempt = 0; attempt < 3; attempt++) {
        const prior = await readDocument('data/pipeline.md');
        const additions = pipelineAdditions(prior?.content ?? '# Pipeline\n', result);
        result.newJobs = additions.newJobs;
        const content = additions.content;
        const rows = await sql.query(`WITH valid AS (
          SELECT id FROM career_ops_live_scans WHERE id=$1 AND lease=$2 AND state='running' FOR UPDATE
        ), persisted AS (
          INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
          SELECT 'data/pipeline.md',$3,$4,'utf8',$5,now() FROM valid
          ON CONFLICT(path) DO UPDATE SET content=EXCLUDED.content,sha256=EXCLUDED.sha256,byte_size=EXCLUDED.byte_size,updated_at=now()
          WHERE career_ops_documents.sha256 IS NOT DISTINCT FROM $6 RETURNING path
        ) UPDATE career_ops_live_scans SET state=$7,result=$8::jsonb,completed_at=now()
          WHERE id=$1 AND lease=$2 AND state='running' AND EXISTS(SELECT 1 FROM persisted) RETURNING *`,
          [id, lease, content, sha(content), Buffer.byteLength(content), prior?.sha256 ?? null, result.status, JSON.stringify(result)]);
        if (rows[0]) return publicRun(rows[0]);
        const current = await find(id); if (current.state !== 'running') return publicRun(current);
      }
      throw new Error('INBOX_WRITE_CONFLICT');
    },
    async fail(id, code = 'WORKER_FAILED', lease = null) {
      if (!UUID_RE.test(id)) throw new Error('INVALID_SCAN_ID'); await ready();
      if (lease !== null && !UUID_RE.test(lease)) throw new Error('INVALID_WORKER_CLAIM');
      await sql.query("UPDATE career_ops_live_scans SET state='failed',error_code=$2,completed_at=now() WHERE id=$1 AND ((state='queued' AND lease IS NULL AND $3::uuid IS NULL) OR (state='running' AND lease=$3::uuid))", [id, ['WORKER_FAILED','WORKER_INPUT_FAILED','WORKER_CALLBACK_FAILED'].includes(code) ? code : 'WORKER_FAILED', lease]);
      return publicRun(await find(id));
    },
  };
}

let store;
function getStore() {
  if (!process.env.DATABASE_URL) throw new Error('SCAN_WORKER_NOT_CONFIGURED');
  return store ??= createCloudScanStore({ sql: neon(process.env.DATABASE_URL) });
}
const response = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
/** @param {Request} request @param {string|null} id */
export async function handleScanRequest(request, id = null) {
  try {
    if (id) {
      const url = new URL(request.url), limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
      const result = await getStore().get(id, limit, Number(url.searchParams.get('offset') ?? 0));
      return result ? response(result) : response({ code: 'SCAN_NOT_FOUND' }, 404);
    }
    if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return response({ code: 'ORIGIN_DENIED' }, 403);
    if (!request.headers.get('content-type')?.includes('application/json')) return response({ code: 'JSON_REQUIRED' }, 415);
    if (Number(request.headers.get('content-length') ?? 0) > 32000) return response({ code: 'REQUEST_TOO_LARGE' }, 413);
    const body = await request.json();
    return response(await getStore().start(body), 202);
  } catch (error) {
    const code = String(error.message);
    const status = code === 'SCAN_WORKER_NOT_CONFIGURED' ? 503 : code === 'SCAN_ALREADY_ACTIVE' ? 409 : /^INVALID_|Invalid |Only portals|Company |No enabled|Configured title/.test(code) ? 400 : 500;
    return response({ code: status === 500 ? 'SCAN_API_FAILED' : code, ...(status === 409 ? { scanId: error.scanId } : {}) }, status);
  }
}
export async function handleScanWorker(request) {
  if (!workerAuthorized(request.headers.get('authorization'))) return response({ code: 'WORKER_UNAUTHORIZED' }, 401);
  if (!request.headers.get('content-type')?.includes('application/json')) return response({ code: 'JSON_REQUIRED' }, 415);
  if (Number(request.headers.get('content-length') ?? 0) > 8_000_000) return response({ code: 'REQUEST_TOO_LARGE' }, 413);
  try {
    const body = await request.json();
    if (!UUID_RE.test(body.scanId) || !['claim','complete','fail'].includes(body.action)) return response({ code: 'INVALID_WORKER_REQUEST' }, 400);
    const service = getStore();
    const result = body.action === 'claim' ? await service.claim(body.scanId) : body.action === 'complete' ? await service.complete(body.scanId, body.lease, body.receipt) : await service.fail(body.scanId, 'WORKER_FAILED', body.lease ?? null);
    return response(result ?? { code: 'SCAN_NOT_CLAIMABLE' }, result ? 200 : 409);
  } catch { return response({ code: 'WORKER_API_FAILED' }, 500); }
}
