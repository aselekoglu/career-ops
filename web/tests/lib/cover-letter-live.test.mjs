import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCoverLetterLiveHandler } from '../../src/lib/cover-letter-live.mjs';
import { createCoverLetterTargetResolver } from '../../src/lib/cover-letter-target.mjs';
import { authorizePortfolio } from '../../src/lib/portfolio-cloud.mjs';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const archivedJd = 'The senior systems engineer builds reliable services, works with product teams, identifies failure modes, improves operational quality, and maintains secure systems across production environments. '.repeat(2);
const reportContent = `# Evaluation: Example Co — Systems Engineer\n\n## A) Summary\nRole summary.\n\n## Job Description (archived verbatim)\n\n${archivedJd}\n`;
const records = {
  'cv.md': 'Candidate built a reliable Python service for internal systems.',
  'article-digest.md': 'Candidate improved system reliability.',
  'config/cv-facts.json': JSON.stringify({ allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [] }),
  'config/profile.yml': 'narrative:\n  headline: Systems engineer\n',
  'reports/045-example-2026-10-31.md': reportContent,
};
function fixture({ enabled = '1', draft = 'Candidate built a reliable Python service.', omitConfig = false, authorize, aiReady = true } = {}) {
  const calls = { pools: 0, poolEnds: 0, ai: 0, auth: 0, migrations: 0 };
  const env = { CAREER_OPS_COVER_LETTER_ENABLED: enabled, CAREER_OPS_WEB_AUTH_USER: 'owner', CAREER_OPS_WEB_AUTH_PASSWORD: 'secret', DATABASE_URL: 'postgresql://fixture', GEMINI_API_KEY: 'fixture' };
  const readDocument = async (path) => {
    if (omitConfig && path === 'config/cv-facts.json') return null;
    const content = records[path];
    if (typeof content !== 'string') return null;
    return { path, content, content_encoding: 'utf8', byte_size: Buffer.byteLength(content), sha256: sha(content) };
  };
  const createRuntime = (options) => {
    assert.equal(Object.hasOwn(options, 'renderDispatcher'), false);
    return {
      api: async (request) => {
        options.authorizeOwner(request);
        const body = await request.clone().json();
        if (body.action === 'status') return Response.json({ run: { status: 'awaiting_review' } });
        const resolver = createCoverLetterTargetResolver(options);
        const target = await resolver({ applicationNumber: '12', reportNumber: '45' });
        if (!target) return Response.json({ error: 'COVER_LETTER_BINDING_NOT_FOUND' }, { status: 404 });
        // The run service resolves again before start; both request-local source snapshots are isolated.
        await options.readCanonicalCv();
        let generated = '';
        try {
          for await (const event of options.hostedAi.stream({ task: 'cv', system: 'source-bound draft', messages: [{ role: 'user', content: 'Draft' }], webSearch: false })) generated += event.text;
        } catch { return Response.json({ error: 'GENERATION_STATUS_UNKNOWN' }, { status: 503 }); }
        return Response.json({ draft: generated, binding: { reportPath: target.reportPath, reportSha256: target.reportSha256 } }, { status: 201 });
      },
    };
  };
  const handler = createCoverLetterLiveHandler({
    env,
    authorize: authorize ?? ((request) => { calls.auth++; authorizePortfolio(request, env); return true; }),
    createPool: async (url) => { assert.equal(url, env.DATABASE_URL); calls.pools++; return { query: async () => { throw new Error('unexpected SQL in fixture'); }, connect: async () => { throw new Error('unexpected SQL in fixture'); }, async end() { calls.poolEnds++; } }; },
    createAi: () => ({ status: () => ({ ready: aiReady }), async *stream() { calls.ai++; yield { type: 'text', text: draft }; } }),
    readApplications: async () => [{ n: '12', company: 'Example Co', role: 'Systems Engineer', report: '[45](../reports/045-example-2026-10-31.md)' }],
    readDocument,
    createRuntime,
  });
  const request = (body = {}) => new Request('https://career-ops.test/api/cover-letter', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('owner:secret').toString('base64'), origin: 'https://career-ops.test' }, body: JSON.stringify(body) });
  return { handler, request, calls };
}

