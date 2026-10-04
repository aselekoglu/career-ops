import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/server.mjs';

const env = { CAREER_OPS_API_ORIGIN: 'https://career-ops-aselekoglu.vercel.app', CAREER_OPS_WEB_AUTH_USER: 'test-user', CAREER_OPS_WEB_AUTH_PASSWORD: 'test-password' };
const rpc = (method, params = {}, authenticated = true) => new Request('https://bridge.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'oai-authenticated-user-id': 'test-owner' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
const testArtifact = (overrides = {}) => ({
  runId: '99999999-9999-4999-8999-999999999999', status: 'completed', association_status: 'linked', association_pending: false, association_error_code: null,
  applicationNumber: '39', targetApplicationNumber: '39', reportPath: 'reports/039-example-2026-10-03.md', company: 'Example', role: 'Analyst',
  artifactPath: 'output/cv-example.pdf', contentType: 'application/pdf', byteSize: 600, sha256: 'a'.repeat(64), format: 'letter',
  requestedAt: '2026-10-03T12:00:00.000Z', completedAt: '2026-10-03T12:01:00.000Z', downloadUrl: 'https://career-ops-aselekoglu.vercel.app/api/cv-pdf?artifact=private', privateToken: 'must-not-escape',
  ...overrides,
});

test('discovery is public, read-only and includes the native panel extension', async () => {
  const response = await worker.fetch(rpc('tools/list', {}, false), env);
  const body = await response.json();
  assert.ok(body.result.tools.length >= 4);
  const mutating = new Set([
    'career_ops_cv_generate_start', 'career_ops_evaluation_start', 'career_ops_job_import', 'career_ops_cv_artifact_associate',
    'career_ops_tracker_add', 'career_ops_tracker_set_status', 'career_ops_tracker_update_notes', 'career_ops_tracker_archive', 'career_ops_tracker_delete',
    'career_ops_inbox_add', 'career_ops_inbox_edit', 'career_ops_inbox_archive', 'career_ops_inbox_delete',
  ]);
  assert.ok(body.result.tools.every(t => mutating.has(t.name) ? t.annotations.readOnlyHint === false : t.annotations.readOnlyHint === true));
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_job_import').annotations.idempotentHint, true);
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_cv_generate_start').annotations.idempotentHint, false);
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_cv_generate_status').annotations.readOnlyHint, true);
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_tracker_delete').annotations.destructiveHint, true);
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_inbox_delete').annotations.destructiveHint, true);
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_cv_artifact_export').annotations.readOnlyHint, true);
  assert.ok(body.result.tools.find(t => t.name === 'open_career_ops')._meta['openai/ui'].entrypoints.some(e => e.type === 'thread'));
  assert.ok(!JSON.stringify(body).includes('test-password'));
});

test('private data needs a Sites user before any upstream request', async () => {
  const response = await worker.fetch(rpc('tools/call', { name: 'career_ops_pipeline', arguments: {} }, false), env);
  assert.equal(response.status, 401);
});

test('calls only the fixed upstream and filters/paginates real applications', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/pipeline');
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('test-user:test-password'));
    assert.equal(options.redirect, 'manual');
    return Response.json({ applications: [{ n: '1', company: 'Example', role: 'Analyst', status: 'Applied' }, { n: '2', company: 'Other', role: 'Engineer', status: 'Interview' }], inbox: [], root: 'private-path' });
  });
  const response = await worker.fetch(rpc('tools/call', { name: 'career_ops_pipeline', arguments: { company: 'exam', limit: 1 } }), env);
  const body = await response.json();
  assert.equal(body.result.structuredContent.applications.length, 1);
  assert.equal(body.result.structuredContent.applications[0].company, 'Example');
  assert.ok(!JSON.stringify(body).includes('private-path'));
});

test('refuses arbitrary origins and missing credentials without network access', async () => {
  for (const config of [{ ...env, CAREER_OPS_API_ORIGIN: 'https://attacker.example' }, { ...env, CAREER_OPS_WEB_AUTH_PASSWORD: '' }]) {
    const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_health', arguments: {} }), config)).json();
    assert.equal(body.result.isError, true);
  }
});

test('rejects unknown args and write operations', async () => {
  for (const params of [{ name: 'career_ops_pipeline', arguments: { url: 'https://attacker.example' } }, { name: 'delete_application', arguments: {} }, { name: 'career_ops_pipeline', arguments: { limit: -1 } }]) {
    const body = await (await worker.fetch(rpc('tools/call', params), env)).json();
    assert.equal(body.error.code, -32602);
  }
});

test('does not relay upstream error bodies or auth secrets', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('test-password private error details', { status: 401 }));
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_health', arguments: {} }), env)).json();
  assert.equal(body.result.isError, true);
  assert.ok(!JSON.stringify(body).includes('test-password'));
});

test('health and initialization accurately describe the bridge write capabilities', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok' }));
  const health = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_health', arguments: {} }), env)).json();
  assert.equal(health.result.structuredContent.readOnlyBridge, false);
  const initialized = await (await worker.fetch(rpc('initialize', { protocolVersion: '2025-06-18' }), env)).json();
  const instructions = initialized.result.instructions;
  assert.match(instructions, /Tracker and Inbox writes are available only for exact rows\/URLs/);
  assert.match(instructions, /Archive\/delete require explicit user confirmation/);
  assert.match(instructions, /Source CV\/profile writes/);
  assert.doesNotMatch(instructions, /Application submission and edits stay disabled/);
});

