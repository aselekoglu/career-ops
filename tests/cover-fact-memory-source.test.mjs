import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertFacts, verifyFacts } from '../verify-cv-facts.mjs';

const configPath = 'no-fact-config.json';

test('in-memory source texts produce the same fact findings as the same synthetic file source', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-fact-source-'));
  try {
    mkdirSync(join(root, 'sources'));
    const source = 'Improved throughput by 20%. Built internal workflows using Python.';
    writeFileSync(join(root, 'sources', 'facts.md'), source, 'utf8');
    const target = 'Improved throughput by 50%. Built internal workflows using Python and Kubernetes.';
    const fromDisk = verifyFacts(target, { sourcePaths: ['sources/facts.md'], configPath, cwd: root });
    const fromMemory = verifyFacts(target, { sourceTexts: [source], configPath, cwd: root });
    assert.deepEqual(fromMemory, fromDisk);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in-memory sources block unsupported counts and technology names', () => {
  const result = verifyFacts('Built internal workflows using Python and Kubernetes, serving 500 customers.', {
    sourceTexts: ['Built internal workflows using Python.'],
    configPath,
  });
  assert.equal(result.verdict, 'block');
  assert.ok(result.invented.some((claim) => claim.includes('500')));
  assert.ok(result.unsupportedFacts.some(({ kind, value }) => kind === 'tool' && /kubernetes/i.test(value)));
});

test('in-memory source inputs reject empty, invalid, oversized, and mixed sources', () => {
  const target = 'Built Kubernetes systems.';
  for (const options of [
    { sourceTexts: [] },
    { sourceTexts: [''] },
    { sourceTexts: ['   '] },
    { sourceTexts: [42] },
    { sourceTexts: ['x'.repeat(500_001)] },
    { sourceTexts: ['valid source'], sourcePaths: [] },
  ]) {
    assert.throws(() => verifyFacts(target, { configPath, ...options }));
  }
  assert.throws(() => assertFacts(target, { configPath, sourceTexts: [] }));
});


test('in-memory config text produces the same findings as the same synthetic file config without writing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-fact-config-'));
  try {
    const config = { allow_metrics: ['20%'], allow_facts: [], forbidden_phrases: ['restricted phrase'], warn_phrases: ['temporary'] };
    const configText = JSON.stringify(config);
    writeFileSync(join(root, 'fact-config.json'), configText, 'utf8');
    const sourceTexts = ['Built an internal workflow.'];
    const target = 'Built an internal workflow for a temporary test; restricted phrase.';
    const fromFile = verifyFacts(target, { sourceTexts, configPath: 'fact-config.json', cwd: root });
    const before = readdirSync(root).sort();
    const fromMemory = verifyFacts(target, { sourceTexts, configText, cwd: root });
    assert.deepEqual(fromMemory, fromFile);
    assert.equal(fromMemory.configMissing, false);
    assert.deepEqual(readdirSync(root).sort(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in-memory config rejects malformed, wrong-shaped, oversized, empty, and mixed values', () => {
  for (const configText of ['', '  ', '{', '[]', JSON.stringify({ allow_metrics: '20%' }), `{"warn_phrases":["${"x".repeat(100_001)}"]}`]) {
    assert.throws(() => verifyFacts('A target statement.', { configText, sourceTexts: ['A source statement.'] }));
  }
  assert.throws(() => verifyFacts('A target statement.', { configText: 42, sourceTexts: ['A source statement.'] }));
  assert.throws(() => verifyFacts('A target statement.', { configText: '{}', configPath: 'explicit.json', sourceTexts: ['A source statement.'] }));
  assert.throws(() => assertFacts('A target statement.', { configText: '{', sourceTexts: ['A source statement.'] }));
});


test('explicit undefined source and config paths retain their defaults and do not conflict with memory values', () => {
  const options = { sourceTexts: ['Built internal workflows using Python.'], configText: JSON.stringify({ allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [] }) };
  const expected = verifyFacts('Built internal workflows using Python.', options);
  const withUndefined = verifyFacts('Built internal workflows using Python.', { ...options, sourcePaths: undefined, configPath: undefined });
  assert.deepEqual(withUndefined, expected);
});
