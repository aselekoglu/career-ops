"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";
import { cvArtifactDownloadPath, getExecutionCapabilities, getJobAvailability, isLocalCliConfigured, persistHostedJobSnapshot, persistJobsSnapshot, pollHostedRun, projectPersistedJob, releaseHostedStart, reserveHostedStart, restorePersistedJobs, safeHostedRunError, startHostedRun } from "@/lib/job-execution.mjs";

export type JobStep = { kind: "tool" | "status"; label: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };
export type JobExecution = ReturnType<typeof getExecutionCapabilities> & { loading: boolean; localCliConfigured: boolean };

export type Job = {
  id: string;
  title: string;
  subtitle?: string;
  page?: string; // route the job was launched from / refers to
  input?: string; // the URL/posting it processed (links inbox rows to their worker)
  kind?: string;
  backend?: "local" | "hosted";
  runId?: string;
  errorCode?: string;
  startOutcome?: "unknown" | "rejected";
  requestInput?: string;
  idempotencyKey?: string;
  reportUrl?: string;
  downloadUrl?: string;
  associationWarning?: string;
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  status: "running" | "done" | "error";
  steps: JobStep[];
  text: string;
  result?: JobResult;
  cost?: { tokens: number; usd?: number }; // per-run token cost (Claude result event) — local only
  startedAt: number;
  endedAt?: number;
};

export function isHostedCvRetryBlocked(job: Job) {
  return job.backend === "hosted" && job.kind === "pdf" && (job.startOutcome === "unknown" || job.errorCode === "CV_WORKER_DISPATCH_FAILED");
}

export function isHostedJobOutcomeUnknown(job: Job) {
  return job.backend === "hosted" && job.startOutcome === "unknown";
}

export function isJobClearable(job: Job) {
  return job.status !== "running" && !isHostedJobOutcomeUnknown(job) && !isHostedCvRetryBlocked(job);
}

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string; importFirst?: boolean };

type Ctx = {
  jobs: Job[];
  jobsReady: boolean;
  execution: JobExecution;
  startJob: (opts: StartOpts) => string | null;
  refreshJobStatus: (id: string) => void;
  removeJob: (id: string) => void;
  clearFinished: () => void;
};

const JobsContext = createContext<Ctx | null>(null);
export function useJobs() {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs must be used within <JobsProvider>");
  return c;
}

const CONFIG_KEY = "career-ops:config";
const JOBS_KEY = "career-ops:jobs";

