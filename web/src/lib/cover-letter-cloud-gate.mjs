/** Allow exactly the opt-in cover-letter mutation after proxy owner auth. */
export function allowCoverLetterCloudPost(pathname, method, env = process.env) {
  return pathname === '/api/cover-letter' && method === 'POST' && env.CAREER_OPS_COVER_LETTER_ENABLED === '1';
}
