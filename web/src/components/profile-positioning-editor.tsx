"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parse } from "yaml";

type SourceDocument = { source: "profile"; content: string; sha256: string };
type ProfileDiff = { path: string; before: unknown; after: unknown; fields: string[]; sourceAnnotations: Array<{ kind: string; reference: string }> };
type Proposal = {
  proposalId: string;
  status: "preview" | "unchanged";
  baseSha256: string;
  diff: ProfileDiff[];
  applyOperationId: string;
};
type Positioning = { headline: string; superpowers: string[] };

const card = "rounded-2xl border border-border bg-surface/50 p-5";
const input = "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-brand";
const button = "inline-flex items-center justify-center rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNarrative(content: string) {
  const profile = object(parse(content));
  if (!profile) throw new Error("The profile YAML must contain a mapping.");
  const narrative = object(profile.narrative);
  if (profile.narrative !== undefined && !narrative) throw new Error("The profile narrative section must be a mapping.");
  const headline = narrative?.headline;
  const superpowers = narrative?.superpowers;
  if (headline !== undefined && typeof headline !== "string") throw new Error("The profile narrative headline must be text.");
  if (superpowers !== undefined && (!Array.isArray(superpowers) || superpowers.some(item => typeof item !== "string"))) {
    throw new Error("Profile narrative superpowers must be a list of text values.");
  }
  return { headline: headline ?? "", superpowers: (superpowers ?? []) as string[] };
}

async function responseJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error("The profile service returned an unreadable response."); }
  if (!response.ok) {
    const error = object(object(body)?.error);
    const code = typeof error?.code === "string" ? error.code : "";
    if (code === "SOURCE_STALE") throw new Error("The profile changed after it was loaded. Reload it, then preview your changes again.");
    if (code === "INVALID_PROFILE_PATCH") throw new Error("Use a headline up to 500 characters and 1 to 6 non-empty strengths, each up to 200 characters.");
    if (code === "PROFILE_FORMAT_INVALID") throw new Error("The saved profile has an invalid YAML structure and was left unchanged.");
    throw new Error(typeof error?.message === "string" ? error.message : "The profile request failed.");
  }
  return body as T;
}

