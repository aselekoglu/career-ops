import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScanInput, selectScanConfig, buildLiveResult, pipelineAdditions, validateReceipt } from '../../src/lib/live-scan-contract.mjs';

const request = { mode: 'portals', sinceDays: 5, limit: 50 };
const startedAt = '2026-10-01T15:00:00.000Z';
const completedAt = '2026-10-01T15:05:00.000Z';
const job = (url, postedAt, known = false) => ({ company: 'Example', title: 'Software Engineer', location: 'Ottawa', url, source: 'greenhouse-api', postedAt, known });
const receipt = jobs => ({ version: 'careerops.scan.live@1', startedAt, completedAt, found: 20, duplicates: 0, sources: [{ company: 'Example', source: 'greenhouse', status: 'ok' }], errors: [], jobs });

test('scan request rejects unknown schema fields, URLs, unsupported full mode and invalid windows', () => {
  assert.deepEqual(validateScanInput({ sinceDays: 5 }), request);
  for (const bad of [{ url: 'https://example.com' }, { mode: 'full' }, { sinceDays: 0 }, { sinceDays: 31 }, { companies: ['https://example.com'] }, { limit: 501 }, { sinceDays: '5' }]) assert.throws(() => validateScanInput(bad));
});
test('only enabled configured companies are selected; no parallel job-board discovery', () => {
  const config = { tracked_companies: [{ name: 'Example' }, { name: 'Disabled', enabled: false }], job_boards: [{ name: 'Broad' }], title_filter: { positive: ['Engineer'] } };
  assert.equal(selectScanConfig(config, request).tracked_companies.length, 1);
  assert.deepEqual(selectScanConfig(config, request).job_boards, []);
  assert.throws(() => selectScanConfig(config, { ...request, companies: ['Unknown'] }));
  assert.throws(() => selectScanConfig(config, { ...request, companies: ['Disabled'] }));
});
test('successful live receipt has actual scan timestamps and explicit fresh provenance', () => {
  const result = buildLiveResult(receipt([job('https://example.com/1', Date.parse('2026-09-29'))]), request);
  assert.equal(result.status, 'completed'); assert.equal(result.fresh, true); assert.equal(result.startedAt, startedAt); assert.equal(result.completedAt, completedAt);
  assert.equal(result.jobsInspected, 20); assert.equal(result.jobsMatched, 1); assert.equal(result.newJobs, 1); assert.equal(result.jobs[0].lastSeenAt, completedAt);
});
test('sinceDays uses ATS date; old dates are excluded and unknown dates stay separate', () => {
  const result = buildLiveResult(receipt([job('https://example.com/1', Date.parse('2026-09-01')), job('https://example.com/2', null), job('https://example.com/3', Date.parse('2026-09-29'))]), request);
  assert.equal(result.jobs.length, 1); assert.equal(result.unknownJobs.length, 1); assert.equal(result.unknownJobs[0].postedAt, null); assert.equal(result.unknownJobs[0].postedAtStatus, 'unknown');
});
test('URL duplicates and already-known jobs do not become new discoveries', () => {
  const result = buildLiveResult(receipt([job('https://example.com/1', Date.parse('2026-09-29'), true), job('https://example.com/1', Date.parse('2026-09-29'), true)]), request);
  assert.equal(result.jobsMatched, 1); assert.equal(result.newJobs, 0); assert.equal(result.jobs[0].discoveredAt, null);
});
test('one failed portal produces explicit partial coverage while successful data remains', () => {
  const raw = receipt([job('https://example.com/1', Date.parse('2026-09-29'))]); raw.errors = [{ company: 'Broken', error: 'request failed' }]; raw.sources.push({ company: 'Broken', source: 'lever', status: 'failed' });
  const result = buildLiveResult(raw, request); assert.equal(result.status, 'partial'); assert.equal(result.sourcesFailed, 1); assert.equal(result.jobs.length, 1);
});
test('a fresh zero-result scan is distinct from a stale stored snapshot', () => {
  const result = buildLiveResult(receipt([]), request); assert.equal(result.jobsMatched, 0); assert.equal(result.fresh, true); assert.equal(result.storage, 'live-scan');
  assert.throws(() => validateReceipt({ storage: 'imported-neon-snapshot', applications: [], inbox: [] }));
});
test('worker receipts with reversed timestamps, oversized jobs or arbitrary source URLs are rejected', () => {
  assert.throws(() => validateReceipt({ ...receipt([]), completedAt: '2026-09-01T00:00:00Z' }));
  assert.throws(() => validateReceipt(receipt([job('file:///secret', null)])));
  assert.throws(() => validateReceipt(receipt([job('https://example.com/1\n- [ ] https://attacker.invalid/extra | Injected | Engineer',null)])));
  assert.throws(() => validateReceipt({ ...receipt([]), jobs: Array(5001).fill(job('https://example.com/1', null)) }));
});
test('future dates never count as verified recent postings; relative ATS evidence is preserved', () => {
  const result = buildLiveResult(receipt([{ ...job('https://example.com/1', Date.parse('2026-11-01')), postedAtEvidence: 'future' }, { ...job('https://example.com/2', Date.parse('2026-09-30')), postedAtEvidence: 'Posted Yesterday', postedAtPrecision: 'day' }]), request);
  assert.equal(result.unknownJobs.length, 1); assert.equal(result.jobs[0].postedAtStatus, 'ats-reported-day'); assert.equal(result.jobs[0].postedAtEvidence, 'Posted Yesterday');
});
test('inbox persistence preserves existing content and never adds duplicate or invented dates', () => {
  const result = buildLiveResult(receipt([job('https://example.com/1', Date.parse('2026-09-29')), job('https://example.com/2', null)]), request);
  const prior = '# Inbox\n- [x] https://example.com/1 | Example | Software Engineer\n';
  const additions = pipelineAdditions(prior, result); assert.equal(additions.newJobs, 1); assert.ok(!additions.content.includes('https://example.com/1 | Example | Software Engineer\n- [ ] https://example.com/1')); assert.ok(additions.content.includes('posted: unknown'));
});
