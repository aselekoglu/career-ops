import { createHash } from 'node:crypto';
import { authorizePortfolio } from './portfolio-cloud.mjs';
import { createCoverLetterRuntime } from './cover-letter-runtime.mjs';
import { allowCoverLetterCloudPost } from './cover-letter-cloud-gate.mjs';
import { assertFacts } from '../../../verify-cv-facts.mjs';

const MAX_CV_BYTES = 250_000;
const MAX_PROFILE_BYTES = 200_000;
const MAX_ARTICLE_BYTES = 250_000;
const MAX_FACT_CONFIG_BYTES = 64_000;
const MAX_GENERATED_BYTES = 50_000;
const SHA = /^[a-f0-9]{64}$/;
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const error = (code) => Object.assign(new Error(code), { code });
const utf8Size = (value) => Buffer.byteLength(value, 'utf8');

function verifiedTextDocument(row, expectedPath, maxBytes, optional = false) {
  if (!row) {
    if (optional) return null;
    throw error('COVER_LETTER_SOURCE_UNAVAILABLE');
  }
  if (row.path !== expectedPath || row.content_encoding !== 'utf8' || typeof row.content !== 'string' ||
      !Number.isSafeInteger(Number(row.byte_size)) || !SHA.test(row.sha256 || '')) throw error('COVER_LETTER_SOURCE_UNAVAILABLE');
  const size = utf8Size(row.content);
  if (!size || size > maxBytes || Number(row.byte_size) !== size || sha(row.content) !== row.sha256) throw error('COVER_LETTER_SOURCE_UNAVAILABLE');
  return { content: row.content, sha256: row.sha256 };
}

