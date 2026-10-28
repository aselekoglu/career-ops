const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_NUMBER = /^[1-9]\d{0,7}$/;
const EVAL_STATES = new Set(["queued", "running", "committing", "completed", "failed"]);
const CV_STATES = new Set(["generating", "queued", "running", "completed", "failed"]);
const SAFE_ERRORS = new Set([
  "URL_NOT_IN_INBOX", "APPLICATION_NOT_FOUND", "APPLICATION_REPORT_NOT_FOUND", "CV_NOT_FOUND", "PROFILE_NOT_FOUND",
  "EVALUATION_INPUTS_NOT_IMPORTED", "EVALUATION_WORKER_NOT_CONFIGURED", "EVALUATION_WORKER_DISPATCH_FAILED",
  "GITHUB_ACTIONS_DISABLED", "HOSTED_AI_UNAVAILABLE", "HOSTED_AI_OUTPUT_INCOMPLETE", "EVALUATION_WRITE_CONFLICT",
  "CV_WORKER_NOT_CONFIGURED", "CV_WORKER_DISPATCH_FAILED", "CV_NOT_FOUND", "POSTING_FETCH_FAILED", "POSTING_FETCH_EMPTY",
  "TRACKER_TARGET_NOT_FOUND", "TRACKER_TARGET_REPORT_MISMATCH", "TRACKER_TARGET_ROW_MISMATCH", "TRACKER_TARGETS_INVALID",
  "TRACKER_TARGETS_TOO_LARGE", "TRACKER_TARGET_REPORT_SCAN_TOO_LARGE", "INVALID_JOB_URL", "INVALID_APPLICATION_NUMBER",
  "INVALID_EVALUATION_REQUEST", "INVALID_IDEMPOTENCY_KEY", "BLACKLIST_GATE_BLOCKED", "WORKER_TIMEOUT",
]);
const ERROR_MESSAGES = {
  URL_NOT_IN_INBOX: "This exact posting is not in your Inbox. Add it to the Inbox, then evaluate it.",
  APPLICATION_NOT_FOUND: "That application number was not found.",
  CV_NOT_FOUND: "A source CV is not available for this hosted request.",
  PROFILE_NOT_FOUND: "A candidate profile is not available for this hosted request.",
  EVALUATION_INPUTS_NOT_IMPORTED: "Required Career Ops source documents are not available to the hosted worker.",
  EVALUATION_WORKER_NOT_CONFIGURED: "The hosted evaluation worker is not configured.",
  EVALUATION_WORKER_DISPATCH_FAILED: "The hosted evaluation worker could not be started. You can safely resume this exact target.",
  GITHUB_ACTIONS_DISABLED: "GitHub Actions are disabled for this repository. Check the repository's Actions page and enable workflows if appropriate. Contact GitHub Support only if GitHub directs you to do so.",
  CV_WORKER_NOT_CONFIGURED: "The hosted CV worker is not configured.",
  CV_WORKER_DISPATCH_FAILED: "The hosted CV renderer could not be started.",
  HOSTED_AI_UNAVAILABLE: "Hosted AI is unavailable on this deployment.",
  EVALUATION_WRITE_CONFLICT: "The evaluation could not safely commit because the Inbox or tracker changed.",
  POSTING_FETCH_FAILED: "The posting could not be fetched by the hosted worker.",
  POSTING_FETCH_EMPTY: "The hosted worker could not read job details from this posting.",
  BLACKLIST_GATE_BLOCKED: "This company is on the do-not-apply list and needs review before evaluation.",
  TRACKER_TARGET_NOT_FOUND: "This application has no immutable posting URL binding.",
  TRACKER_TARGET_REPORT_MISMATCH: "The posting URL does not match this application's saved report.",
  TRACKER_TARGET_ROW_MISMATCH: "The saved posting target does not match this tracker row.",
  INVALID_JOB_URL: "Use a valid public posting URL already in the Inbox.",
  INVALID_APPLICATION_NUMBER: "Use a valid application number.",
  WORKER_TIMEOUT: "The hosted worker timed out before completing this run.",
  LINKEDIN_PAGE_UNAVAILABLE: "Career Ops could not read this LinkedIn job page; LinkedIn may require sign-in or block automated access. Try the employer public careers or ATS URL.",
};
const GITHUB_ACTIONS_DISABLED_MESSAGE = "GitHub Actions are disabled for this repository. Check the repository's Actions page and enable workflows if appropriate. Contact GitHub Support only if GitHub directs you to do so.";

