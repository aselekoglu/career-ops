import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyFacts } from '../verify-cv-facts.mjs';

test('an unsupported test count blocks while the supported narrative passes without it', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'career-ops-cv-facts-test-count-'));
  const sourcePath = join(dataDir, 'source.md');
  const configPath = join(dataDir, 'cv-facts.json');

  try {
    writeFileSync(sourcePath, [
      '# Synthetic source',
      '',
      'Contributed to the payment validation suite and ran 18 tests.',
    ].join('\n'));
    writeFileSync(configPath, JSON.stringify({
      allow_metrics: [],
      allow_facts: [],
      forbidden_phrases: [],
      warn_phrases: [],
    }));

    const check = html => verifyFacts(html, { sourcePaths: [sourcePath], configPath });
    const inflated = check('<!doctype html><html><body><p>Contributed to the payment validation suite and ran 33 tests.</p></body></html>');
    assert.equal(inflated.verdict, 'block');
    assert.deepEqual(inflated.invented, ['33 tests']);

    const narrativeOnly = check('<!doctype html><html><body><p>Contributed to the payment validation suite.</p></body></html>');
    assert.equal(narrativeOnly.verdict, 'pass');
    assert.deepEqual(narrativeOnly.invented, []);
    assert.deepEqual(narrativeOnly.unsupportedFacts, []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