test('job import advertises an explicit schema and rejects malformed/private URLs before upstream access', async t => {
  const listed = await (await worker.fetch(rpc('tools/list', {}, false), env)).json();
  const definition = listed.result.tools.find(tool => tool.name === 'career_ops_job_import');
  assert.ok(definition);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(definition.inputSchema.required, ['url']);
  assert.equal(definition.inputSchema.properties.url.maxLength, 2048);
  assert.equal(definition.inputSchema.properties.source.maxLength, 500);
  assert.equal(definition.inputSchema.properties.forceRefresh.type, 'boolean');
  assert.match(definition.description, /before evaluation or CV generation/i);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  for (const args of [
    {}, { url: 'https://jobs.example/role', extra: true }, { url: 'https://jobs.example/role', forceRefresh: 'yes' },
    { url: 'https://jobs.example/role', source: 'x'.repeat(501) },
  ]) {
    const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_job_import', arguments: args }), env)).json();
    assert.equal(body.error.code, -32602, JSON.stringify(args));
  }
  for (const [url, code] of [
    ['not-a-url', 'INVALID_URL'], ['file:///etc/passwd', 'UNSUPPORTED_SCHEME'], ['https://user:pass@jobs.example/role', 'INVALID_URL'],
    ['http://127.0.0.1/role', 'PRIVATE_NETWORK_BLOCKED'], ['http://192.168.1.2/role', 'PRIVATE_NETWORK_BLOCKED'],
    ['https://jobs.example/role\n', 'INVALID_URL'],
  ]) {
    const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_job_import', arguments: { url } }), env)).json();
    assert.equal(body.result.structuredContent.status, 'failed', url);
    assert.equal(body.result.structuredContent.error.code, code, url);
  }
  assert.equal(calls, 0);
});

test('job import requires a Sites user before any upstream mutation', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ status: 'imported' }); });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_job_import', arguments: { url: 'https://jobs.lever.co/example/123' } }, false), env)).json();
  assert.equal(body.error.code, -32001);
  assert.equal(calls, 0);
});

test('job import uses only fixed Basic-authenticated endpoint and allowlists imported and duplicate results', async t => {
  const expectedUrl = 'https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329/apply?source=LinkedIn';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/job-import');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('test-user:test-password'));
    assert.deepEqual(JSON.parse(options.body), calls === 1
      ? { url: expectedUrl, source: 'LinkedIn', forceRefresh: true }
      : { url: expectedUrl.replace('LinkedIn', 'Indeed'), source: 'Indeed', forceRefresh: false });
    return Response.json(calls === 1
      ? { status: 'imported', inboxId: 'inbox-123', applicationNumber: null, company: 'Magnet Forensics', role: 'Security Analyst', location: 'Waterloo, ON', normalizedUrl: 'https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329', originalUrl: expectedUrl, source: 'wrong backend source', createdAt: '2026-10-03T10:00:00.000Z', existing: false, jobDescription: 'must not escape', downloadUrl: 'https://private.example/token', internalToken: 'secret' }
      : { status: 'already_exists', inboxId: 'inbox-123', company: 'Magnet Forensics', role: 'Security Analyst', normalizedUrl: 'https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329', existing: true });
  });
  const request = { name: 'career_ops_job_import', arguments: { url: expectedUrl, source: 'LinkedIn', forceRefresh: true } };
  const imported = await (await worker.fetch(rpc('tools/call', request), env)).json();
  assert.equal(imported.result.structuredContent.status, 'imported');
  assert.equal(imported.result.structuredContent.inboxId, 'inbox-123');
  assert.equal(imported.result.structuredContent.applicationNumber, null);
  assert.equal(imported.result.structuredContent.role, 'Security Analyst');
  assert.equal(imported.result.structuredContent.source, 'LinkedIn');
  assert.equal(imported.result.structuredContent.originalUrl, expectedUrl);
  assert.ok(!JSON.stringify(imported).includes('must not escape'));
  assert.ok(!JSON.stringify(imported).includes('private.example'));
  assert.ok(!JSON.stringify(imported).includes('internalToken'));
  const duplicateRequest = { name: 'career_ops_job_import', arguments: { url: expectedUrl.replace('LinkedIn', 'Indeed'), source: 'Indeed', forceRefresh: false } };
  const duplicate = await (await worker.fetch(rpc('tools/call', duplicateRequest), env)).json();
  assert.equal(duplicate.result.structuredContent.status, 'already_exists');
  assert.equal(duplicate.result.structuredContent.existing, true);
  assert.equal(duplicate.result.structuredContent.inboxId, 'inbox-123');
  assert.equal(calls, 2);
});

test('job import preserves known backend errors and excludes unrelated failure fields', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/job-import');
    return Response.json({ error: { code: 'POSTING_NOT_FOUND', message: 'Request failed at postgresql://importer:raw-secret@db.internal/private.' }, secret: 'test-password', stack: 'private stack' }, { status: 404 });
  });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_job_import', arguments: { url: 'https://jobs.example/expired' } }), env)).json();
  assert.equal(body.result.isError, true);
  assert.deepEqual(body.result.structuredContent, {
    status: 'failed', originalUrl: 'https://jobs.example/expired', error: { code: 'POSTING_NOT_FOUND', message: 'The job posting was not found or is no longer available.' },
  });
  assert.ok(!JSON.stringify(body).includes('test-password'));
  assert.ok(!JSON.stringify(body).includes('private stack'));
  assert.ok(!JSON.stringify(body).includes('raw-secret'));
  assert.ok(!JSON.stringify(body).includes('db.internal'));
});

