"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { cvArtifactApiPath, validateCvArtifactMetadata } from "@/lib/cv-artifact-page.mjs";

type Artifact = { runId: string; byteSize: number; sha256: string; downloadPath: string };

const errors: Record<string, string> = {
  "invalid-id": "This CV run link has an invalid ID.",
  "not-found": "No CV artifact was found for this run.",
  "not-completed": "This CV run has not completed, so there is no downloadable PDF yet.",
  "run-mismatch": "The server returned metadata for a different CV run. No download link was created.",
  "invalid-metadata": "The server returned incomplete or invalid CV artifact metadata. No download link was created.",
  "invalid-download-route": "The server returned an unsafe download route. No download link was created.",
  "unauthorized": "Your authenticated session could not access this CV artifact. Sign in and try again.",
  "request-failed": "CV artifact details could not be loaded. Check your connection and try again.",
};

export default function CvArtifactPage() {
  const params = useParams<{ id: string }>();
  const runId = typeof params?.id === "string" ? params.id : "";
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setArtifact(null);
    setError(null);
    setLoading(true);
    const apiPath = cvArtifactApiPath(runId);
    if (!apiPath) {
      setError("invalid-id");
      setLoading(false);
      return () => { active = false; };
    }
    fetch(apiPath, { method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async response => {
        if (response.status === 401 || response.status === 403) throw new Error("unauthorized");
        if (response.status === 404) throw new Error("not-found");
        if (!response.ok) throw new Error("request-failed");
        let body: unknown;
        try { body = await response.json(); } catch { throw new Error("invalid-metadata"); }
        const checked = validateCvArtifactMetadata(body, runId);
        if (!checked.ok) throw new Error(checked.code);
        if (typeof checked.byteSize !== "number" || typeof checked.sha256 !== "string" || typeof checked.downloadPath !== "string") throw new Error("invalid-metadata");
        if (active) setArtifact({ runId, byteSize: checked.byteSize, sha256: checked.sha256, downloadPath: checked.downloadPath });
      })
      .catch(reason => {
        if (active) setError(reason instanceof Error && errors[reason.message] ? reason.message : "request-failed");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [runId]);

  return (
    <main className="mx-auto min-h-[70vh] w-full max-w-3xl px-6 py-16 md:px-10">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">CV artifact</p>
      <h1 className="mt-3 font-serif text-4xl">Your generated PDF</h1>
      <p className="mt-4 max-w-xl text-sm leading-6 text-[var(--muted)]">This page checks the selected run before offering its PDF. The download starts only when you choose the link below.</p>
      {loading && <p role="status" className="mt-8 text-sm">Checking this CV run…</p>}
      {error && <section role="alert" className="mt-8 rounded-xl border border-red-500/30 bg-red-500/5 p-5">
        <h2 className="font-semibold">Download unavailable</h2>
        <p className="mt-2 text-sm leading-6">{errors[error]}</p>
      </section>}
      {artifact?.runId === runId && <section className="mt-8 rounded-xl border border-[var(--border)] p-5">
        <h2 className="font-semibold">Completed PDF available</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">The metadata is bound to this run. The server validates the PDF when you download it.</p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-[var(--muted)]">Size</dt><dd className="mt-1">{artifact.byteSize.toLocaleString()} bytes</dd></div>
          <div><dt className="text-[var(--muted)]">Expected SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{artifact.sha256}</dd></div>
        </dl>
        <a href={artifact.downloadPath} className="mt-6 inline-flex min-h-11 items-center rounded-full bg-[var(--fg)] px-5 text-sm font-semibold text-[var(--bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          Download this PDF
        </a>
      </section>}
    </main>
  );
}