export function getExecutionCapabilities(health) {
  if (health?.runtime === "local") return { mode: "local", evaluationsAvailable: false, cvGenerationAvailable: false };
  if (health?.runtime === "vercel") return {
    mode: "hosted",
    evaluationsAvailable: health.evaluations?.available === true,
    cvGenerationAvailable: health.cvGeneration?.available === true,
  };
  return { mode: "unknown", evaluationsAvailable: false, cvGenerationAvailable: false };
}

export function isLocalCliConfigured(configRaw) {
  try { return Boolean(configRaw && JSON.parse(configRaw)?.cliId); }
  catch { return false; }
}

export function getJobAvailability(kind, capabilities, localCliConfigured = false) {
  if (capabilities?.mode === "unknown") return { available: false, reason: "Execution mode is unknown. Refresh to check this deployment." };
  if (capabilities?.mode === "local") return localCliConfigured
    ? { available: true, reason: null }
    : { available: false, reason: "No local CLI is configured. Set one up in Config." };
  if (kind === "evaluate") return capabilities.evaluationsAvailable
    ? { available: true, reason: null }
    : { available: false, reason: "Hosted evaluations are not available on this deployment." };
  if (kind === "pdf") return capabilities.cvGenerationAvailable
    ? { available: true, reason: null }
    : { available: false, reason: "Hosted CV generation is not available on this deployment." };
  const reasons = {
    research: "Research workers require a local CLI and are unavailable in the hosted app.",
    apply: "Application assistance requires a local CLI and is unavailable in the hosted app.",
    "fix-portal": "Portal repair requires local files and is unavailable in the hosted app.",
  };
  return { available: false, reason: reasons[kind] || "This action is not supported in the hosted app." };
}

export function getHostedStartRequest(kind, input, idempotencyKey = undefined) {
  if (!["evaluate", "pdf"].includes(kind)) throw new Error("HOSTED_JOB_UNSUPPORTED");
  if (typeof input !== "string" || !input || input !== input.trim() || input.length > 2048) throw new Error("INVALID_HOSTED_TARGET");
  if (idempotencyKey !== undefined && (kind !== "evaluate" || typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))) throw new Error("INVALID_IDEMPOTENCY_KEY");
  const body = target => ({ ...target, ...(idempotencyKey ? { idempotencyKey } : {}) });
  if (/^https?:\/\//i.test(input)) {
    if (/[\u0000-\u0020\u007f\\]/.test(input)) throw new Error("INVALID_HOSTED_TARGET");
    let url;
    try { url = new URL(input); } catch { throw new Error("INVALID_HOSTED_TARGET"); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("INVALID_HOSTED_TARGET");
    return { path: kind === "evaluate" ? "/api/evaluation-runs" : "/api/cv-runs", body: body({ url: input }) };
  }
  if (APP_NUMBER.test(input)) return {
    path: kind === "evaluate" ? "/api/evaluation-runs" : "/api/cv-runs",
    body: body({ applicationNumber: input }),
  };
  throw new Error("INVALID_HOSTED_TARGET");
}

export async function hostedEvaluationIdempotencyKey(exactTarget) {
  if (typeof exactTarget !== "string" || !exactTarget || !globalThis.crypto?.subtle) throw new Error("IDEMPOTENCY_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(exactTarget));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ui-evaluation:${hex}`;
}

async function boundedJson(response, maxBytes = 16_384) {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { text += decoder.decode(); break; }
      size += value.byteLength;
      if (size > maxBytes) { try { reader.cancel().catch(() => {}); } catch {} return null; }
      text += decoder.decode(value, { stream: true });
    }
  } catch { return null; }
  finally { try { reader.releaseLock(); } catch {} }
  try { return JSON.parse(text); } catch { return null; }
}

