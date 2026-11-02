import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePortalVerification } from '../src/lib/portal-verification.mjs';

test('cloud without a database returns unavailable without running verifiers', async () => {
  let cloudCalls = 0;
  let localCalls = 0;

  const result = await resolvePortalVerification({
    cloud: true,
    databaseConfigured: false,
    cloudVerify: async () => { cloudCalls += 1; },
    localVerify: async () => { localCalls += 1; },
  });

  assert.equal(result.status, 501);
  assert.deepEqual(result.body, {
    error: 'Cloud portal verification is disabled without Neon.',
    code: 'CLOUD_EXECUTION_DISABLED',
    available: false,
    configured: false,
    companies: [],
    cloud: true,
    readOnly: true,
    note: 'Hosted portal snapshot is unavailable without Neon; live ATS checks remain disabled.',
  });
  assert.equal(cloudCalls, 0);
  assert.equal(localCalls, 0);
});

test('cloud with a database uses the cloud snapshot verifier', async () => {
  let localCalls = 0;
  const snapshot = { available: true, companies: [{ name: 'Example' }] };

  const result = await resolvePortalVerification({
    cloud: true,
    databaseConfigured: true,
    cloudVerify: async () => snapshot,
    localVerify: async () => { localCalls += 1; },
  });

  assert.deepEqual(result, { status: 200, body: snapshot });
  assert.equal(localCalls, 0);
});

test('local runtime with a database uses the cloud snapshot verifier', async () => {
  let localCalls = 0;
  const snapshot = { available: true, companies: [{ name: 'Example' }] };

  const result = await resolvePortalVerification({
    cloud: false,
    databaseConfigured: true,
    cloudVerify: async () => snapshot,
    localVerify: async () => { localCalls += 1; },
  });

  assert.deepEqual(result, { status: 200, body: snapshot });
  assert.equal(localCalls, 0);
});

test('local runtime uses the local verifier', async () => {
  let cloudCalls = 0;
  const localResult = { available: true, companies: [{ name: 'Local' }] };

  const result = await resolvePortalVerification({
    cloud: false,
    databaseConfigured: false,
    cloudVerify: async () => { cloudCalls += 1; },
    localVerify: async () => localResult,
  });

  assert.deepEqual(result, { status: 200, body: localResult });
  assert.equal(cloudCalls, 0);
});
