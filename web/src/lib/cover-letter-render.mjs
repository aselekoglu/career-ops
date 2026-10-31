import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertFacts } from '../../../verify-cv-facts.mjs';
import { buildHtml, resolveCoverTemplatePath } from '../../../generate-cover-letter.mjs';

const HASH = /^[a-f0-9]{64}$/;
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const equalHash = (a, b) => HASH.test(a || '') && HASH.test(b || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const BODY_SUFFIX = /\r?\n  \{\{GREETING_BLOCK\}\}\r?\n  <p>\{\{OPENING\}\}<\/p>\r?\n  <p>\{\{PROFILE_INTRO\}\}<\/p>\r?\n\r?\n  \{\{ACHIEVEMENTS_BLOCK\}\}\r?\n\r?\n  \{\{PROBLEMS_BLOCK\}\}\r?\n  \{\{CLOSING_BLOCK\}\}\r?\n  \{\{LANGUAGE_CLOSING_BLOCK\}\}\r?\n  \{\{SIGNATURE_BLOCK\}\}\r?\n  \{\{FOOTNOTES_BLOCK\}\}\r?\n<\/body>\s*<\/html>\s*$/;
const fail = (code) => Object.assign(new Error(code), { code });

/** Render an already-approved plain-text body without dispatching or writing it. */
export function renderApprovedCoverLetter({ approvedText, expectedSha256, currentSha256, header, templatePath, sourcePaths, configPath } = {}) {
  if (typeof approvedText !== 'string' || !approvedText.trim() || !equalHash(digest(approvedText), expectedSha256) || !equalHash(expectedSha256, currentSha256)) throw fail('COVER_LETTER_DRAFT_CHANGED');
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw fail('COVER_LETTER_SOURCES_REQUIRED');
  let hasAuthoritativeSource = false;
  try {
    for (const path of sourcePaths) {
      const source = readFileSync(path, 'utf8');
      if (source.trim()) hasAuthoritativeSource = true;
    }
  } catch { throw fail('COVER_LETTER_SOURCES_UNAVAILABLE'); }
  if (!hasAuthoritativeSource) throw fail('COVER_LETTER_SOURCES_UNAVAILABLE');
  const candidate = header?.candidate;
  const letter = header?.letter;
  if (!candidate || typeof candidate.name !== 'string' || !candidate.name.trim() || !letter || typeof letter.role_title !== 'string' || !letter.role_title.trim() || typeof letter.company !== 'string' || !letter.company.trim() || typeof letter.date !== 'string' || !letter.date.trim()) throw fail('COVER_LETTER_HEADER_REQUIRED');
  const payload = { candidate, letter: { ...letter, opening: '', profile_intro: '' } };
  const resolvedTemplate = resolve(templatePath || resolveCoverTemplatePath(payload));
  let sourceTemplate;
  try { sourceTemplate = readFileSync(resolvedTemplate, 'utf8'); }
  catch { throw fail('COVER_LETTER_TEMPLATE_UNSUPPORTED'); }
  if ((sourceTemplate.match(/<div class="dateline">\{\{DATELINE\}\}<\/div>/g) || []).length !== 1 || !BODY_SUFFIX.test(sourceTemplate)) throw fail('COVER_LETTER_TEMPLATE_UNSUPPORTED');
  let html = buildHtml(payload, resolvedTemplate);
  const bodyStart = html.indexOf('<div class="dateline">');
  const bodyEnd = html.lastIndexOf('</body>');
  if (bodyStart < 0 || bodyEnd <= bodyStart) throw fail('COVER_LETTER_TEMPLATE_UNSUPPORTED');
  const headerEnd = html.indexOf('</div>', bodyStart) + '</div>'.length;
  // Preserve the validated document tail and closing tags; replace only the
  // canonical body slots between the dateline and the </body> boundary.
  html = `${html.slice(0, headerEnd)}\n  <div class="approved-body" style="white-space: pre-wrap">${escape(approvedText)}</div>${html.slice(bodyEnd)}`;
  assertFacts(html, { label: 'cover letter', sourcePaths, ...(configPath ? { configPath } : {}) });
  return Object.freeze({ html, approvedSha256: expectedSha256 });
}
