import test from 'node:test';
import assert from 'node:assert/strict';
import { allowCoverLetterCloudPost } from '../../src/lib/cover-letter-cloud-gate.mjs';

test('only the enabled cover-letter POST is admitted by the cloud gate', () => {
  assert.equal(allowCoverLetterCloudPost('/api/cover-letter', 'POST', { CAREER_OPS_COVER_LETTER_ENABLED: '1' }), true);
  assert.equal(allowCoverLetterCloudPost('/api/cover-letter', 'GET', { CAREER_OPS_COVER_LETTER_ENABLED: '1' }), false);
  assert.equal(allowCoverLetterCloudPost('/api/cover-letter/', 'POST', { CAREER_OPS_COVER_LETTER_ENABLED: '1' }), false);
  assert.equal(allowCoverLetterCloudPost('/api/cv-runs', 'POST', { CAREER_OPS_COVER_LETTER_ENABLED: '1' }), false);
  assert.equal(allowCoverLetterCloudPost('/api/cover-letter', 'POST', {}), false);
  assert.equal(allowCoverLetterCloudPost('/api/cover-letter', 'POST', { CAREER_OPS_COVER_LETTER_ENABLED: 'true' }), false);
});