test('tracker, Inbox and artifact schemas enforce IDs, user-only fields and explicit destructive confirmation', async t => {
  const listed = await (await worker.fetch(rpc('tools/list', {}, false), env)).json();
  const toolByName = name => listed.result.tools.find(tool => tool.name === name);
  assert.deepEqual(toolByName('career_ops_tracker_set_status').inputSchema.properties.status.enum, ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP', 'Hired']);
  assert.equal(toolByName('career_ops_cv_artifacts').inputSchema.required, undefined);
  assert.equal(toolByName('career_ops_cv_artifacts').inputSchema.properties.limit.maximum, 100);
  assert.equal(toolByName('career_ops_cv_artifacts').inputSchema.properties.offset.maximum, 100000);
  assert.equal(toolByName('career_ops_cv_artifact_associate').inputSchema.additionalProperties, false);
  assert.deepEqual(toolByName('career_ops_tracker_archive').inputSchema.properties.confirm.enum, [true]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  const op = '11111111-1111-4111-8111-111111111111';
  const invalid = [
    { name: 'career_ops_tracker_add', arguments: { operationId: 'made-up', company: 'Example', role: 'Analyst', url: 'https://jobs.example/1', source: 'User', status: 'Applied' } },
    { name: 'career_ops_tracker_add', arguments: { operationId: op, company: 'Example', role: 'Analyst', url: 'https://jobs.example/1', source: 'User', status: 'Applied', score: '6/5' } },
    { name: 'career_ops_tracker_add', arguments: { operationId: op, company: 'Example', role: 'Analyst', url: 'https://user:pass@jobs.example/1', source: 'User', status: 'Applied' } },
    { name: 'career_ops_tracker_set_status', arguments: { operationId: op, applicationId: '39', status: 'Submitted' } },
    { name: 'career_ops_tracker_set_status', arguments: { operationId: op, applicationId: '39', status: 'Interview', date: '2026-02-30' } },
    { name: 'career_ops_tracker_archive', arguments: { operationId: op, applicationId: '39', confirm: false } },
    { name: 'career_ops_tracker_delete', arguments: { operationId: op, applicationId: '39' } },
    { name: 'career_ops_inbox_edit', arguments: { operationId: op, targetUrl: 'https://jobs.example/1' } },
    { name: 'career_ops_inbox_archive', arguments: { operationId: op, targetUrl: 'https://jobs.example/1', confirm: false } },
    { name: 'career_ops_inbox_delete', arguments: { operationId: op, targetUrl: 'https://jobs.example/1', confirm: true, extra: 'no' } },
    { name: 'career_ops_cv_artifact', arguments: { runId: '../artifact' } },
    { name: 'career_ops_cv_artifact_associate', arguments: { runId: '99999999-9999-4999-8999-999999999999', applicationNumber: '39', idempotencyKey: 'bad key' } },
  ];
  for (const args of invalid) {
    const body = await (await worker.fetch(rpc('tools/call', args), env)).json();
    assert.equal(body.error.code, -32602, args.name);
  }
  assert.equal(calls, 0);
});

test('tracker and CV artifact mutations require a Sites user before any Basic-authenticated fetch', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ ok: true }); });
  const unauthenticated = false;
  const tracker = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_tracker_delete', arguments: {
    operationId: '11111111-1111-4111-8111-111111111111', applicationId: '39', confirm: true,
  } }, unauthenticated), env)).json();
  const artifact = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_artifact_associate', arguments: {
    runId: '99999999-9999-4999-8999-999999999999', applicationNumber: '39', idempotencyKey: 'associate:synthetic:39',
  } }, unauthenticated), env)).json();
  assert.equal(tracker.error.code, -32001);
  assert.equal(artifact.error.code, -32001);
  assert.equal(calls, 0);
});

test('tracker and Inbox operations use fixed Basic-authenticated routes and allowlisted payload/results', async t => {
  const configured = { ...env, CAREER_OPS_MCP_READ_TOKEN: 'read-token' };
  const op = i => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
  const company = { n: '39', date: null, company: 'Synthetic Test Co', via: 'User', role: 'Test Analyst', location: null, score: null, status: 'Applied', pdf: null, report: null, notes: null, privateField: 'hidden' };
  const operations = [
    ['career_ops_tracker_get', { applicationId: '39' }, 'GET', '/api/tracker/39', null],
    ['career_ops_tracker_add', { operationId: op(1), company: 'Synthetic Test Co', role: 'Test Analyst', url: 'https://jobs.example/test-canary', source: 'User', date: '2026-10-03', status: 'Applied', score: '3.5/5' }, 'POST', '/api/tracker/commands', { operationId: op(1), company: 'Synthetic Test Co', role: 'Test Analyst', url: 'https://jobs.example/test-canary', source: 'User', date: '2026-10-03', status: 'Applied', score: '3.5/5', operation: 'add' }],
    ['career_ops_tracker_set_status', { operationId: op(2), applicationId: '39', status: 'Interview', date: '2026-10-03' }, 'POST', '/api/tracker/commands', { operationId: op(2), applicationId: '39', status: 'Interview', date: '2026-10-03', operation: 'set-status' }],
    ['career_ops_tracker_update_notes', { operationId: op(3), applicationId: '39', notes: 'User-authored canary note' }, 'POST', '/api/tracker/commands', { operationId: op(3), applicationId: '39', notes: 'User-authored canary note', operation: 'update-notes' }],
    ['career_ops_tracker_archive', { operationId: op(4), applicationId: '39', confirm: true }, 'POST', '/api/tracker/commands', { operationId: op(4), applicationId: '39', confirm: true, operation: 'archive' }],
    ['career_ops_tracker_delete', { operationId: op(5), applicationId: '39', confirm: true }, 'POST', '/api/tracker/commands', { operationId: op(5), applicationId: '39', confirm: true, operation: 'delete' }],
    ['career_ops_inbox_add', { operationId: op(6), url: 'https://jobs.example/test-canary', company: 'Synthetic Test Co', role: 'Test Analyst', location: 'Ottawa', compensation: 'User-stated range' }, 'POST', '/api/inbox/commands', { operationId: op(6), url: 'https://jobs.example/test-canary', company: 'Synthetic Test Co', role: 'Test Analyst', location: 'Ottawa', compensation: 'User-stated range', operation: 'add' }],
    ['career_ops_inbox_edit', { operationId: op(7), targetUrl: 'https://jobs.example/test-canary', location: 'Toronto' }, 'POST', '/api/inbox/commands', { operationId: op(7), targetUrl: 'https://jobs.example/test-canary', location: 'Toronto', operation: 'edit' }],
    ['career_ops_inbox_archive', { operationId: op(8), targetUrl: 'https://jobs.example/test-canary', confirm: true }, 'POST', '/api/inbox/commands', { operationId: op(8), targetUrl: 'https://jobs.example/test-canary', confirm: true, operation: 'archive' }],
    ['career_ops_inbox_delete', { operationId: op(9), targetUrl: 'https://jobs.example/test-canary', confirm: true }, 'POST', '/api/inbox/commands', { operationId: op(9), targetUrl: 'https://jobs.example/test-canary', confirm: true, operation: 'delete' }],
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const [name, , method, path, payload] = operations[calls++];
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + path);
    assert.equal(options.method, method);
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('test-user:test-password'));
    if (payload) assert.deepEqual(JSON.parse(options.body), payload);
    else assert.equal(options.body, undefined);
    if (name === 'career_ops_tracker_get') return Response.json({ application: company, stack: 'hidden' });
    if (path === '/api/tracker/commands') return Response.json({ ok: true, operation: payload.operation, application: company, secret: 'hidden' });
    return Response.json({ ok: true, url: 'https://jobs.example/test-canary', privateField: 'hidden' });
  });
  for (const [name, args] of operations.map(([name, args]) => [name, args])) {
    const body = await (await worker.fetch(rpc('tools/call', { name, arguments: args }), configured)).json();
    assert.ok(body.result, JSON.stringify(body));
    assert.ok(body.result.structuredContent, JSON.stringify(body));
    if (name === 'career_ops_tracker_get') assert.equal(body.result.structuredContent.application.company, 'Synthetic Test Co');
    else assert.equal(body.result.structuredContent.ok, true, name);
    assert.ok(!JSON.stringify(body).includes('privateField'));
    assert.ok(!JSON.stringify(body).includes('hidden'));
  }
  assert.equal(calls, operations.length);
});