test('live handler rechecks Basic owner auth, uses verified canonical sources and closes request pool', async () => {
  const f = fixture();
  const response = await f.handler(f.request());
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { draft: 'Candidate built a reliable Python service.', binding: { reportPath: 'reports/045-example-2026-10-31.md', reportSha256: sha(reportContent) } });
  assert.equal(f.calls.pools, 1); assert.equal(f.calls.poolEnds, 1); assert.equal(f.calls.ai, 1); assert.equal(f.calls.auth, 2);
});

test('live handler blocks unsupported generated claims before returning or saving draft', async () => {
  const f = fixture({ draft: 'I managed 900 staff.' });
  const response = await f.handler(f.request());
  assert.equal(response.status, 422, JSON.stringify(await response.clone().json()));
  assert.deepEqual(await response.json(), { error: 'COVER_LETTER_FACT_CHECK_FAILED' });
  assert.equal(f.calls.ai, 1); assert.equal(f.calls.poolEnds, 1);
});

test('missing canonical cv-facts config is reported and prevents model invocation', async () => {
  const f = fixture({ omitConfig: true });
  const response = await f.handler(f.request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'COVER_LETTER_FACT_CONFIG_MISSING' });
  assert.equal(f.calls.ai, 0); assert.equal(f.calls.poolEnds, 1);
});

test('feature gate and actual owner Basic auth fail before pool creation', async () => {
  const disabled = fixture({ enabled: '0' });
  const disabledResponse = await disabled.handler(disabled.request());
  assert.equal(disabledResponse.status, 404); assert.equal(disabled.calls.pools, 0);
  const unauthorized = fixture();
  const badRequest = new Request('https://career-ops.test/api/cover-letter', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('attacker:bad').toString('base64'), origin: 'https://career-ops.test' }, body: '{}' });
  assert.equal((await unauthorized.handler(badRequest)).status, 401); assert.equal(unauthorized.calls.pools, 0);
  const indeterminate = fixture({ authorize: async () => undefined });
  assert.equal((await indeterminate.handler(indeterminate.request())).status, 401); assert.equal(indeterminate.calls.pools, 0);
});

test('status remains available when hosted AI is down', async () => {
  const f = fixture({ aiReady: false });
  const response = await f.handler(f.request({ action: 'status' }));
  assert.equal(response.status, 200); assert.equal((await response.json()).run.status, 'awaiting_review');
  assert.equal(f.calls.ai, 0); assert.equal(f.calls.poolEnds, 1);
});

 test('canonical target mismatches reject before database or model work', async () => {
  const f = fixture();
  const mismatch = new Request('https://career-ops.test/api/cover-letter', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('owner:secret').toString('base64'), origin: 'https://career-ops.test' }, body: '{}' });
  const handler = createCoverLetterLiveHandler({
    env: { ...process.env, CAREER_OPS_COVER_LETTER_ENABLED: '1', CAREER_OPS_WEB_AUTH_USER: 'owner', CAREER_OPS_WEB_AUTH_PASSWORD: 'secret', DATABASE_URL: 'fixture', GEMINI_API_KEY: 'fixture' },
    createPool: f.handler && (async () => { f.calls.pools++; return { query:async()=>{}, connect:async()=>{}, end:async()=>{f.calls.poolEnds++;} }; }),
    createAi: () => ({ status: () => ({ ready: true }), async *stream() { f.calls.ai++; yield { type:'text', text:'Unused' }; } }),
    readApplications: async () => [{ n:'12', company:'Other Co', role:'Systems Engineer', report:'[46](../reports/045-example-2026-10-31.md)' }],
    readDocument: async (path) => { const content=records[path]; return content ? { path, content, content_encoding:'utf8', byte_size:Buffer.byteLength(content), sha256:sha(content) } : null; },
    createRuntime: (options) => ({ api:async()=>{ const resolver=createCoverLetterTargetResolver(options); const target=await resolver({applicationNumber:'12',reportNumber:'45'}); return target ? Response.json({target}) : Response.json({error:'COVER_LETTER_BINDING_NOT_FOUND'},{status:404}); } }),
  });
  assert.equal((await handler(mismatch)).status, 404); assert.equal(f.calls.ai, 0);
});