export function ProfilePositioningEditor() {
  const [headline, setHeadline] = useState("");
  const [superpowersText, setSuperpowersText] = useState("");
  const [original, setOriginal] = useState<Positioning>({ headline: "", superpowers: [] });
  const [sha256, setSha256] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState<"load" | "preview" | "apply" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const previewKey = useRef<{ fingerprint: string; operationId: string } | null>(null);

  const loadProfile = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      const response = await fetch("/api/sources/profile", { cache: "no-store" });
      const source = await responseJson<SourceDocument>(response);
      if (source.source !== "profile" || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("The profile source response is invalid.");
      const narrative = readNarrative(source.content);
      setHeadline(narrative.headline);
      setSuperpowersText(narrative.superpowers.join("\n"));
      setOriginal(narrative);
      setSha256(source.sha256);
      setProposal(null);
      setStatus("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the profile.");
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void loadProfile(); }, [loadProfile]);

  async function preview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sha256) return;
    const superpowers = superpowersText.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    if (!headline.trim() || headline.trim().length > 500 || superpowers.length < 1 || superpowers.length > 6 || superpowers.some(item => item.length > 200)) {
      setError("Use a headline up to 500 characters and 1 to 6 non-empty strengths, each up to 200 characters.");
      return;
    }
    const patch: Record<string, unknown> = {};
    if (headline.trim() !== original.headline) patch.headline = headline.trim();
    if (JSON.stringify(superpowers) !== JSON.stringify(original.superpowers)) patch.superpowers = superpowers;
    if (Object.keys(patch).length === 0) {
      setProposal(null);
      setError("");
      setStatus("There are no changes to preview.");
      return;
    }
    const fingerprint = JSON.stringify({ sha256, patch });
    if (previewKey.current?.fingerprint !== fingerprint) previewKey.current = { fingerprint, operationId: crypto.randomUUID() };
    const sourceAnnotation = { kind: "user_statement", reference: "Entered and reviewed by the user in Profile settings." };
    const sourceAnnotations = Object.fromEntries(Object.keys(patch).map(key => [key, sourceAnnotation]));
    setBusy("preview");
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/sources/profile/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "profile",
          expectedSha256: sha256,
          operationId: previewKey.current.operationId,
          patch,
          sourceAnnotations,
        }),
      });
      const result = await responseJson<Omit<Proposal, "applyOperationId">>(response);
      setProposal({ ...result, applyOperationId: crypto.randomUUID() });
      setStatus(result.status === "unchanged" ? "There are no changes to apply." : "Review this exact diff, then choose Apply reviewed changes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview the profile changes.");
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!proposal || proposal.status !== "preview" || proposal.diff.length === 0) return;
    setBusy("apply");
    setError("");
    try {
      const response = await fetch("/api/sources/profile/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "profile",
          proposalId: proposal.proposalId,
          expectedSha256: proposal.baseSha256,
          operationId: proposal.applyOperationId,
          confirm: true,
        }),
      });
      const result = await responseJson<{ status: "applied" | "unchanged" }>(response);
      if (result.status === "applied") {
        const reread = await loadProfile();
        setStatus(reread ? "Profile positioning saved and re-read from the canonical profile." : "Profile positioning was saved, but the refreshed profile could not be read.");
      } else {
        setStatus("The profile is already current.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply the approved profile proposal.");
    } finally {
      setBusy(null);
    }
  }

  return <section className={`${card} mt-8 space-y-4`} aria-labelledby="profile-positioning-title">
    <div>
      <h2 id="profile-positioning-title" className="text-lg font-semibold">Profile positioning</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">Set a durable headline and strengths list. They guide how future CVs and application writing frame verified experience.</p>
    </div>
    {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
    {status && <p role="status" className="rounded-lg bg-brand-soft p-3 text-sm text-brand-text">{status}</p>}
    <form className="space-y-3" onSubmit={preview}>
      <label className="block space-y-1.5 text-sm">Headline
        <input className={input} value={headline} maxLength={500} onChange={event => { setHeadline(event.target.value); setProposal(null); setStatus(""); }} placeholder="A concise, evidence-backed professional headline" disabled={busy !== null}/>
      </label>
      <label className="block space-y-1.5 text-sm">Strengths <span className="text-muted">(one per line, up to 6)</span>
        <textarea className={input} rows={4} value={superpowersText} maxLength={1200} onChange={event => { setSuperpowersText(event.target.value); setProposal(null); setStatus(""); }} placeholder={"Strength one\nStrength two"} disabled={busy !== null}/>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={button} disabled={busy !== null || !sha256}>{busy === "preview" ? "Creating preview…" : "Preview changes"}</button>
        <button type="button" className="rounded-full border border-border px-4 py-2 text-sm hover:bg-surface-hover disabled:opacity-50 max-sm:min-h-[44px]" onClick={() => void loadProfile()} disabled={busy !== null}>{busy === "load" ? "Reloading…" : "Reload profile"}</button>
      </div>
    </form>
    {proposal && <div className="space-y-3 rounded-xl border border-border bg-background p-4">
      <h3 className="font-medium">Review profile diff</h3>
      {proposal.diff.length ? <ol className="space-y-3">{proposal.diff.map(entry => <li key={entry.path} className="border-t border-border pt-3 text-sm">
        <code className="font-mono text-xs text-muted">{entry.path}</code>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          <div><dt className="text-xs text-muted">Before</dt><dd className="whitespace-pre-wrap">{Array.isArray(entry.before) ? entry.before.join("\n") : String(entry.before ?? "(unset)")}</dd></div>
          <div><dt className="text-xs text-muted">After</dt><dd className="whitespace-pre-wrap">{Array.isArray(entry.after) ? entry.after.join("\n") : String(entry.after ?? "(unset)")}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-faint">Source: {entry.sourceAnnotations.map(annotation => annotation.reference).join(" · ")}</p>
      </li>)}</ol> : <p className="text-sm text-muted">No fields changed.</p>}
      <button type="button" className={button} onClick={() => void apply()} disabled={busy !== null || proposal.status !== "preview" || proposal.diff.length === 0}>{busy === "apply" ? "Applying approved diff…" : "Apply reviewed changes"}</button>
    </div>}
    {busy === "load" && !sha256 && <p className="text-xs text-muted">Loading the current profile…</p>}
  </section>;
}