function projectRun(raw, kind, expectedRunId = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !RUN_ID.test(raw.runId || "") ||
      expectedRunId && raw.runId !== expectedRunId || !(kind === "evaluate" ? EVAL_STATES : CV_STATES).has(raw.status)) return null;
  const score = typeof raw.score === "number" && Number.isFinite(raw.score) && raw.score >= 1 && raw.score <= 5 ? raw.score : null;
  const applicationNumber = typeof raw.applicationNumber === "string" && APP_NUMBER.test(raw.applicationNumber) ? raw.applicationNumber : null;
  const reportPath = typeof raw.reportPath === "string" && /^reports\/[A-Za-z0-9._-]{1,180}\.md$/.test(raw.reportPath) ? raw.reportPath : null;
  const artifactPath = typeof raw.artifactPath === "string" && /^output\/cv-[A-Za-z0-9._-]{1,220}\.pdf$/.test(raw.artifactPath) ? raw.artifactPath : null;
  const associationStatus = ["linked", "pending", "unlinked"].includes(raw.associationStatus) ? raw.associationStatus : null;
  const errorCode = typeof raw.errorCode === "string" && SAFE_ERRORS.has(raw.errorCode) ? raw.errorCode : null;
  const diagnosticCode = errorCode === "EVALUATION_WORKER_DISPATCH_FAILED" && raw.diagnosticCode === "GITHUB_ACTIONS_DISABLED"
    ? "GITHUB_ACTIONS_DISABLED" : null;
  return {
    runId: raw.runId, status: raw.status,
    company: typeof raw.company === "string" ? raw.company.slice(0, 300) : null,
    role: typeof raw.role === "string" ? raw.role.slice(0, 300) : null,
    applicationNumber, reportPath, score, artifactPath, associationStatus,
    associationPending: raw.associationPending === true || associationStatus === "pending", errorCode, diagnosticCode,
  };
}

export function safeHostedRunError(code, kind, diagnosticCode = null) {
  if (code === "EVALUATION_WORKER_DISPATCH_FAILED" && diagnosticCode === "GITHUB_ACTIONS_DISABLED") return GITHUB_ACTIONS_DISABLED_MESSAGE;
  if (typeof code === "string" && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return kind === "pdf" ? "The hosted CV run failed. No CV or profile data was saved in the browser." : "The hosted evaluation failed.";
}

export async function importJobForHostedEvaluation(url, fetchFn = fetch) {
  let response;
  try {
    response = await fetchFn("/api/job-import", {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, source: "Quick Evaluate" }),
    });
  } catch {
    return { outcome: "unknown", message: "The posting import could not be confirmed. Check the Inbox before trying again." };
  }
  const raw = await boundedJson(response);
  if (!response.ok || !raw || !["imported", "already_exists"].includes(raw.status) || typeof raw.normalizedUrl !== "string") {
    const code = raw?.error?.code;
    return { outcome: "rejected", message: safeHostedRunError(SAFE_ERRORS.has(code) || code === "LINKEDIN_PAGE_UNAVAILABLE" ? code : null, "evaluate") };
  }
  if (raw.status === "already_exists" && typeof raw.applicationNumber === "string" && APP_NUMBER.test(raw.applicationNumber)) {
    return { outcome: "existing", applicationNumber: raw.applicationNumber, normalizedUrl: raw.normalizedUrl,
      message: `This posting already has application #${raw.applicationNumber}. No new evaluation was started.` };
  }
  let normalized;
  try { normalized = new URL(raw.normalizedUrl); } catch { return { outcome: "rejected", message: "The import service returned an invalid Inbox URL." }; }
  if (!/^https?:$/.test(normalized.protocol) || normalized.username || normalized.password || raw.normalizedUrl.length > 2048) {
    return { outcome: "rejected", message: "The import service returned an invalid Inbox URL." };
  }
  return { outcome: "imported", normalizedUrl: raw.normalizedUrl, company: typeof raw.company === "string" ? raw.company.slice(0, 300) : null, role: typeof raw.role === "string" ? raw.role.slice(0, 300) : null };
}

