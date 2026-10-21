import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANONICAL_SKILL_PATH,
  ensureSkillEntrypoints,
  materializeSkillEntrypoints,
} from '../scaffolder/bin/skill-entrypoints.mjs';

test('Cursor skill entrypoint is created and materialized from the canonical router', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-cursor-skill-'));
  const cursorPath = '.cursor/skills/career-ops/SKILL.md';
  try {
    const canonicalPath = join(root, ...CANONICAL_SKILL_PATH.split('/'));
    mkdirSync(join(root, '.agents/skills/career-ops'), { recursive: true });
    writeFileSync(canonicalPath, '# Canonical skill\n', 'utf8');

    const created = ensureSkillEntrypoints(root);
    assert.ok(created.includes(cursorPath), 'Cursor must be registered alongside supported CLI entrypoints');
    const localPath = join(root, ...cursorPath.split('/'));
    assert.equal(readFileSync(localPath, 'utf8'), '# Canonical skill\n');

    writeFileSync(localPath, '../../../.agents/skills/career-ops/SKILL.md');
    const materialized = materializeSkillEntrypoints(root);
    assert.ok(materialized.includes(cursorPath));
    assert.equal(readFileSync(localPath, 'utf8'), '# Canonical skill\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('system updater owns only the Career Ops Cursor skill subtree', () => {
  const updater = readFileSync(new URL('../update-system.mjs', import.meta.url), 'utf8');
  assert.match(updater, /^\s*'\.cursor\/skills\/career-ops\/',\s*$/m);
  assert.doesNotMatch(updater, /^\s*'\.cursor\/skills\/',\s*$/m);
});
