import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCoverLetterArtifactApi } from '../../src/lib/cover-letter-artifact-api.mjs';

const runId='11111111-1111-4111-8111-111111111111';
const pdf=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(500,0x41)]);
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
function artifact(overrides={}) { return { receipt:{runId,applicationNumber:'7',reportNumber:'9',reportPath:'reports/009-bound.md',reportSha256:'b'.repeat(64),approvedSha256:'c'.repeat(64),contentType:'application/pdf',byteSize:pdf.length,sha256:hash(pdf),...overrides.receipt},pdf:overrides.pdf??pdf }; }
function fixture({authorized=true,value=artifact(),throwRead=false}={}) { let reads=0;const api=createCoverLetterArtifactApi({authorize:async()=>authorized,store:{async getArtifact(id){reads++;if(throwRead)throw new Error('secret db error');return id===runId?value:null;}}});return{api,get reads(){return reads;}}; }

test('unauthorized and invalid identifiers never look up an artifact', async()=>{
  const denied=fixture({authorized:false});const deniedResponse=await denied.api.handle(new Request('https://local.test'),runId);
  assert.equal(deniedResponse.status,401);assert.equal(denied.reads,0);assert.deepEqual(await deniedResponse.json(),{error:'COVER_LETTER_ARTIFACT_UNAUTHORIZED'});
  const malformed=fixture();assert.equal((await malformed.api.handle(new Request('https://local.test'),'../'+runId)).status,404);assert.equal(malformed.reads,0);
});

test('returns exact verified bytes as private no-store attachment with bound metadata', async()=>{
  const f=fixture();const response=await f.api.handle(new Request('https://local.test'),runId);
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
  assert.equal(response.headers.get('Content-Type'),'application/pdf');assert.equal(response.headers.get('Content-Disposition'),`attachment; filename="cover-letter-${runId}.pdf"`);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(response.headers.get('X-Cover-Letter-Application-Number'),'7');assert.equal(response.headers.get('X-Cover-Letter-Report-Number'),'9');
  assert.equal(response.headers.get('X-Cover-Letter-Report-SHA256'),'b'.repeat(64));assert.equal(response.headers.get('X-Cover-Letter-PDF-SHA256'),hash(pdf));assert.equal(f.reads,1);
});

test('rejects corrupt bytes, mismatched run, unsafe report path, and missing artifacts', async()=>{
  for(const value of [
    artifact({pdf:Buffer.from('not pdf')}),
    artifact({receipt:{runId:'22222222-2222-4222-8222-222222222222'}}),
    artifact({receipt:{reportPath:'../../secret.pdf'}}),
  ]) {
    const response=await fixture({value}).api.handle(new Request('https://local.test'),runId);
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'COVER_LETTER_ARTIFACT_INVALID'});
  }
  const missing=fixture({value:null});assert.equal((await missing.api.handle(new Request('https://local.test'),runId)).status,404);
});

test('store failures return a fixed safe response without exposing database details', async()=>{
  const f=fixture({throwRead:true});const response=await f.api.handle(new Request('https://local.test'),runId);
  assert.equal(response.status,503);const body=await response.text();assert.equal(body,JSON.stringify({error:'COVER_LETTER_ARTIFACT_UNAVAILABLE'}));
  assert.equal(body.includes('secret db error'),false);
});
