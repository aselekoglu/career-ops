import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = path.join(ROOT, 'web/src/lib/canonical-fact-gate');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('web fact gate package is the exact canonical gate and its runtime helpers', () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE, 'manifest.json'), 'utf8'));
  for (const [source, packaged] of Object.entries(manifest.files)) {
    const canonical = readFileSync(path.join(ROOT, source));
    const bundled = readFileSync(path.join(PACKAGE, packaged.path));
    assert.equal(sha256(bundled), packaged.sha256, `${packaged.path} package hash`);
    assert.deepEqual(bundled, canonical, `${packaged.path} must exactly match ${source}`);
  }
  const live = readFileSync(path.join(ROOT, 'web/src/lib/cover-letter-live.mjs'), 'utf8');
  assert.match(live, /from ['"]\.\/canonical-fact-gate\/verify-cv-facts\.mjs['"]/);
});

test('web-only prebuild rejects a missing or modified packaged gate', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'career-ops-fact-gate-'));
  try {
    const web = path.join(temp, 'web');
    cpSync(path.join(ROOT, 'web/scripts/check-fact-gate-package.mjs'), path.join(web, 'scripts/check-fact-gate-package.mjs'), { recursive: true });
    cpSync(PACKAGE, path.join(web, 'src/lib/canonical-fact-gate'), { recursive: true });
    const checker = path.join(web, 'scripts/check-fact-gate-package.mjs');
    const run = () => spawnSync(process.execPath, [checker], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    const gatePath = path.join(web, 'src/lib/canonical-fact-gate/verify-cv-facts.mjs');
    writeFileSync(gatePath, `${readFileSync(gatePath, 'utf8')}\n// stale`, 'utf8');
    const stale = run();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /hash mismatch/);
    rmSync(gatePath);
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /packaged file missing/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
