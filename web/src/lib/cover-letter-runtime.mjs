import { buildHostedCoverPrompt } from './ai/hosted-cover-prompt.mjs';
import { createCoverLetterApi } from './cover-letter-api.mjs';
import { createCoverLetterRunService } from './cover-letter-runs.mjs';
import { createPostgresCoverLetterStore } from './cover-letter-store.mjs';
import { createCoverLetterTargetResolver } from './cover-letter-target.mjs';

const runtimeError = (code) => Object.assign(new Error(code), { code });

/**
 * Compose the single-owner cover-letter runtime from explicit dependencies.
 * Canonical readers must return exact records. The shared target resolver
 * validates the tracker's exact report link, report filename and stored SHA,
 * report identity, substantive archived JD, CV and profile. Schema setup
 * remains an explicit caller-owned operation.
 *
 * Hosted AI must implement the existing `status()` and `stream()` contract.
 * Optional dispatcher contract: `isConfigured() -> true` and
 * `dispatchPending({runId, approvedSha256})`; the dispatcher must consume the
 * durable outbox idempotently by run ID and SHA. Without it approval is blocked.
 */
export function createCoverLetterRuntime({
  pool, authorizeOwner, readTrackerApplication, readReport, readCanonicalCv, readCanonicalProfile,
  hostedAi, renderDispatcher = null, now,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function' ||
      typeof authorizeOwner !== 'function' || typeof readTrackerApplication !== 'function' ||
      typeof readReport !== 'function' || typeof readCanonicalCv !== 'function' || typeof readCanonicalProfile !== 'function' ||
      !hostedAi || typeof hostedAi.status !== 'function' || typeof hostedAi.stream !== 'function' ||
      renderDispatcher !== null && (typeof renderDispatcher.isConfigured !== 'function' || typeof renderDispatcher.dispatchPending !== 'function')) {
    throw runtimeError('COVER_LETTER_RUNTIME_NOT_CONFIGURED');
  }

  const resolveTarget = createCoverLetterTargetResolver({ readTrackerApplication, readReport, readCanonicalCv, readCanonicalProfile });

  const store = createPostgresCoverLetterStore({ pool, resolveBinding: (applicationNumber, reportNumber) => resolveTarget({ applicationNumber, reportNumber }) });
  const baseService = createCoverLetterRunService({ store, ...(now ? { now } : {}) });
  const service = Object.freeze({
    ...baseService,
    async approve(runId, input) {
      let ready = false;
      try { ready = renderDispatcher !== null && await renderDispatcher.isConfigured() === true; } catch { ready = false; }
      if (!ready) throw runtimeError('COVER_LETTER_RENDER_UNAVAILABLE');
      const approved = await baseService.approve(runId, input);
      try { await renderDispatcher.dispatchPending({ runId, approvedSha256: approved.approvedSha256 }); }
      catch { throw runtimeError('COVER_LETTER_RENDER_UNAVAILABLE'); }
      return approved;
    },
  });

  const api = createCoverLetterApi({
    service,
    authorizeOwner,
    async resolveTrustedStart({ applicationNumber, reportNumber }) {
      const target = await resolveTarget({ applicationNumber, reportNumber });
      if (!target) return null;
      return target;
    },
    async generateDraft({ binding, sources, prerequisites }) {
      const prompt = buildHostedCoverPrompt({
        canonicalCv: sources.canonicalCv,
        canonicalProfile: sources.canonicalProfile,
        archivedJd: sources.archivedJd,
        company: binding.company,
        role: binding.role,
        confirmedResearch: prerequisites.confirmedResearch,
        confirmedKeywords: prerequisites.confirmedKeywords,
        gapDecisions: prerequisites.gapDecisions,
        answers: prerequisites.answers,
      });
      if (!prompt.ok) throw runtimeError(prompt.code);
      if (hostedAi.status()?.ready !== true) throw runtimeError('HOSTED_AI_UNAVAILABLE');
      let draft = '';
      for await (const event of hostedAi.stream({ task: 'cv', system: prompt.system, messages: [{ role: 'user', content: prompt.user }], webSearch: false })) {
        if (event?.type === 'text' && typeof event.text === 'string') {
          draft += event.text;
          if (Buffer.byteLength(draft, 'utf8') > 50_000) throw runtimeError('COVER_LETTER_DRAFT_INVALID');
        }
      }
      if (!draft.trim()) throw runtimeError('COVER_LETTER_DRAFT_INVALID');
      return draft;
    },
  });

  return Object.freeze({ api, service, store, resolveTarget, ensureSchema: store.ensureSchema });
}
