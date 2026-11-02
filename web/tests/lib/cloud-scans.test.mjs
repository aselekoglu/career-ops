import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudScanStore, workerAuthorized, workerConfigured, handleScanWorker } from '../../src/lib/cloud-scans.mjs';

const env = { DATABASE_URL:'test',CAREER_OPS_SCAN_DISPATCH_TOKEN:'dispatch-test',CAREER_OPS_SCAN_WORKER_SECRET:'worker-test',CAREER_OPS_SCAN_REF:'reviewed-ref' };
const receipt = { version:'careerops.scan.live@1',startedAt:'2026-10-01T15:00:00Z',completedAt:'2026-10-01T15:01:00Z',found:1,
  sources:[{company:'Example',source:'greenhouse',status:'ok'}],errors:[],jobs:[{company:'Example',title:'Engineer',url:'https://example.com/1',postedAt:Date.parse('2026-09-29'),source:'greenhouse-api',known:false}] };
function fixture({ dispatch = async()=>{}, collision = false } = {}) {
  let row;
  let pipeline = '# Pipeline\n';
  const queries=[];
  const sql = { query:async (query, args) => {
    queries.push(query);
    if (query.startsWith('CREATE ') || query.includes("requested_at < now()")) return [];
    if (query.startsWith('SELECT content,sha256')) {
      if (args[0]==='portals.yml') return [{content:'tracked_companies:\n  - name: Example\ntitle_filter:\n  positive: [Engineer]'}];
      if (args[0]==='data/pipeline.md') return [{content:pipeline,sha256:'old-hash'}];
      return [];
    }
    if (query.startsWith('INSERT INTO career_ops_live_scans')) {
      if (row && ['queued','running'].includes(row.state)) throw Object.assign(new Error('busy'),{code:'23505'});
      row={id:args[0],state:'queued',request:JSON.parse(args[1]),requested_at:'2026-10-01T14:59:00Z',started_at:null,completed_at:null}; return [];
    }
    if (query.startsWith('SELECT * FROM')) return row ? [structuredClone(row)] : [];
    if (query.startsWith('SELECT id FROM')) return row ? [{id:row.id}] : [];
    if (query.includes("SET state='running'")) {
      if (row?.id!==args[0] || row.state!=='queued') return [];
      Object.assign(row,{state:'running',lease:args[1],started_at:'2026-10-01T15:00:00Z'}); return [structuredClone(row)];
    }
    if (query.startsWith('WITH valid AS')) {
      if (collision) return [];
      assert.equal(args[5],'old-hash');
      pipeline=args[2]; Object.assign(row,{state:args[6],result:JSON.parse(args[7]),completed_at:'2026-10-01T15:01:01Z'}); return [structuredClone(row)];
    }
    if (query.includes("SET state='failed'")) {
      if (query.includes('$3::uuid') && !((row.state==='queued' && !args[2]) || (row.state==='running' && row.lease===args[2]))) return [];
      Object.assign(row,{state:'failed',error_code:args[1]??'WORKER_DISPATCH_FAILED',completed_at:'2026-10-01T15:01:00Z'}); return [];
    }
    throw new Error('Unhandled test SQL: '+query);
  } };
  return {store:createCloudScanStore({sql,env,dispatch}),queries,get pipeline(){return pipeline;}};
}
test('worker readiness and authorization reject missing, incorrect and browser Basic credentials', async()=>{
  assert.equal(workerConfigured({}),false); assert.equal(workerConfigured(env),true);
  for(const auth of [null,'Basic abc','Bearer wrong','Bearer ']) assert.equal(workerAuthorized(auth,env),false);
  assert.equal(workerAuthorized('Bearer worker-test',env),true);
  assert.equal((await handleScanWorker(new Request('https://example.com/api/scan-worker',{method:'POST'}))).status,401);
});
test('start dispatches immediately, returns queued run ID and cannot be mistaken for completed data',async()=>{
  let dispatched; const f=fixture({dispatch:async id=>{dispatched=id;}});
  const run=await f.store.start({sinceDays:5}); assert.equal(run.scanId,dispatched); assert.equal(run.status,'queued'); assert.equal(run.fresh,false); assert.equal(run.startedAt,null);
});
test('dispatch failure is durable and releases the single-active-scan gate',async()=>{
  const f=fixture({dispatch:async()=>{throw new Error('API unavailable');}});
  const run=await f.store.start({}); assert.equal(run.status,'failed'); assert.equal(run.errorCode,'WORKER_DISPATCH_FAILED');
});
test('concurrent starts expose the active run ID and a duplicate worker cannot claim it',async()=>{
  const f=fixture(),run=await f.store.start({});
  await assert.rejects(f.store.start({}),e=>e.message==='SCAN_ALREADY_ACTIVE'&&e.scanId===run.scanId);
  const claim=await f.store.claim(run.scanId); assert.ok(claim.lease); assert.equal(await f.store.claim(run.scanId),null);
  assert.equal(claim.documents['cv.md'],undefined);
  await f.store.fail(run.scanId); assert.equal((await f.store.get(run.scanId)).status,'running');
  await f.store.fail(run.scanId,'WORKER_FAILED',claim.lease); assert.equal((await f.store.get(run.scanId)).status,'failed');
});
test('completion atomically persists inbox and result and is idempotent',async()=>{
  const f=fixture(),run=await f.store.start({}),claim=await f.store.claim(run.scanId);
  const completed=await f.store.complete(run.scanId,claim.lease,receipt);
  assert.equal(completed.status,'completed'); assert.equal(completed.newJobs,1); assert.ok(f.pipeline.includes('https://example.com/1'));
  assert.deepEqual(await f.store.complete(run.scanId,claim.lease,receipt),completed);
  await assert.rejects(f.store.complete(run.scanId,'33333333-3333-4333-8333-333333333333',receipt));
});
test('a concurrent inbox import cannot be overwritten; stale snapshot cannot complete a run',async()=>{
  const f=fixture({collision:true}),run=await f.store.start({}),claim=await f.store.claim(run.scanId);
  await assert.rejects(f.store.complete(run.scanId,claim.lease,receipt),/INBOX_WRITE_CONFLICT/); assert.equal(f.pipeline,'# Pipeline\n');
  await assert.rejects(f.store.complete(run.scanId,claim.lease,{inbox:[],applications:[]}));
});
test('status/results reject invalid IDs and pagination and only read the selected run',async()=>{
  const f=fixture();await assert.rejects(f.store.get('../secret')); const run=await f.store.start({});
  await assert.rejects(f.store.get(run.scanId,0)); await assert.rejects(f.store.get(run.scanId,2,-1)); assert.equal((await f.store.get(run.scanId)).scanId,run.scanId);
});