function parseVerdict(text: string): JobResult {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

export function JobsProvider({ children, cloudRuntime = false }: { children: React.ReactNode; cloudRuntime?: boolean }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [execution, setExecution] = useState<JobExecution>({ ...getExecutionCapabilities({ runtime: cloudRuntime ? "vercel" : "local" }), loading: cloudRuntime, localCliConfigured: false });
  const seq = useRef(0);
  const [hydrated, setHydrated] = useState(false);
  const jobsRef = useRef<Job[]>([]);
  const executionRef = useRef(execution);
  const pollingRunIds = useRef(new Set<string>());
  const startReservations = useRef(new Map<string, string>());
  const capabilitiesRequest = useRef<Promise<JobExecution> | null>(null);
  executionRef.current = execution;

  const updateJobs = useCallback((update: (current: Job[]) => Job[]) => {
    const next = update(jobsRef.current);
    jobsRef.current = next;
    setJobs(next);
  }, []);

  const persistJobsNow = useCallback(() => {
    try { return typeof window !== "undefined" && persistJobsSnapshot(window.localStorage, JOBS_KEY, jobsRef.current); }
    catch { return false; }
  }, []);

  const loadExecution = useCallback((): Promise<JobExecution> => {
    if (!cloudRuntime) {
      const current = { ...getExecutionCapabilities({ runtime: "local" }), loading: false, localCliConfigured: executionRef.current.localCliConfigured };
      executionRef.current = current;
      setExecution(current);
      return Promise.resolve(current);
    }
    if (!executionRef.current.loading && executionRef.current.mode !== "unknown") return Promise.resolve(executionRef.current);
    if (capabilitiesRequest.current) return capabilitiesRequest.current;
    const request = fetch("/api/health", { cache: "no-store" }).then(async (response) => {
      const health = response.ok ? await response.json() : null;
      const resolved = getExecutionCapabilities(health);
      return { ...(cloudRuntime && resolved.mode !== "hosted" ? getExecutionCapabilities({ runtime: "vercel" }) : resolved), loading: false, localCliConfigured: false };
    }).catch(() => ({ ...getExecutionCapabilities({ runtime: "vercel" }), loading: false, localCliConfigured: false })).then((next) => {
      executionRef.current = next;
      setExecution(next);
      return next;
    }).finally(() => { capabilitiesRequest.current = null; });
    capabilitiesRequest.current = request;
    return request;
  }, [cloudRuntime]);

  useEffect(() => {
    const readCli = () => {
      try { return isLocalCliConfigured(localStorage.getItem(CONFIG_KEY)); }
      catch { return false; }
    };
    if (!cloudRuntime) {
      const refreshLocalCli = () => {
        const next = { ...getExecutionCapabilities({ runtime: "local" }), loading: false, localCliConfigured: readCli() };
        executionRef.current = next;
        setExecution(next);
      };
      refreshLocalCli();
      window.addEventListener("storage", refreshLocalCli);
      window.addEventListener("co-config-updated", refreshLocalCli);
      return () => {
        window.removeEventListener("storage", refreshLocalCli);
        window.removeEventListener("co-config-updated", refreshLocalCli);
      };
    }
    void loadExecution();
  }, [cloudRuntime, loadExecution]);

  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const restored = restorePersistedJobs(raw, Date.now()) as Job[];
      setJobs(restored);
      jobsRef.current = restored;
    } catch {
      /* ignore */
    } finally {
      setHydrated(true);
    }
  }, []);

  // persist
  useEffect(() => {
    if (!hydrated) return;
    try {
      const safeJobs = jobs.slice(0, 40).map(projectPersistedJob);
      localStorage.setItem(JOBS_KEY, JSON.stringify(safeJobs));
    } catch {
      /* quota */
    }
  }, [jobs, hydrated]);

  const patch = useCallback((id: string, fn: (j: Job) => Job) => {
    updateJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, [updateJobs]);

  useEffect(() => {
    for (const job of jobs) {
      if (job.backend !== "hosted" || job.status !== "running" || !job.runId || !["evaluate", "pdf"].includes(job.kind || "") || pollingRunIds.current.has(job.runId)) continue;
      pollingRunIds.current.add(job.runId);
      void (async () => {
        let previousStatus = "";
        const startedAt = Date.now();
        try {
          while (Date.now() - startedAt < 46 * 60 * 1000) {
            const state = await pollHostedRun(job.kind as "evaluate" | "pdf", job.runId!);
            if (state.run && state.run.status !== previousStatus) {
              previousStatus = state.run.status;
              const label = state.run.status === "queued" ? "Queued · waiting for hosted worker"
                : state.run.status === "generating" ? "Generating tailored CV"
                  : state.run.status === "committing" ? "Saving evaluation report"
                    : state.run.status === "running" ? job.kind === "pdf" ? "Rendering tailored CV" : "Evaluating the posting"
                      : "Checking hosted worker";
              patch(job.id, (current) => ({ ...current, steps: [...current.steps, { kind: "status", label, ts: Date.now() }] }));
            }
            if (state.outcome === "completed" && state.run) {
              const run = state.run;
              patch(job.id, (current) => ({
                ...current, status: "done", text: "", cost: undefined, endedAt: Date.now(),
                result: job.kind === "evaluate" ? {
                  score: run.score, tone: run.score == null ? "muted" : scoreTone(String(run.score)),
                  summary: run.applicationNumber ? `Application #${run.applicationNumber} · report saved` : "Report saved",
                } : { score: null, tone: "muted", summary: state.message ? "PDF generated · tracker association pending" : "PDF generated" },
                reportUrl: job.kind === "evaluate" && run.applicationNumber ? `/pipeline/${encodeURIComponent(run.applicationNumber)}` : undefined,
                downloadUrl: job.kind === "pdf" ? cvArtifactDownloadPath(run.runId) || undefined : undefined,
                associationWarning: job.kind === "pdf" ? state.message : undefined,
                steps: [...current.steps, { kind: "status", label: "Completed · result saved", ts: Date.now() }],
              }));
              if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: job.kind, input: job.input } }));
              return;
            }
            if (state.outcome === "unverified") {
              patch(job.id, (current) => ({
                ...current, status: "error", text: "", cost: undefined, endedAt: Date.now(), startOutcome: "unknown",
                downloadUrl: job.kind === "pdf" && state.run ? cvArtifactDownloadPath(state.run.runId) || undefined : current.downloadUrl,
                steps: [...current.steps, { kind: "status", label: state.message || "The hosted result could not be verified.", ts: Date.now() }],
              }));
              return;
            }
            if (state.outcome === "failed") {
              patch(job.id, (current) => ({
                ...current, status: "error", text: "", cost: undefined, endedAt: Date.now(), startOutcome: undefined,
                steps: [...current.steps, { kind: "status", label: state.message || safeHostedRunError(state.run?.errorCode, job.kind), ts: Date.now() }],
              }));
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 2500));
          }
          patch(job.id, (current) => ({ ...current, steps: [...current.steps, { kind: "status", label: "Status checks paused. Refresh status or reopen this job to continue polling.", ts: Date.now() }] }));
        } finally {
          pollingRunIds.current.delete(job.runId!);
        }
      })();
    }
  }, [jobs, patch]);

  const runHostedStart = useCallback(async (id: string, opts: StartOpts, idempotencyKey?: string) => {
    const capabilities = executionRef.current.loading ? await loadExecution() : executionRef.current;
    const availability = getJobAvailability(opts.kind, capabilities, false);
    if (!availability.available || !["evaluate", "pdf"].includes(opts.kind)) {
      patch(id, (current) => ({ ...current, status: "error", endedAt: Date.now(), startOutcome: "rejected", steps: [...current.steps, { kind: "status", label: availability.reason || "This hosted action is unavailable.", ts: Date.now() }] }));
      return;
    }
    const result = await startHostedRun(opts.kind as "evaluate" | "pdf", opts.input, fetch, {
      importFirst: opts.importFirst === true,
      idempotencyKey,
      onTarget: (target, key) => {
        patch(id, (current) => ({ ...current, input: target, idempotencyKey: key || current.idempotencyKey }));
        return persistJobsNow();
      },
    });
    if (result.outcome === "existing" && result.applicationNumber) {
      patch(id, (current) => ({
        ...current, input: result.targetInput || current.input, status: "done", endedAt: Date.now(),
        result: { score: null, tone: "muted", summary: `Already evaluated · Application #${result.applicationNumber}` },
        reportUrl: `/pipeline/${encodeURIComponent(result.applicationNumber)}`,
        steps: [...current.steps, { kind: "status", label: result.message || "Existing evaluation found.", ts: Date.now() }],
      }));
      return;
    }
    patch(id, (current) => ({
      ...current, input: result.targetInput || current.input, requestInput: current.requestInput || opts.input,
      runId: result.runId || undefined, errorCode: result.run?.errorCode || undefined,
      status: result.outcome === "started" ? "running" : "error",
      endedAt: result.outcome === "started" ? undefined : Date.now(),
      startOutcome: result.outcome === "unknown" ? "unknown" : result.outcome === "rejected" ? "rejected" : undefined,
      steps: [...current.steps, { kind: "status", label: result.outcome === "started"
        ? result.run?.status === "queued" ? "Queued · waiting for hosted worker" : "Hosted run started"
        : result.message || "The hosted action could not be started.", ts: Date.now() }],
    }));
  }, [loadExecution, patch, persistJobsNow]);

  const startJob = useCallback(
    (opts: StartOpts): string | null => {
      if (cloudRuntime) {
        const reservationKey = `${opts.kind}:${opts.input}`;
        const reserved = startReservations.current.get(reservationKey);
        if (reserved) return reserved;
        const previous = jobsRef.current.find((job) => job.backend === "hosted" && job.kind === opts.kind && (job.requestInput === opts.input || job.input === opts.input));
        if (previous) {
          const resumeEvaluation = opts.kind === "evaluate" && (
            Boolean(previous.idempotencyKey) && (previous.startOutcome === "unknown" || previous.errorCode === "EVALUATION_WORKER_DISPATCH_FAILED") ||
            Boolean(opts.importFirst) && previous.startOutcome === "unknown" && !previous.idempotencyKey
          );
          if (resumeEvaluation) {
            const reservation = reserveHostedStart(startReservations.current, reservationKey, previous.id);
            if (reservation.created) void runHostedStart(previous.id, opts, previous.idempotencyKey).finally(() => releaseHostedStart(startReservations.current, reservationKey, previous.id));
            return previous.id;
          }
          if (previous.status === "running" || previous.startOutcome === "unknown" || opts.kind === "pdf" && previous.errorCode === "CV_WORKER_DISPATCH_FAILED") return previous.id;
        }
        const id = `job-${Date.now()}-${seq.current++}`;
        const reservation = reserveHostedStart(startReservations.current, reservationKey, id);
        if (!reservation.created) return reservation.id;
        const hostedJob: Job = {
          id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, requestInput: opts.input,
          kind: opts.kind, batchId: opts.batchId,
          backend: "hosted", status: "running", steps: [{ kind: "status", label: "Checking hosted worker…", ts: Date.now() }],
          text: "", startedAt: Date.now(),
        };
        updateJobs((current) => [hostedJob, ...current]);
        if (!persistHostedJobSnapshot(() => window.localStorage, JOBS_KEY, jobsRef.current, startReservations.current, reservationKey, id)) {
          patch(id, (current) => ({ ...current, status: "error", endedAt: Date.now(), startOutcome: "rejected", steps: [...current.steps, { kind: "status", label: "Browser storage is unavailable. The hosted request was not started.", ts: Date.now() }] }));
          return id;
        }
        void runHostedStart(id, opts).finally(() => releaseHostedStart(startReservations.current, reservationKey, id));
        return id;
      }

      let cliId: string | null = null;
      try {
        const raw = localStorage.getItem(CONFIG_KEY);
        cliId = raw ? JSON.parse(raw).cliId || null : null;
      } catch {
        cliId = null;
      }
      const id = `job-${Date.now()}-${seq.current++}`;
      const job: Job = {
        id,
        title: opts.title,
        subtitle: opts.subtitle,
        page: opts.page,
        input: opts.input,
        kind: opts.kind,
        backend: "local",
        batchId: opts.batchId,
        status: "running",
        steps: [{ kind: "status", label: "Starting…", ts: Date.now() }],
        text: "",
        startedAt: Date.now(),
      };
      updateJobs((js) => [job, ...js]);

      if (!cliId) {
        patch(id, (j) => ({ ...j, status: "error", endedAt: Date.now(), steps: [...j.steps, { kind: "status", label: "No CLI configured — open Config", ts: Date.now() }] }));
        return id;
      }

      (async () => {
        let text = "";
        let verdictLine = ""; // latched separately so the 8000-char tail can't drop it
        let doneTokens = 0; // per-run token cost, forwarded on the done event (#6)
        let doneCostUsd: number | null = null;
        const steps: JobStep[] = [];
        const finish = (status: "done" | "error", lastLabel?: string) => {
          const result = status === "done" ? parseVerdict(verdictLine || text) : undefined;
          const cost = status === "done" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
          patch(id, (j) => ({
            ...j,
            status,
            result,
            cost,
            endedAt: Date.now(),
            steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps,
          }));
          // persist a readable log file so the CLI/assistant can read past runs
          if (status === "done") {
            fetch("/api/runs/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, result, cost, steps, output: text }),
            }).catch(() => {});
            // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
            // worker just wrote a real tracker row / report they don't yet see.
            if (typeof window !== "undefined" && (opts.kind === "evaluate" || opts.kind === "pdf")) {
              window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
            }
          }
        };

        try {
          const res = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId }),
          });
          if (!res.ok || !res.body) {
            const e = await res.json().catch(() => ({}));
            finish("error", e.error || "Failed to start");
            return;
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                if (ev.type === "tool") {
                  steps.push({ kind: "tool", label: ev.name, ts: Date.now() });
                  patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "tool", label: ev.name, ts: Date.now() }] }));
                } else if (ev.type === "status") {
                  steps.push({ kind: "status", label: ev.label, ts: Date.now() });
                  patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: ev.label, ts: Date.now() }] }));
                } else if (ev.type === "text") {
                  const full = text + ev.text;
                  const vm = full.match(/VERDICT:[^\n]*/i);
                  if (vm) verdictLine = vm[0];
                  text = full.slice(-8000);
                  patch(id, (j) => ({ ...j, text }));
                } else if (ev.type === "done") {
                  // finish happens on stream-close; capture the per-run cost it carries
                  if (typeof ev.tokens === "number") doneTokens = ev.tokens;
                  if (typeof ev.costUsd === "number") doneCostUsd = ev.costUsd;
                } else if (ev.type === "error") {
                  finish("error", ev.msg || "Error");
                  return;
                }
              } catch {
                /* skip */
              }
            }
          }
          finish("done", "Done");
        } catch {
          finish("error", "Connection error");
        }
      })();

      return id;
    },
    [cloudRuntime, patch, persistJobsNow, runHostedStart, updateJobs],
  );

  const removeJob = useCallback((id: string) => updateJobs((js) => js.filter((j) => j.id !== id || !isJobClearable(j))), [updateJobs]);
  const clearFinished = useCallback(() => updateJobs((js) => js.filter((j) => !isJobClearable(j))), [updateJobs]);
  const refreshJobStatus = useCallback((id: string) => patch(id, (job) => job.backend === "hosted" && job.runId && (job.status === "running" || job.startOutcome === "unknown" || job.errorCode === "CV_WORKER_DISPATCH_FAILED")
    ? { ...job, status: "running", steps: [...job.steps, { kind: "status", label: "Refreshing hosted worker status…", ts: Date.now() }] }
    : job), [patch]);

  return <JobsContext.Provider value={{ jobs, jobsReady: hydrated, execution, startJob, refreshJobStatus, removeJob, clearFinished }}>{children}</JobsContext.Provider>;
}
