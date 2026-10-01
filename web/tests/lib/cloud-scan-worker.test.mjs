import test from 'node:test';
import assert from 'node:assert/strict';
import { runCloudWorker, readScannerReceipt } from '../../scripts/cloud-scan-worker.mjs';
const id = '11111111-1111-4111-8111-111111111111', lease = '22222222-2222-4222-8222-222222222222';
const receipt = { version:'careerops.scan.live@1',startedAt:'2026-10-01T15:00:00Z',completedAt:'2026-10-01T15:01:00Z',sources:[],errors:[],jobs:[] };
test('worker executes the existing scanner and completes using its claim', async () => {
  const actions = [];
  const fetchFn = async (url, opts) => {
    assert.equal(url, 'https://career-ops-aselekoglu.vercel.app/api/scan-worker'); assert.equal(opts.headers.Authorization, 'Bearer test-secret');
    const body = JSON.parse(opts.body); actions.push(body.action);
    if (body.action === 'claim') return Response.json({ lease, request:{sinceDays:5}, documents:{'portals.yml':'tracked_companies: []'} });
    assert.equal(body.lease, lease); return Response.json({ status:'completed',jobsMatched:0 });
  };
  const result = await runCloudWorker({ id,secret:'test-secret',fetchFn,scanner:async (_root,days) => { assert.equal(days,5); return receipt; } });
  assert.equal(result.status,'completed'); assert.deepEqual(actions,['claim','complete']);
});
test('worker/API failure attempts durable failed-state persistence', async () => {
  const actions=[];
  await assert.rejects(runCloudWorker({ id,secret:'test-secret',fetchFn:async (_url,opts) => {
    const action=JSON.parse(opts.body).action; actions.push(action); return action==='fail' ? Response.json({status:'failed'}) : new Response('',{status:503});
  } }));
  assert.deepEqual(actions,['claim','fail']);
});
test('worker refuses path traversal, CV data and malformed scan IDs', async () => {
  for (const name of ['../secret','cv.md']) {
    await assert.rejects(runCloudWorker({ id,secret:'test-secret',fetchFn:async (_u,opts) => JSON.parse(opts.body).action==='claim' ? Response.json({lease,request:{sinceDays:5},documents:{[name]:'private'}}) : Response.json({status:'failed'}) }));
  }
  await assert.rejects(runCloudWorker({id:'bad',secret:'test-secret'}));
});
test('JSON scanner receipt extraction ignores diagnostic preamble and rejects stale snapshots', () => {
  assert.equal(readScannerReceipt('diagnostic\n'+JSON.stringify(receipt)).version,receipt.version);
  assert.throws(()=>readScannerReceipt(JSON.stringify({inbox:[]})));
});
test('a duplicate worker claim cannot mark the original active scan failed',async()=>{
  const actions=[];
  await assert.rejects(runCloudWorker({id,secret:'test-secret',fetchFn:async(_u,opts)=>{
    actions.push(JSON.parse(opts.body).action);return Response.json({code:'SCAN_NOT_CLAIMABLE'},{status:409});
  }}),/SCAN_NOT_CLAIMABLE/);
  assert.deepEqual(actions,['claim']);
});