test('tracker and Inbox failures preserve only canonical backend codes and exclude response details', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'INVALID_STATUS', message: 'postgres://user:secret@db.internal/path', stack: 'raw stack', internalToken: 'secret' }, { status: 400 }));
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_tracker_set_status', arguments: { operationId: '11111111-1111-4111-8111-111111111111', applicationId: '39', status: 'Interview' } }), env)).json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text.startsWith('INVALID_STATUS:'), true);
  assert.ok(!JSON.stringify(body).includes('db.internal'));
  assert.ok(!JSON.stringify(body).includes('raw stack'));
  assert.ok(!JSON.stringify(body).includes('secret'));
});

test('tracker operation IDs remain stable across retries and backend replay is allowlisted', async t => {
  const args = { operationId: '22222222-2222-4222-8222-222222222222', company: 'Synthetic Test Co', role: 'Test Analyst', url: 'https://jobs.example/test-canary', source: 'User', status: 'Applied' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/tracker/commands');
    const payload = JSON.parse(options.body);
    assert.equal(payload.operationId, args.operationId);
    assert.equal(payload.operation, 'add');
    return Response.json({ ok: true, operation: 'add', replayed: calls === 2, application: { n: '40', company: args.company, role: args.role, privateField: 'hidden' } });
  });
  const first = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_tracker_add', arguments: args }), env)).json();
  const retry = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_tracker_add', arguments: args }), env)).json();
  assert.equal(first.result.structuredContent.replayed, undefined);
  assert.equal(retry.result.structuredContent.replayed, true);
  assert.ok(!JSON.stringify(retry).includes('privateField'));
  assert.equal(calls, 2);
});

test('artifact list/read/associate use fixed Basic-authenticated routes and normalize association aliases', async t => {
  const runId = '99999999-9999-4999-8999-999999999999';
  const configured = { ...env, CAREER_OPS_MCP_READ_TOKEN: 'read-token' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('test-user:test-password'));
    if (calls === 1) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-artifacts?applicationNumber=39');
      assert.equal(options.method, 'GET');
      const item = testArtifact({ association_status: 'pending', association_pending: true, association_error_code: 'CV_ARTIFACT_TRACKER_INVALID' });
      return Response.json({ applicationNumber: '39', latest: item, artifacts: [item], pagination: { limit: 25, offset: 0, nextOffset: null }, downloadUrl: 'private', internalToken: 'secret' });
    }
    if (calls === 2) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-artifacts/' + runId);
      return Response.json(testArtifact({ runId }));
    }
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-artifacts/' + runId + '/associate');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { applicationNumber: '39', idempotencyKey: 'associate:synthetic:39' });
    return Response.json(testArtifact({ runId, associationStatus: 'linked', associationPending: false, associationErrorCode: null }));
  });
  const listed = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_artifacts', arguments: { applicationNumber: '39' } }), configured)).json();
  assert.ok(listed.result, JSON.stringify(listed));
  assert.ok(listed.result.structuredContent, JSON.stringify(listed));
  assert.equal(listed.result.structuredContent.latest.associationStatus, 'pending');
  assert.equal(listed.result.structuredContent.latest.associationPending, true);
  assert.equal(listed.result.structuredContent.latest.associationErrorCode, 'CV_ARTIFACT_TRACKER_INVALID');
  assert.ok(!JSON.stringify(listed).includes('downloadUrl'));
  assert.ok(!JSON.stringify(listed).includes('internalToken'));
  const read = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_artifact', arguments: { runId } }), configured)).json();
  assert.ok(read.result, JSON.stringify(read));
  assert.equal(read.result.structuredContent.runId, runId);
  assert.ok(!JSON.stringify(read).includes('privateToken'));
  const linked = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_artifact_associate', arguments: { runId, applicationNumber: '39', idempotencyKey: 'associate:synthetic:39' } }), configured)).json();
  assert.ok(linked.result, JSON.stringify(linked));
  assert.equal(linked.result.structuredContent.associationStatus, 'linked');
  assert.equal(linked.result.structuredContent.applicationNumber, '39');
  assert.equal(calls, 3);
});

