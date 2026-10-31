import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderApprovedCoverLetter } from '../../src/lib/cover-letter-render.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const temp = mkdtempSync(resolve(tmpdir(), 'cover-letter-render-'));
const sourcePath = resolve(temp, 'cv.md');
writeFileSync(sourcePath, '# CV\nCandidate works on products.\n', 'utf8');
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const templatePath = resolve(repositoryRoot, 'templates/cover-letter-template.html');
const approvedText = 'Dear <team>,\nI build products & systems.\n\nRegards,\nA. Candidate';
const fixture = (overrides = {}) => ({
  approvedText,
  expectedSha256: sha(approvedText),
  currentSha256: sha(approvedText),
  header: { candidate: { name: 'A. Candidate' }, letter: { role_title: 'Engineer', company: 'Example Co', date: '2026-10-31' } },
  templatePath,
  sourcePaths: [sourcePath],
  ...overrides,
});

test.after(() => rmSync(temp, { recursive: true, force: true }));

test('renders approved text escaped with whitespace preserved as the entire body', () => {
  const result = renderApprovedCoverLetter(fixture());
  assert.equal(result.approvedSha256, fixture().expectedSha256);
  assert.match(result.html, /<div class="approved-body" style="white-space: pre-wrap">Dear &lt;team&gt;,\nI build products &amp; systems\.\n\nRegards,\nA\. Candidate<\/div>/);
  assert.doesNotMatch(result.html, /<p class="greeting">|<ul class="achievements">|class="signature"|class="footnotes"/);
});

test('rejects stale approved hash before rendering', () => {
  assert.throws(() => renderApprovedCoverLetter(fixture({ currentSha256: '0'.repeat(64) })), { code: 'COVER_LETTER_DRAFT_CHANGED' });
});

test('fails closed when template does not have canonical body shape', () => {
  assert.throws(() => renderApprovedCoverLetter(fixture({ templatePath: resolve(temp, 'unsupported.html') })), { code: 'COVER_LETTER_TEMPLATE_UNSUPPORTED' });
});

test('runs source fact gate against approved body', () => {
  const text = 'I managed 900 staff.';
  assert.throws(() => renderApprovedCoverLetter(fixture({ approvedText: text, expectedSha256: sha(text), currentSha256: sha(text) })), /Fact check failed for cover letter/);
});

test('rejects nested containers or extra content after dateline', () => {
  const original = readFileSync(templatePath, 'utf8');
  const nestedPath = resolve(temp, 'nested.html');
  writeFileSync(nestedPath, original.replace('{{GREETING_BLOCK}}', '<section>{{GREETING_BLOCK}}').replace('{{FOOTNOTES_BLOCK}}', '{{FOOTNOTES_BLOCK}}</section>'), 'utf8');
  assert.throws(() => renderApprovedCoverLetter(fixture({ templatePath: nestedPath })), { code: 'COVER_LETTER_TEMPLATE_UNSUPPORTED' });
  const extraPath = resolve(temp, 'extra.html');
  writeFileSync(extraPath, original.replace('</body>', '<p>Custom content</p></body>'), 'utf8');
  assert.throws(() => renderApprovedCoverLetter(fixture({ templatePath: extraPath })), { code: 'COVER_LETTER_TEMPLATE_UNSUPPORTED' });
});

test('rejects missing or empty authoritative sources before the fact gate', () => {
  assert.throws(() => renderApprovedCoverLetter(fixture({ sourcePaths: [resolve(temp, 'missing.md')] })), { code: 'COVER_LETTER_SOURCES_UNAVAILABLE' });
  const emptyPath = resolve(temp, 'empty.md');
  writeFileSync(emptyPath, '  \n', 'utf8');
  assert.throws(() => renderApprovedCoverLetter(fixture({ sourcePaths: [emptyPath] })), { code: 'COVER_LETTER_SOURCES_UNAVAILABLE' });
});
