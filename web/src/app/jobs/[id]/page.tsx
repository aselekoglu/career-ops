"use client";

import { use } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs, refreshJobStatus } = useJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
          <ArrowLeft className="size-4" /> Pipeline
        </Link>
        <p className="mt-8 text-sm text-muted">
          This worker is no longer in memory (it finished earlier or the page was reloaded).
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Pipeline
      </Link>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand" /> working</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> done</>
            ) : (
              <><X className="size-3 text-red-400" /> error</>
            )}
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
          {job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>}
          {job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
            </div>
          )}
        </div>
      </section>

      <ol className="mt-6 space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            {s.kind === "tool" ? (
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" />
            ) : (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
            )}
            <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>
              {s.kind === "tool" ? `Using ${s.label}` : s.label}
            </span>
          </li>
        ))}
        {job.status === "running" && (
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-3.5 animate-spin text-brand" /> thinking…
          </li>
        )}
      </ol>

      {job.backend === "hosted" && job.runId && (job.status === "running" || job.startOutcome === "unknown" || job.errorCode === "CV_WORKER_DISPATCH_FAILED") && (
        <button type="button" onClick={() => refreshJobStatus(job.id)} className="mt-5 rounded-md border border-border px-3 py-2 text-xs text-muted hover:bg-surface-hover">
          Refresh hosted status
        </button>
      )}
      {job.startOutcome === "unknown" && job.kind === "pdf" && (
        <p className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted">
          CV generation may still be running. Check the Pipeline for an existing PDF before starting another run.
          {job.page && <Link href={job.page} className="ml-1 text-brand underline">Open Pipeline</Link>}
        </p>
      )}
      {job.startOutcome === "unknown" && job.kind === "evaluate" && !job.runId && (
        <p className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted">
          Evaluation start could not be confirmed. Resuming this exact target reuses the same durable idempotency key.
        </p>
      )}
      {job.associationWarning && <p className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted">{job.associationWarning}</p>}
      {job.downloadUrl && <a href={job.downloadUrl} className="mt-5 inline-flex rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground">Download tailored PDF</a>}
      {job.reportUrl && <Link href={job.reportUrl} className="mt-5 inline-flex rounded-full bg-brand-soft px-4 py-2 text-sm font-medium text-brand">Open evaluation report and tracker row</Link>}

      {job.text && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Output</h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