test('artifact list may omit applicationNumber and calls only the fixed collection route', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-artifacts?limit=10&offset=20');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('test-user:test-password'));
    return Response.json({ applicationNumber: null, latest: null, artifacts: [], pagination: { limit: 10, offset: 20, nextOffset: null }, downloadUrl: 'private', internalToken: 'secret' });
  });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_artifacts', arguments: { limit: 10, offset: 20 } }), env)).json();
  assert.deepEqual(body.result.structuredContent, { applicationNumber: null, latest: null, artifacts: [], pagination: { limit: 10, offset: 20, nextOffset: null } });
  assert.ok(!JSON.stringify(body).includes('private'));
  assert.ok(!JSON.stringify(body).includes('internalToken'));
});

test('CV artifact failures preserve safe backend codes without forwarding messages or stack data', async t => {
  const runId = '99999999-9999-4999-8999-999999999999';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'CV_ARTIFACT_TRACKER_INVALID', message: 'private posting detail', stack: 'secret stack', token: 'secret' }, { status: 409 }));
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_artifact_associate', arguments: { runId, applicationNumber: '39', idempotencyKey: 'associate:synthetic:39' } }), env)).json();
  assert.equal(body.result.isError, true);
  assert.ok(body.result.content[0].text.startsWith('CV_ARTIFACT_TRACKER_INVALID:'));
  assert.ok(!JSON.stringify(body).includes('private posting detail'));
  assert.ok(!JSON.stringify(body).includes('secret stack'));
  assert.ok(!JSON.stringify(body).includes('token'));
});

test('artifact export returns a private Site resource link and its download route checks owner auth before fixed PDF fetch', async t => {
  const runId = '99999999-9999-4999-8999-999999999999';
  const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(600));
  const siteOrigin = 'https://career-ops-chatgpt.aselekoglu.chatgpt.site';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('test-user:test-password'));
    if (calls === 1) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-artifacts/' + runId);
      return Response.json(testArtifact({ runId, byteSize: pdf.length }));
    }
    if (calls === 2) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-artifacts/' + runId + '/download');
      assert.equal(options.headers.Accept, 'application/pdf');
    } else {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-artifacts/' + runId + '/download');
      assert.equal(options.headers.Accept, 'application/pdf');
      assert.equal(options.headers['oai-authenticated-user-id'], undefined);
    }
    return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) } });
  });
  const exported = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_artifact_export', arguments: { runId } }), env)).json();
  assert.ok(exported.result, JSON.stringify(exported));
  assert.ok(exported.result.structuredContent, JSON.stringify(exported));
  const privateUrl = siteOrigin + '/artifacts/' + runId + '/download';
  assert.equal(exported.result.structuredContent.privateDownloadUrl, privateUrl);
  assert.equal(exported.result.structuredContent.downloadVerified, true);
  assert.equal(exported.result.structuredContent.downloadBytes, pdf.length);
  assert.ok(exported.result.content.some(item => item.type === 'resource_link' && item.uri === privateUrl && item.mimeType === 'application/pdf'));
  assert.ok(!JSON.stringify(exported).includes('career-ops-aselekoglu.vercel.app'));
  assert.ok(!JSON.stringify(exported).includes('privateToken'));
  assert.equal(calls, 2);

  const unauthorized = await worker.fetch(new Request(privateUrl));
  assert.equal(unauthorized.status, 401);
  assert.equal(calls, 2);
  const wrongOrigin = await worker.fetch(new Request('https://attacker.example/artifacts/' + runId + '/download', { headers: { 'oai-authenticated-user-id': 'test-owner' } }));
  assert.equal(wrongOrigin.status, 403);
  assert.equal(calls, 2);
  const response = await worker.fetch(new Request(privateUrl, { headers: { 'oai-authenticated-user-id': 'test-owner' } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="career-ops-cv-' + runId + '.pdf"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  assert.equal(calls, 3);
});

test('rejects redirects without forwarding credentials to another destination', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 307, headers: { Location: 'https://attacker.example' } });
  });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_health', arguments: {} }), env)).json();
  assert.equal(body.result.isError, true);
  assert.ok(body.result.content[0].text.includes('UPSTREAM_REDIRECT_DENIED'));
});