/** @param {"evaluate"|"pdf"} kind @param {string} input @param {typeof fetch} fetchFn @param {{importFirst?: boolean, idempotencyKey?: string, onTarget?: (target: string, key?: string) => void}} options */
export async function startHostedRun(kind, input, fetchFn = fetch, { importFirst = false, idempotencyKey, onTarget } = {}) {
  if (kind === "evaluate" && importFirst) {
    const imported = await importJobForHostedEvaluation(input, fetchFn);
    if (imported.outcome !== "imported") return { outcome: imported.outcome, runId: null, applicationNumber: imported.applicationNumber, targetInput: imported.normalizedUrl || input, message: imported.message };
    input = imported.normalizedUrl;
  }
  if (kind === "evaluate" && !idempotencyKey) {
    try { idempotencyKey = await hostedEvaluationIdempotencyKey(input); }
    catch { return { outcome: "rejected", runId: null, targetInput: input, message: "A stable retry key could not be created, so the hosted evaluation was not started." }; }
  }
  if (onTarget?.(input, idempotencyKey) === false) {
    return { outcome: "rejected", runId: null, targetInput: input, message: "Browser storage could not save the hosted run safety marker, so the request was not started." };
  }
  let request;
  try { request = getHostedStartRequest(kind, input, idempotencyKey); }
  catch (error) { return { outcome: "rejected", runId: null, targetInput: input, message: error.message === "HOSTED_JOB_UNSUPPORTED" ? getJobAvailability(kind, { mode: "hosted" }).reason : "This hosted action needs an exact Inbox URL or a valid application number." }; }
  let response;
  try {
    response = await fetchFn(request.path, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
  } catch {
    return { outcome: "unknown", runId: null, targetInput: input, message: kind === "pdf"
      ? "We could not confirm whether CV generation started. It may still be running; do not retry until you check your hosted CV artifacts."
      : "We could not confirm whether evaluation started. It may still be running; retrying this exact target will reuse its durable run." };
  }
  const raw = await boundedJson(response);
  const run = projectRun(raw, kind);
  if (!run) {
    if (!response.ok) {
      const code = raw?.code ?? raw?.errorCode;
      if (response.status >= 500 || !SAFE_ERRORS.has(code)) return { outcome: "unknown", runId: null, targetInput: input, message: kind === "pdf"
        ? "We could not confirm whether CV generation started. It may still be running; check your hosted CV artifacts before trying again."
        : "We could not confirm whether evaluation started. It may still be running; retrying this exact target will reuse its durable run." };
      return { outcome: "rejected", runId: null, targetInput: input, message: safeHostedRunError(code, kind) };
    }
    return { outcome: "unknown", runId: null, targetInput: input, message: "The server response did not include a valid run ID. Check this action's status before starting another." };
  }
  if (run.status === "failed") return { outcome: "failed", run, runId: run.runId, targetInput: input, message: safeHostedRunError(run.errorCode, kind, run.diagnosticCode) };
  return { outcome: "started", run, runId: run.runId, targetInput: input };
}

export async function pollHostedRun(kind, runId, fetchFn = fetch) {
  if (!RUN_ID.test(String(runId || ""))) return { outcome: "rejected", run: null, message: "The hosted run ID is invalid." };
  const path = `${kind === "pdf" ? "/api/cv-runs/" : "/api/evaluation-runs/"}${runId}`;
  let response;
  try { response = await fetchFn(path, { method: "GET", cache: "no-store" }); }
  catch { return { outcome: "running", run: null, message: "Checking the hosted worker status…" }; }
  const raw = await boundedJson(response);
  const run = projectRun(raw, kind, runId);
  if (!response.ok || !run) return { outcome: "running", run: null, message: "Checking the hosted worker status…" };
  if (run.status === "failed") return { outcome: "failed", run, message: safeHostedRunError(run.errorCode, kind, run.diagnosticCode) };
  if (run.status === "completed") {
    if (kind === "evaluate" && (!run.applicationNumber || run.score == null || !run.reportPath)) {
      return { outcome: "unverified", run, message: "The server marked evaluation complete but did not return a verified application number, score, and report path." };
    }
    if (kind === "pdf" && (!run.artifactPath || !cvArtifactDownloadPath(run.runId) || !run.associationStatus)) {
      return { outcome: "unverified", run, message: "The server marked CV generation complete but the PDF artifact could not be verified." };
    }
    return { outcome: "completed", run, ...(kind === "pdf" && run.associationPending ? { message: "PDF generated and ready to download, but its tracker association is still pending." } : {}) };
  }
  return { outcome: "running", run };
}

export function cvArtifactDownloadPath(runId) {
  return RUN_ID.test(String(runId || "")) ? `/api/cv-artifacts/${runId}/download` : null;
}

/** Synchronously claim one in-flight UI start for a target before any state enqueue or await. */
export function reserveHostedStart(reservations, targetKey, jobId) {
  const existing = reservations.get(targetKey);
  if (existing) return { id: existing, created: false };
  reservations.set(targetKey, jobId);
  return { id: jobId, created: true };
}

export function releaseHostedStart(reservations, targetKey, jobId) {
  if (reservations.get(targetKey) === jobId) reservations.delete(targetKey);
}

const PERSISTED_JOB_FIELDS = ["id", "title", "subtitle", "page", "input", "kind", "backend", "runId", "errorCode", "startOutcome", "requestInput", "idempotencyKey", "reportUrl", "downloadUrl", "associationWarning", "batchId", "status", "steps", "text", "result", "cost", "startedAt", "endedAt"];

export function projectPersistedJob(job) {
  if (!job || typeof job !== "object") return null;
  const projected = Object.fromEntries(PERSISTED_JOB_FIELDS.filter((key) => key in job).map((key) => [key, job[key]]));
  if (job.backend === "hosted") {
    projected.text = "";
    delete projected.cost;
  }
  return projected;
}

/** Persist a bounded, privacy-projected job snapshot synchronously before hosted dispatch. */
export function persistJobsSnapshot(storage, key, jobs) {
  try {
    const safetyMarkers = jobs.filter((job) => job?.backend === "hosted" && (
      job.status === "running" || job.startOutcome === "unknown" || job.kind === "pdf" && job.errorCode === "CV_WORKER_DISPATCH_FAILED"
    ));
    if (safetyMarkers.length > 40) return false;
    const safeJobs = [...safetyMarkers, ...jobs.filter((job) => !safetyMarkers.includes(job)).slice(0, 40 - safetyMarkers.length)].map(projectPersistedJob);
    storage.setItem(key, JSON.stringify(safeJobs));
    return true;
  } catch {
    return false;
  }
}

/** Persist a new hosted marker and relinquish its reservation if storage is unavailable. */
export function persistHostedJobSnapshot(storage, key, jobs, reservations, targetKey, jobId) {
  let persisted = false;
  try {
    const resolvedStorage = typeof storage === "function" ? storage() : storage;
    persisted = persistJobsSnapshot(resolvedStorage, key, jobs);
  } catch { /* blocked storage accessor */ }
  if (!persisted) releaseHostedStart(reservations, targetKey, jobId);
  return persisted;
}

export function restorePersistedJobs(value, now = Date.now()) {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((job) => job && typeof job === "object").map((job) => {
    const safe = projectPersistedJob(job);
    if (safe.backend === "hosted") {
      if (safe.status === "running" && safe.runId) return safe;
      if (safe.status === "running") return {
        ...safe, status: "error", startOutcome: "unknown", endedAt: now,
        steps: [...(Array.isArray(safe.steps) ? safe.steps : []), { kind: "status", label: safe.kind === "pdf"
          ? "CV start outcome unknown — check existing artifacts before trying again"
          : "Evaluation start outcome unknown — resume uses the same durable target", ts: now }],
      };
      return safe;
    }
    return safe.status === "running" ? {
      ...safe, status: "error", endedAt: now,
      steps: [...(Array.isArray(safe.steps) ? safe.steps : []), { kind: "status", label: "Interrupted (page reloaded)", ts: now }],
    } : safe;
  });
}
