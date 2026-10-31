import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readMode = name => readFileSync(new URL(`../modes/${name}`, import.meta.url), 'utf8');

test('shared profile narrative rules treat positioning as guidance and keep claims evidence-backed', () => {
  const shared = readMode('_shared.md');
  assert.match(shared, /narrative\.headline/);
  assert.match(shared, /narrative\.superpowers/);
  assert.match(shared, /positioning guidance, not as evidence/i);
  assert.match(shared, /adapt their wording to the job/i);
  assert.match(shared, /Do not repeat the same headline/i);
  assert.match(shared, /do not add technologies/i);
});

test('CV, cover-letter and application-answer modes consume positioning adaptively', () => {
  const pdf = readMode('pdf.md');
  assert.match(pdf, /narrative\.headline.*narrative\.superpowers/);
  assert.match(pdf, /canned exit-story bridge/);
  assert.match(pdf, /evidence in the primary sources/);

  const cover = readMode('cover.md');
  assert.match(cover, /`narrative\.headline` and `narrative\.superpowers`/);
  assert.match(cover, /verified primary-source evidence/);
  assert.match(cover, /Avoid copying the same headline/i);

  const apply = readMode('apply.md');
  assert.match(apply, /read `narrative\.headline` and `narrative\.superpowers`/i);
  assert.match(apply, /Treat them as positioning guidance, not proof/);
  assert.match(apply, /support every experience, impact, and technology claim/i);
});