test('supports protocol negotiation, UI resources and notification acknowledgement', async () => {
  const init = await (await worker.fetch(rpc('initialize', { protocolVersion: '2025-06-18' }), env)).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await (await worker.fetch(rpc('resources/list'), env)).json();
  const resource = await (await worker.fetch(rpc('resources/read', { uri: list.result.resources[0].uri }), env)).json();
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.result.contents[0].text.includes('ui/initialize'));
  const response = await worker.fetch(new Request('https://bridge.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }), env);
  assert.equal(response.status, 202);
});

test('live scan tools are gated, start is a write, and status/results remain read-only', async () => {
  const configured = { ...env, CAREER_OPS_LIVE_SCANS_ENABLED: '1' };
  const body = await (await worker.fetch(rpc('tools/list'), configured)).json();
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_scan_start').annotations.readOnlyHint, false);
  assert.equal(body.result.tools.find(t => t.name === 'career_ops_scan_status').annotations.readOnlyHint, true);
  assert.equal((await (await worker.fetch(rpc('tools/call', { name: 'career_ops_scan_start', arguments: {} }), env)).json()).error.code, -32602);
});
test('scan schema rejects unsupported modes, arbitrary sources and malformed scan identifiers', async () => {
  const configured = { ...env, CAREER_OPS_LIVE_SCANS_ENABLED: '1' };
  for (const params of [
    { name:'career_ops_scan_start',arguments:{mode:'full'} }, { name:'career_ops_scan_start',arguments:{sinceDays:0} },
    { name:'career_ops_scan_start',arguments:{companies:['https://attacker.example']} },
    { name:'career_ops_scan_status',arguments:{} }, { name:'career_ops_scan_results',arguments:{scanId:'../cv'} },
  ]) assert.equal((await (await worker.fetch(rpc('tools/call',params),configured)).json()).error.code,-32602);
});
test('start sends only a validated POST to the existing Vercel API and reports queue state', async t => {
  t.mock.method(globalThis,'fetch',async (url,opts)=>{
    assert.equal(url, env.CAREER_OPS_API_ORIGIN+'/api/scans'); assert.equal(opts.method,'POST'); assert.deepEqual(JSON.parse(opts.body),{mode:'portals',sinceDays:5});
    return Response.json({status:'queued',scanId:'11111111-1111-4111-8111-111111111111'},{status:202});
  });
  const body=await (await worker.fetch(rpc('tools/call',{name:'career_ops_scan_start',arguments:{mode:'portals',sinceDays:5}}),{...env,CAREER_OPS_LIVE_SCANS_ENABLED:'1'})).json();
  assert.equal(body.result.structuredContent.status,'queued');
});

test('CV tools are always discoverable and proxy exact fixed API requests with bounded generation timeout', async t => {
  const listed = await (await worker.fetch(rpc('tools/list', {}, false), env)).json();
  assert.ok(listed.result.tools.some(tool => tool.name === 'career_ops_cv_generate_start'));
  assert.ok(listed.result.tools.some(tool => tool.name === 'career_ops_cv_generate_status'));
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-runs');
    assert.equal(opts.method, 'POST'); assert.equal(opts.redirect, 'manual');
    assert.deepEqual(JSON.parse(opts.body), { applicationNumber: '17', pageFormat: 'a4' });
    return Response.json({ runId: '11111111-1111-4111-8111-111111111111', status: 'generating', company: 'Example', format: 'a4', sourceCV: 'must not escape' }, { status: 202 });
  });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_start', arguments: { applicationNumber: '17', pageFormat: 'a4' } }), env)).json();
  assert.equal(body.result.structuredContent.status, 'generating');
  assert.ok(!JSON.stringify(body).includes('sourceCV'));
});

test('CV start validates exclusive selectors, formats and safe HTTP URLs before upstream access', async () => {
  for (const args of [
    {}, { applicationNumber: '17', url: 'https://example.com/job' }, { applicationNumber: '' },
    { applicationNumber: '0' }, { applicationNumber: '-2' }, { applicationNumber: '1.2' },
    { url: 'ftp://example.com/job' }, { url: 'https://user:pass@example.com/job' },
    { url: 'https://example.com/\njob' }, { url: 'https://example.com/job', pageFormat: 'legal' },
    { url: 'https://example.com/job', extra: true },
  ]) {
    const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_start', arguments: args }), env)).json();
    assert.equal(body.error.code, -32602, JSON.stringify(args));
  }
});

test('CV URL is passed to backend without fetching it; status preserves exact artifact metadata and active state', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls++;
    if (calls === 1) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-runs');
      assert.deepEqual(JSON.parse(opts.body), { url: 'https://jobs.example/role', pageFormat: 'letter' });
      return Response.json({ runId: '22222222-2222-4222-8222-222222222222', status: 'queued' }, { status: 202 });
    }
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-runs/22222222-2222-4222-8222-222222222222');
    assert.equal(opts.method, 'GET');
    return Response.json({ runId: '22222222-2222-4222-8222-222222222222', status: 'running', artifactPath: null, downloadUrl: null, company: 'Example', privateSecret: 'do not relay' });
  });
  const started = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_start', arguments: { url: 'https://jobs.example/role' } }), env)).json();
  assert.equal(started.result.structuredContent.status, 'queued');
  const current = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId: '22222222-2222-4222-8222-222222222222' } }), env)).json();
  assert.equal(current.result.structuredContent.status, 'running');
  assert.ok(!JSON.stringify(current).includes('privateSecret'));
  assert.equal(calls, 2);
});

test('CV status rejects malformed UUID and completed status preserves exact download URL', async t => {
  const invalid = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId: '../cv' } }), env)).json();
  assert.equal(invalid.error.code, -32602);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ runId: '33333333-3333-4333-8333-333333333333', status: 'completed', artifactPath: 'output/exact.pdf', downloadUrl: 'https://career-ops-aselekoglu.vercel.app/api/cv-pdf?artifact=exact', startedAt: null, completedAt: '2026-10-02T00:00:00Z', errorCode: null, applicationNumber: '39', report_path: 'reports/039-example-2026-10-02.md', association_status: 'linked', association_pending: false, association_error_code: null, sourceCV: 'private' }));
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId: '33333333-3333-4333-8333-333333333333' } }), env)).json();
  assert.equal(body.result.structuredContent.downloadUrl, 'https://career-ops-aselekoglu.vercel.app/api/cv-pdf?artifact=exact');
  assert.equal(body.result.structuredContent.artifactPath, 'output/exact.pdf');
  assert.equal(body.result.structuredContent.startedAt, null);
  assert.equal(body.result.structuredContent.errorCode, null);
  assert.equal(body.result.structuredContent.associationStatus, 'linked');
  assert.equal(body.result.structuredContent.associationPending, false);
  assert.equal(body.result.structuredContent.applicationNumber, '39');
  assert.equal(body.result.structuredContent.reportPath, 'reports/039-example-2026-10-02.md');
  assert.ok(!JSON.stringify(body).includes('sourceCV'));
});