function safeFailure(code, status = 503) {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function defaultPoolFactory(connectionString) {
  const { Pool } = await import('@neondatabase/serverless');
  return new Pool({ connectionString, max: 1, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 1_000 });
}

/**
 * Request-scoped live composition. The pool is created and ended inside this
 * handler; no schema initialization or render dispatcher is wired here.
 * Injected readers/pool/runtime are test seams only.
 */
export function createCoverLetterLiveHandler({
  env = process.env,
  authorize = (request) => { authorizePortfolio(request, env); return true; },
  createPool = defaultPoolFactory,
  createAi,
  readApplications,
  readDocument,
  createRuntime = (options) => createCoverLetterRuntime(options),
  factGate = assertFacts,
} = {}) {
  if (typeof authorize !== 'function' || typeof createPool !== 'function' || createAi !== undefined && typeof createAi !== 'function' || typeof createRuntime !== 'function' || typeof factGate !== 'function') {
    throw new TypeError('COVER_LETTER_LIVE_NOT_CONFIGURED');
  }
  return async function handle(request) {
    if (request.method !== 'POST') return safeFailure('METHOD_NOT_ALLOWED', 405);
    try {
      if (await authorize(request) !== true) throw Object.assign(new Error('unauthorized'), { status: 401 });
    }
    catch (authError) {
      const status = authError?.status === 503 ? 503 : authError?.status === 403 ? 403 : 401;
      const code = status === 503 ? 'COVER_LETTER_AUTH_NOT_CONFIGURED' : status === 403 ? 'COVER_LETTER_ORIGIN_DENIED' : 'COVER_LETTER_UNAUTHORIZED';
      return safeFailure(code, status);
    }
    if (env.CAREER_OPS_COVER_LETTER_ENABLED !== '1' || !allowCoverLetterCloudPost(new URL(request.url).pathname, request.method, env)) {
      return safeFailure('COVER_LETTER_DISABLED', 404);
    }
    const connectionString = typeof env.DATABASE_URL === 'string' ? env.DATABASE_URL.trim() : '';
    if (!connectionString) return safeFailure('COVER_LETTER_STORAGE_UNAVAILABLE', 503);
    let pool;
    try { pool = await createPool(connectionString); }
    catch { return safeFailure('COVER_LETTER_STORAGE_UNAVAILABLE', 503); }
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
      try { await pool?.end?.(); } catch {}
      return safeFailure('COVER_LETTER_STORAGE_UNAVAILABLE', 503);
    }
    try {
      const ai = createAi
        ? createAi({ env })
        : (await import('./ai/hosted-ai.mjs')).createHostedAiService({ env });
      const loadApplications = readApplications ?? (async () => (await import('./cloud-career-ops.ts')).cloudReadApplications());
      const loadDocument = readDocument ?? (async (path) => (await import('./cloud-store.ts')).getCloudDocument(path));
      const sourceSnapshots = [];
      let factFailure = null;
      const failFactGate = (code) => { factFailure = code; throw error(code); };

      const readTrackerApplication = async (number) => (await loadApplications()).find((row) => row.n === number) ?? null;
      const readReport = async (path) => {
        const row = await loadDocument(path);
        const doc = verifiedTextDocument(row, path, 2_000_000);
        return { path, content: doc.content, sha256: doc.sha256 };
      };
      const readCanonicalCv = async () => {
        const [cvRow, articleRow, configRow] = await Promise.all([
          loadDocument('cv.md'), loadDocument('article-digest.md'), loadDocument('config/cv-facts.json'),
        ]);
        const cv = verifiedTextDocument(cvRow, 'cv.md', MAX_CV_BYTES);
        const article = verifiedTextDocument(articleRow, 'article-digest.md', MAX_ARTICLE_BYTES, true);
        const config = verifiedTextDocument(configRow, 'config/cv-facts.json', MAX_FACT_CONFIG_BYTES, true);
        sourceSnapshots.push({
          sourceTexts: [cv.content, ...(article ? [article.content] : [])],
          configText: config?.content ?? null,
        });
        return cv.content;
      };
      const readCanonicalProfile = async () => {
        const row = await loadDocument('config/profile.yml');
        return verifiedTextDocument(row, 'config/profile.yml', MAX_PROFILE_BYTES).content;
      };

      const hostedAi = Object.freeze({
        status: () => ai.status(),
        async *stream(input) {
          if (!input || input.task !== 'cv') throw error('COVER_LETTER_AI_INPUT_INVALID');
          // Runtime resolves the target once for the API and once for the store.
          // The first captured snapshot is exactly the one used to build this prompt.
          const sources = sourceSnapshots.shift();
          if (!sources) failFactGate('COVER_LETTER_FACT_SOURCES_UNAVAILABLE');
          if (typeof sources.configText !== 'string') failFactGate('COVER_LETTER_FACT_CONFIG_MISSING');
          let configCheck;
          try { configCheck = factGate('', { sourceTexts: sources.sourceTexts, configText: sources.configText, label: 'cover letter' }); }
          catch { failFactGate('COVER_LETTER_FACT_CONFIG_INVALID'); }
          if (configCheck?.configMissing) failFactGate('COVER_LETTER_FACT_CONFIG_MISSING');
          let draft = '';
          for await (const event of ai.stream(input)) {
            if (event?.type !== 'text' || typeof event.text !== 'string') continue;
            draft += event.text;
            if (utf8Size(draft) > MAX_GENERATED_BYTES) throw error('COVER_LETTER_DRAFT_INVALID');
          }
          if (!draft.trim()) throw error('COVER_LETTER_DRAFT_INVALID');
          let verdict;
          try { verdict = factGate(draft, { sourceTexts: sources.sourceTexts, configText: sources.configText, label: 'cover letter' }); }
          catch { failFactGate('COVER_LETTER_FACT_CHECK_FAILED'); }
          if (verdict?.configMissing) failFactGate('COVER_LETTER_FACT_CONFIG_MISSING');
          if (verdict?.verdict === 'block') failFactGate('COVER_LETTER_FACT_CHECK_FAILED');
          if (!verdict || !['pass', 'warn'].includes(verdict.verdict)) failFactGate('COVER_LETTER_FACT_GATE_UNAVAILABLE');
          yield { type: 'text', text: draft };
        },
      });

      const runtime = createRuntime({
        pool,
        authorizeOwner: async (req) => {
          if (await authorize(req) !== true) throw Object.assign(new Error('unauthorized'), { status: 401 });
          return true;
        },
        readTrackerApplication,
        readReport,
        readCanonicalCv,
        readCanonicalProfile,
        hostedAi,
        // No renderer or worker is wired in this vertical slice.
      });
      const response = await runtime.api(request);
      if (factFailure) {
        const status = factFailure === 'COVER_LETTER_FACT_CHECK_FAILED' ? 422 : 503;
        return safeFailure(factFailure, status);
      }
      return response;
    } catch (failure) {
      const known = new Map([
        ['COVER_LETTER_FACT_CONFIG_MISSING', 503], ['COVER_LETTER_FACT_CONFIG_INVALID', 503], ['COVER_LETTER_FACT_CHECK_FAILED', 422],
        ['COVER_LETTER_FACT_GATE_UNAVAILABLE', 503], ['COVER_LETTER_SOURCE_UNAVAILABLE', 503],
      ]);
      const status = known.get(failure?.code);
      if (status) return safeFailure(failure.code, status);
      return safeFailure('COVER_LETTER_LIVE_UNAVAILABLE', 503);
    } finally {
      try { await pool.end(); } catch {}
    }
  };
}

export async function handleLiveCoverLetter(request) {
  return createCoverLetterLiveHandler()(request);
}