test('CV status can verify the exact completed download URL with Basic auth and return only PDF metadata', async t => {
  const runId = '99999999-9999-4999-8999-999999999999';
  const pdf = Buffer.from('%PDF-1.7\nprivate-pdf-payload');
  const configured = { ...env, CAREER_OPS_MCP_READ_TOKEN: 'read-token' };
  const listed = await (await worker.fetch(rpc('tools/list', {}, false), env)).json();
  const verifyRule = listed.result.tools.find(tool => tool.name === 'career_ops_cv_generate_status').inputSchema.properties.verifyDownload;
  assert.equal(verifyRule.type, 'boolean');
  assert.equal(verifyRule.default, false);
  for (const verifyDownload of ['true', 1]) {
    const invalid = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId, verifyDownload } }), env)).json();
    assert.equal(invalid.error.code, -32602);
  }
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    if (calls === 1) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-runs/' + runId);
      assert.equal(options.headers.Authorization, 'Bearer read-token');
      return Response.json({ runId, status: 'completed', artifactPath: 'output/exact.pdf', downloadUrl: env.CAREER_OPS_API_ORIGIN + '/api/cv-pdf?artifact=output%2Fexact.pdf', company: 'Example', role: 'Analyst', completedAt: '2026-10-03T12:00:00.000Z' });
    }
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-pdf?artifact=output%2Fexact.pdf');
    assert.equal(options.headers.Authorization, 'Basic ' + btoa('test-user:test-password'));
    assert.equal(options.headers.Accept, 'application/pdf');
    return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) } });
  });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId, verifyDownload: true } }), configured)).json();
  assert.equal(body.result.structuredContent.status, 'completed');
  assert.equal(body.result.structuredContent.artifactPath, 'output/exact.pdf');
  assert.equal(body.result.structuredContent.downloadUrl, env.CAREER_OPS_API_ORIGIN + '/api/cv-pdf?artifact=output%2Fexact.pdf');
  assert.equal(body.result.structuredContent.downloadVerified, true);
  assert.equal(body.result.structuredContent.downloadBytes, pdf.length);
  assert.ok(!JSON.stringify(body).includes('private-pdf-payload'));
  assert.ok(!JSON.stringify(body).includes('test-password'));
  assert.equal(calls, 2);
});

test('CV download verification rejects unsafe URLs, skips active runs and records redirects without relaying PDF', async t => {
  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rows = [
    { status: 'completed', artifactPath: 'output/exact.pdf', downloadUrl: 'https://attacker.example/api/cv-pdf?artifact=output%2Fexact.pdf' },
    { status: 'running', artifactPath: null, downloadUrl: null },
    { status: 'completed', artifactPath: 'output/exact.pdf', downloadUrl: env.CAREER_OPS_API_ORIGIN + '/api/cv-pdf?artifact=output%2Fexact.pdf' },
  ];
  let statusCalls = 0, calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    if (String(url).includes('/api/cv-runs/')) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-runs/' + runId);
      const row = rows[statusCalls++];
      return Response.json({ runId, company: 'Example', role: 'Analyst', ...row });
    }
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/cv-pdf?artifact=output%2Fexact.pdf');
    return new Response(null, { status: 302, headers: { location: 'https://attacker.example/payload.pdf' } });
  });
  const unsafe = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId, verifyDownload: true } }), env)).json();
  assert.equal(unsafe.result.structuredContent.status, 'completed');
  assert.equal(unsafe.result.structuredContent.downloadVerified, false);
  assert.equal(unsafe.result.structuredContent.downloadErrorCode, 'CV_DOWNLOAD_URL_INVALID');
  assert.equal(calls, 1);

  const active = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId, verifyDownload: true } }), env)).json();
  assert.equal(active.result.structuredContent.status, 'running');
  assert.equal(active.result.structuredContent.downloadVerified, undefined);
  assert.equal(calls, 2);

  const redirected = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_status', arguments: { runId, verifyDownload: true } }), env)).json();
  assert.equal(redirected.result.structuredContent.status, 'completed');
  assert.equal(redirected.result.structuredContent.downloadVerified, false);
  assert.equal(redirected.result.structuredContent.downloadErrorCode, 'CV_DOWNLOAD_REDIRECT_DENIED');
  assert.equal(calls, 4);
});

test('CV backend stable error code and safe failed-run metadata propagate without arbitrary messages or secrets', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ errorCode: 'GEMINI_GENERATION_FAILED', message: 'secret raw backend detail', runId: '44444444-4444-4444-8444-444444444444', status: 'failed', artifactPath: null, completedAt: null, internalToken: 'supersecret', sourceCV: 'private' }, { status: 502 }));
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_start', arguments: { applicationNumber: '17' } }), env)).json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.errorCode, 'GEMINI_GENERATION_FAILED');
  assert.equal(body.result.structuredContent.status, 'failed');
  assert.equal(body.result.structuredContent.artifactPath, null);
  assert.equal(body.result.structuredContent.completedAt, null);
  assert.ok(!JSON.stringify(body).includes('secret raw backend detail'));
  assert.ok(!JSON.stringify(body).includes('sourceCV'));
  assert.ok(!JSON.stringify(body).includes('supersecret'));
});

test('CV backend exact inbox-membership error propagates by stable code only', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'JOB_NOT_IN_INBOX', message: 'private posting details', internalToken: 'hidden' }, { status: 400 }));
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_start', arguments: { url: 'https://jobs.example/not-in-inbox' } }), env)).json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.errorCode, 'JOB_NOT_IN_INBOX');
  assert.ok(!JSON.stringify(body).includes('private posting details'));
  assert.ok(!JSON.stringify(body).includes('hidden'));
});

test('CV success response must include a valid run ID and recognized state', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sourceCV: 'private', internalToken: 'hidden' }));
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_cv_generate_start', arguments: { applicationNumber: '17' } }), env)).json();
  assert.equal(body.result.isError, true);
  assert.ok(body.result.content[0].text.startsWith('INVALID_CV_RUN:'));
  assert.ok(!JSON.stringify(body).includes('private'));
  assert.ok(!JSON.stringify(body).includes('hidden'));
});

test('evaluation tools are advertised with write start and read-only status/report', async () => {
  const body = await (await worker.fetch(rpc('tools/list', {}, false), env)).json();
  const start = body.result.tools.find(tool => tool.name === 'career_ops_evaluation_start');
  assert.ok(start);
  assert.equal(start.annotations.readOnlyHint, false);
  assert.equal(body.result.tools.find(tool => tool.name === 'career_ops_evaluation_status').annotations.readOnlyHint, true);
  assert.equal(body.result.tools.find(tool => tool.name === 'career_ops_evaluation_report').annotations.readOnlyHint, true);
  assert.match(start.description, /exact URL already in the Inbox/);
  assert.match(start.description, /career_ops_job_import first/);
  assert.match(start.description, /completed/);
});

test('evaluation start enforces exclusive selectors and fixed endpoint with safe queued result', async t => {
  for (const args of [
    {}, { url: 'https://jobs.example/role', applicationNumber: '12' }, { applicationNumber: '0' },
    { applicationNumber: '12', extra: true }, { url: 'ftp://jobs.example/role' },
    { url: 'https://user:pass@jobs.example/role' }, { url: 'https://jobs.example/role\n' },
    { url: 'https://jobs.example/role', idempotencyKey: 'bad key' },
  ]) {
    const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_evaluation_start', arguments: args }), env)).json();
    assert.equal(body.error.code, -32602, JSON.stringify(args));
  }
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/evaluation-runs');
    assert.equal(opts.method, 'POST');
    assert.deepEqual(JSON.parse(opts.body), { url: 'https://jobs.example/role?ref=inbox', idempotencyKey: 'client:abc-123' });
    return Response.json({ runId: '55555555-5555-4555-8555-555555555555', status: 'queued', company: 'Example', role: 'Engineer', privateField: 'must not escape' }, { status: 202 });
  });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_evaluation_start', arguments: { url: 'https://jobs.example/role?ref=inbox', idempotencyKey: 'client:abc-123' } }), env)).json();
  assert.equal(body.result.structuredContent.status, 'queued');
  assert.ok(!JSON.stringify(body).includes('privateField'));
});

test('evaluation status preserves exact allowlisted fields and completed state without inference', async t => {
  let requested;
  t.mock.method(globalThis, 'fetch', async url => {
    requested = String(url);
    return Response.json({ runId: '66666666-6666-4666-8666-666666666666', status: 'completed', company: 'Example', role: 'Engineer', applicationNumber: '37', reportPath: 'reports/037-example.md', score: 82, requestedAt: '2026-10-02T01:00:00Z', startedAt: '2026-10-02T01:01:00Z', completedAt: '2026-10-02T01:02:00Z', errorCode: null, errorMessage: null, secret: 'hidden' });
  });
  const body = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_evaluation_status', arguments: { runId: '66666666-6666-4666-8666-666666666666' } }), env)).json();
  assert.equal(requested, env.CAREER_OPS_API_ORIGIN + '/api/evaluation-runs/66666666-6666-4666-8666-666666666666');
  assert.equal(body.result.structuredContent.status, 'completed');
  assert.equal(body.result.structuredContent.score, 82);
  assert.equal(body.result.structuredContent.applicationNumber, '37');
  assert.ok(!JSON.stringify(body).includes('hidden'));
});

test('evaluation report requires backend completed status and reads only the fixed persisted report endpoint', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    if (calls === 1) {
      assert.equal(String(url), env.CAREER_OPS_API_ORIGIN + '/api/evaluation-runs/77777777-7777-4777-8777-777777777777');
      return Response.json({ runId: '77777777-7777-4777-8777-777777777777', status: 'running' });
    }
    throw new Error('report must not be requested before completed');
  });
  const pending = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_evaluation_report', arguments: { runId: '77777777-7777-4777-8777-777777777777' } }), env)).json();
  assert.equal(pending.result.isError, true);
  assert.equal(pending.result.structuredContent.status, 'running');
  assert.equal(calls, 1);

  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls++;
    assert.equal(opts.method, 'GET');
    if (String(url).endsWith('/report')) return Response.json({ runId: '88888888-8888-4888-8888-888888888888', reportPath: 'reports/038-example.md', contentType: 'text/markdown', report: '# Evaluation\nScore: 81', privateField: 'hidden' });
    return Response.json({ runId: '88888888-8888-4888-8888-888888888888', status: 'completed' });
  });
  const completed = await (await worker.fetch(rpc('tools/call', { name: 'career_ops_evaluation_report', arguments: { runId: '88888888-8888-4888-8888-888888888888' } }), env)).json();
  assert.equal(completed.result.structuredContent.reportPath, 'reports/038-example.md');
  assert.equal(completed.result.structuredContent.report, '# Evaluation\nScore: 81');
  assert.ok(!JSON.stringify(completed).includes('hidden'));
});
