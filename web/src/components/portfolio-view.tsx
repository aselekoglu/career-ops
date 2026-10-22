"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Archive, ArrowDownToLine, Check, ChevronDown, CircleAlert, Clock3, FilePlus2,
  FolderArchive, Link2, LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw,
  RotateCcw, Save, Sparkles, Trash2, UploadCloud, X,
} from "lucide-react";
import { normalizePortfolioDocument, renderPortfolioDocument } from "@/lib/portfolio-document.mjs";
import type { PortfolioDocument } from "@/lib/portfolio-document.mjs";
import { createPortfolioOperationKeys, portfolioRequest, portfolioRunMode } from "@/lib/portfolio-client.mjs";

type Project = { id: string; name: string; summary: string; url: string; tags: string[]; revision?: number; archivedAt?: string | null; usageCount?: number };
type Version = { version: number; bytes: number; sha256: string; createdAt: string; hasEditableContent?: boolean };
type Portfolio = {
  id: string; title: string; kind: "master" | "variant"; tags: string[]; projectIds: string[];
  versions: Version[]; latestVersion: number | null; revision?: number; archivedAt?: string | null;
  associationCount?: number; usageCount?: number; capabilities?: { generate?: boolean; render?: boolean };
  runs?: RunSummary[];
};
type Association = { applicationNumber: string; portfolioId: string; version: number };
type RunStatus = "queued" | "running" | "awaiting_review" | "completed" | "failed" | "canceled";
type RunSummary = { runId: string; id?: string; operationId?: string; mode?: "generate" | "edit"; phase: "draft" | "render"; status: RunStatus; title?: string; portfolioId?: string | null; version?: number | null; error?: string; errorCode?: string | null; updatedAt?: string; requestedAt?: string | null; createdAt?: string };
type ClaimChoice = "confirm" | "correct" | "narrative-only" | "do-not-know";
type Claim = { id: string; text: string; provenance?: string; outcome?: ClaimChoice | "user-cannot-confirm"; correctedText?: string };
type PortfolioRun = Omit<RunSummary, "runId"> & {
  runId: string;
  draftSha256?: string; document?: PortfolioDocument | null; format?: "letter" | "a4";
  title?: string; tags?: string[]; projectIds?: string[]; expectedRevision?: number;
  factsReview?: { claims: Claim[]; previewId?: string; profileSha256?: string; profileProposalId?: string; sourceDiff?: unknown; status?: string };
  sourceReview?: { claims: Claim[]; factsReview?: PortfolioRun["factsReview"]; previewId?: string; profileSha256?: string; profileProposalId?: string; sourceDiff?: unknown; status?: string };
};
type Library = { portfolios: Portfolio[]; projects: Project[]; associations: Association[]; runs?: RunSummary[] };
type Recommendation = { portfolioId: string; matchedTerms: string[]; score: number };
type DestructiveAction = { kind: "archive" | "purge" | "archive-project" | "purge-project"; id: string; title: string; revision: number; references: number; activeRuns?: number };

const emptyLibrary: Library = { portfolios: [], projects: [], associations: [], runs: [] };
const words = (value: string) => [...new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean))];
const activeStatuses = new Set<RunStatus>(["queued", "running", "awaiting_review"]);
const runIdOf = (run: RunSummary) => run.runId || run.id || "";
const runMode = (run: RunSummary) => run.mode || "generate";
const sourceReviewOf = (run: PortfolioRun | null) => {
  const review = run?.sourceReview;
  return review ? { ...review, ...(review.factsReview || {}) } : run?.factsReview;
};
const statusLabel = (status: RunStatus) => status.replaceAll("_", " ");
const input = "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
const card = "rounded-2xl border border-border bg-surface p-5 shadow-sm";
const primary = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50";
const secondary = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50";

function asError(error: unknown) { return error instanceof Error ? error.message : "Request failed. Retry the operation."; }
function json(body: unknown): RequestInit { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
function revisionOf(item: { revision?: number }) { return Number.isInteger(item.revision) && item.revision! > 0 ? item.revision! : 1; }
function createBlankDocument(name: string): PortfolioDocument {
  return normalizePortfolioDocument({ schemaVersion: "careerops.portfolio.document@1", name, headline: "", summary: "", highlights: [], projects: [], skills: [], links: [], theme: "classic" });
}
function draftKey(document: PortfolioDocument, title: string, tags: string[], projects: string[], format: "letter" | "a4") {
  return JSON.stringify({ document, title, tags, projectIds: projects, format });
}

export function PortfolioView() {
  const operationKeys = useRef(createPortfolioOperationKeys());
  const [catalog, setCatalog] = useState<Library>(emptyLibrary);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, number>>({});
  const [appNumber, setAppNumber] = useState("");
  const [matchedRole, setMatchedRole] = useState("");
  const [title, setTitle] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTargetId, setUploadTargetId] = useState("");
  const [kind, setKind] = useState<"master" | "variant">("master");
  const [tags, setTags] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [sourceMode, setSourceMode] = useState<"profile" | "portfolio">("profile");
  const [basePortfolioId, setBasePortfolioId] = useState("");
  const [baseVersion, setBaseVersion] = useState<number | "">("");
  const [applicationNumber, setApplicationNumber] = useState("");
  const [format, setFormat] = useState<"letter" | "a4">("letter");
  const [activeRun, setActiveRun] = useState<PortfolioRun | null>(null);
  const [editorDocument, setEditorDocument] = useState<PortfolioDocument | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorTags, setEditorTags] = useState("");
  const [editorProjectIds, setEditorProjectIds] = useState<string[]>([]);
  const [savedDraftKey, setSavedDraftKey] = useState("");
  const [metadataTarget, setMetadataTarget] = useState<Portfolio | null>(null);
  const [metadataTitle, setMetadataTitle] = useState("");
  const [metadataTags, setMetadataTags] = useState("");
  const [metadataKind, setMetadataKind] = useState<"master" | "variant">("master");
  const [metadataProjects, setMetadataProjects] = useState<string[]>([]);
  const [projectTarget, setProjectTarget] = useState<Project | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectSummary, setProjectSummary] = useState("");
  const [projectUrl, setProjectUrl] = useState("");
  const [projectTags, setProjectTags] = useState("");
  const [destructive, setDestructive] = useState<DestructiveAction | null>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [detachAssociations, setDetachAssociations] = useState(false);
  const [claimChoices, setClaimChoices] = useState<Record<string, ClaimChoice>>({});
  const [claimCorrections, setClaimCorrections] = useState<Record<string, string>>({});

  const refresh = useCallback(async (includeArchived = showArchived) => {
    const query = includeArchived ? "?includeArchived=1" : "";
    const library = await portfolioRequest<Library>(`/api/portfolio${query}`);
    setCatalog({ ...emptyLibrary, ...library, portfolios: library.portfolios || [], projects: library.projects || [], associations: library.associations || [], runs: library.runs || [] });
    setLoading(false);
    return library;
  }, [showArchived]);

  const withBusy = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError(""); setSuccess("");
    try { await action(); }
    catch (caught) { setError(asError(caught)); }
    finally { setBusy(""); }
  }, []);

  useEffect(() => {
    let alive = true;
    void refresh().catch((caught) => { if (alive) { setLoading(false); setError(asError(caught)); } });
    return () => { alive = false; };
  }, [refresh]);

  const allRuns = useMemo(() => {
    const byId = new Map<string, RunSummary>();
    for (const run of [...(catalog.runs || []), ...catalog.portfolios.flatMap((portfolio) => portfolio.runs || [])]) byId.set(runIdOf(run), run);
    return [...byId.values()].sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
  }, [catalog]);

  const inspectRun = useCallback(async (id: string) => {
    const result = await portfolioRequest<PortfolioRun>(`/api/portfolio/runs/${encodeURIComponent(id)}`);
    const normalizedRun = { ...result, id: result.runId };
    if (result.document) {
      setActiveRun(normalizedRun);
      setEditorDocument(normalizePortfolioDocument(result.document));
      setEditorTitle(result.title || "");
      setEditorTags((result.tags || []).join(", "));
      setEditorProjectIds(result.projectIds || []);
      setFormat(result.format || "letter");
      setSavedDraftKey(draftKey(normalizePortfolioDocument(result.document), result.title || "", result.tags || [], result.projectIds || [], result.format || "letter"));
      const savedClaims = sourceReviewOf(normalizedRun)?.claims || [];
      setClaimChoices(Object.fromEntries(savedClaims.filter((claim) => claim.outcome).map((claim) => [claim.id, claim.outcome === "user-cannot-confirm" ? "do-not-know" : claim.outcome as ClaimChoice])));
      setClaimCorrections(Object.fromEntries(savedClaims.filter((claim) => claim.outcome === "correct" && claim.correctedText).map((claim) => [claim.id, claim.correctedText!])));
    }
    return normalizedRun;
  }, []);

  useEffect(() => {
    if (!allRuns.some((run) => run.status === "queued" || run.status === "running")) return;
    const timer = window.setInterval(() => {
      void refresh().catch((caught) => setError(asError(caught)));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [allRuns, refresh]);

  const openMetadata = (portfolio: Portfolio) => {
    setMetadataTarget(portfolio); setMetadataTitle(portfolio.title); setMetadataTags(portfolio.tags.join(", "));
    setMetadataKind(portfolio.kind); setMetadataProjects(portfolio.projectIds);
  };

  const openProject = (project?: Project) => {
    setProjectTarget(project || null); setProjectName(project?.name || ""); setProjectSummary(project?.summary || "");
    setProjectUrl(project?.url || ""); setProjectTags((project?.tags || []).join(", "));
  };

  const closeEditor = () => { setActiveRun(null); setEditorDocument(null); setSavedDraftKey(""); };
  const currentDraftKey = editorDocument ? (() => { try { return draftKey(normalizePortfolioDocument(editorDocument), editorTitle.trim(), words(editorTags), editorProjectIds, format); } catch { return ""; } })() : "";
  const currentSourceReview = sourceReviewOf(activeRun);
  const sourceReviewResolved = !currentSourceReview?.claims?.length || currentSourceReview.status === "applied";
  const draftIsSaved = Boolean(activeRun?.status === "awaiting_review" && activeRun.draftSha256 && currentDraftKey && currentDraftKey === savedDraftKey && sourceReviewResolved);

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await withBusy("generate", async () => {
      const payload = {
        mode: portfolioRunMode(sourceMode), sourceMode, kind, title: title.trim(), tags: words(tags), projectIds,
        basePortfolioId: basePortfolioId || undefined, baseVersion: baseVersion || undefined,
        expectedRevision: sourceMode === "portfolio" ? catalog.portfolios.find((portfolio) => portfolio.id === basePortfolioId)?.revision : undefined,
        applicationNumber: applicationNumber.trim() || undefined, instructions: instructions.trim() || undefined, format,
      };
      const opId = operationKeys.current.begin("run:create", payload);
      const result = await portfolioRequest<PortfolioRun>("/api/portfolio/runs", json({ ...payload, operationId: opId }));
      operationKeys.current.complete("run:create", opId);
      if (result.runId) await refresh();
      setTitle(""); setInstructions(""); setSuccess(result.status === "queued" ? "Draft queued. Its real progress will appear below and can be resumed after reload." : "Draft created and ready for review.");
    });
  }

  async function uploadPdf(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFile) { setError("Choose a PDF file to import."); return; }
    await withBusy("upload", async () => {
      const targetId = uploadTargetId;
      const fileDigest = await crypto.subtle.digest("SHA-256", await uploadFile.arrayBuffer());
      const sha256 = [...new Uint8Array(fileDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const descriptor = { target: targetId || "new-master", name: uploadFile.name, size: uploadFile.size, sha256, title: targetId ? "" : uploadTitle.trim(), tags: targetId ? [] : words(tags), projectIds: targetId ? [] : projectIds };
      const operationId = operationKeys.current.begin(`upload:${descriptor.target}`, descriptor);
      const form = new FormData();
      form.set("file", uploadFile); form.set("operationId", operationId);
      if (targetId) form.set("portfolioId", targetId);
      else { form.set("title", uploadTitle.trim()); form.set("kind", "master"); form.set("tags", JSON.stringify(words(tags))); form.set("projectIds", JSON.stringify(projectIds)); }
      await portfolioRequest("/api/portfolio", { method: "POST", body: form });
      operationKeys.current.complete(`upload:${descriptor.target}`, operationId);
      setUploadFile(null); setUploadTargetId(""); setUploadTitle(""); await refresh();
      setSuccess(targetId ? "Uploaded a new immutable PDF version. The previous bytes remain unchanged." : "Imported your master PDF. Its original bytes remain immutable; use Create editable draft to run source review.");
    });
  }

  async function beginEdit(portfolio: Portfolio, version: number) {
    await withBusy(`edit:${portfolio.id}`, async () => {
      const detail = await portfolioRequest<{ portfolio: Portfolio; version: Version; document: PortfolioDocument | null }>(`/api/portfolio/detail?portfolioId=${encodeURIComponent(portfolio.id)}&version=${version}`);
      const selectedDocument = detail.document ? normalizePortfolioDocument(detail.document) : undefined;
      const payload = {
        mode: "edit", sourceMode: selectedDocument ? "profile" : "portfolio", kind: detail.portfolio.kind,
        title: detail.portfolio.title, tags: detail.portfolio.tags, projectIds: detail.portfolio.projectIds,
        basePortfolioId: detail.portfolio.id, baseVersion: detail.version.version,
        expectedRevision: revisionOf(detail.portfolio), format, ...(selectedDocument ? { document: selectedDocument } : {}),
      };
      const opId = operationKeys.current.begin(`run:edit:${portfolio.id}:${version}`, payload);
      const result = await portfolioRequest<PortfolioRun>("/api/portfolio/runs", json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`run:edit:${portfolio.id}:${version}`, opId);
      await refresh();
      if (result.status === "awaiting_review" || result.document) await inspectRun(result.runId);
      else setSuccess("Editable source draft queued. The imported PDF remains immutable while the draft is prepared.");
    });
  }

  async function savePreview() {
    if (!activeRun || !editorDocument || !activeRun.draftSha256) return;
    await withBusy("preview", async () => {
      const payload = {
        expectedDraftSha256: activeRun.draftSha256, document: normalizePortfolioDocument(editorDocument),
        title: editorTitle.trim(), tags: words(editorTags), projectIds: editorProjectIds, format,
      };
      const opId = operationKeys.current.begin(`run:preview:${activeRun.runId}`, payload);
      const preview = await portfolioRequest<{ run: PortfolioRun; html: string }>(`/api/portfolio/runs/${encodeURIComponent(activeRun.runId)}/preview`, json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`run:preview:${activeRun.runId}`, opId);
      const result = preview.run;
      setActiveRun({ ...activeRun, ...result });
      if (result.document) setEditorDocument(normalizePortfolioDocument(result.document));
      setSavedDraftKey(draftKey(payload.document, payload.title, payload.tags, payload.projectIds, payload.format));
      setSuccess("Your edits are saved to this draft. Review the preview, then apply to queue a new private PDF version.");
    });
  }

  async function applyRender() {
    if (!activeRun?.draftSha256) return;
    await withBusy("apply", async () => {
      const payload = { expectedDraftSha256: activeRun.draftSha256, confirm: true };
      const opId = operationKeys.current.begin(`run:apply:${activeRun.runId}`, payload);
      const result = await portfolioRequest<PortfolioRun>(`/api/portfolio/runs/${encodeURIComponent(activeRun.runId)}/apply`, json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`run:apply:${activeRun.runId}`, opId);
      setActiveRun({ ...activeRun, ...result }); await refresh();
      closeEditor();
      setSuccess("Render queued. A new PDF version will appear only after the worker confirms completion.");
    });
  }

  async function cancelRun(run: RunSummary) {
    const id = runIdOf(run);
    await withBusy(`cancel:${id}`, async () => {
      const payload = { confirm: true };
      const opId = operationKeys.current.begin(`run:cancel:${id}`, payload);
      await portfolioRequest(`/api/portfolio/runs/${encodeURIComponent(id)}/cancel`, json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`run:cancel:${id}`, opId); await refresh();
      if (activeRun?.runId === id) closeEditor(); setSuccess("Run canceled.");
    });
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!metadataTarget) return;
    await withBusy(`metadata:${metadataTarget.id}`, async () => {
      const changes = { title: metadataTitle.trim(), kind: metadataKind, tags: words(metadataTags), projectIds: metadataProjects };
      const payload = { operation: "update-metadata", id: metadataTarget.id, expectedRevision: revisionOf(metadataTarget), changes };
      const opId = operationKeys.current.begin(`metadata:${metadataTarget.id}`, payload);
      await portfolioRequest("/api/portfolio/commands", json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`metadata:${metadataTarget.id}`, opId); setMetadataTarget(null); await refresh(); setSuccess("Portfolio details updated.");
    });
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await withBusy(projectTarget ? `project:${projectTarget.id}` : "project:add", async () => {
      const values = { name: projectName.trim(), summary: projectSummary.trim(), url: projectUrl.trim(), tags: words(projectTags) };
      if (projectTarget) {
        const payload = { operation: "update-project", id: projectTarget.id, expectedRevision: revisionOf(projectTarget), changes: values };
        const opId = operationKeys.current.begin(`project:${projectTarget.id}`, payload);
        await portfolioRequest("/api/portfolio/commands", json({ ...payload, operationId: opId }));
        operationKeys.current.complete(`project:${projectTarget.id}`, opId);
      } else {
        const opId = operationKeys.current.begin("project:add", values);
        await portfolioRequest("/api/portfolio/projects", json({ ...values, operationId: opId }));
        operationKeys.current.complete("project:add", opId);
      }
      setProjectTarget(null); await refresh(); setSuccess(projectTarget ? "Project updated." : "Project added to the registry.");
    });
  }

  async function confirmDestructive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!destructive || (destructive.kind.includes("purge") && confirmationName !== destructive.title)) return;
    await withBusy(`${destructive.kind}:${destructive.id}`, async () => {
      const op = destructive.kind;
      const purgePortfolio = op === "purge";
      const payload = {
        operation: op, id: destructive.id, expectedRevision: destructive.revision, confirm: true,
        ...(op === "purge" || op === "purge-project" ? { confirmationName } : {}),
        ...(purgePortfolio && detachAssociations ? { detachAssociations: true } : {}),
      };
      const opId = operationKeys.current.begin(`destructive:${op}:${destructive.id}`, payload);
      await portfolioRequest("/api/portfolio/commands", json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`destructive:${op}:${destructive.id}`, opId);
      setDestructive(null); setConfirmationName(""); setDetachAssociations(false); await refresh();
      setSuccess(op === "archive" || op === "archive-project" ? "Moved to recoverable trash." : "Permanently deleted the confirmed record.");
    });
  }

  async function restore(kind: "restore" | "restore-project", id: string, revision: number) {
    await withBusy(`restore:${id}`, async () => {
      const payload = { operation: kind, id, expectedRevision: revision, confirm: true };
      const opId = operationKeys.current.begin(`restore:${id}`, payload);
      await portfolioRequest("/api/portfolio/commands", json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`restore:${id}`, opId); await refresh(); setSuccess("Restored from trash.");
    });
  }

  async function download(portfolioId: string, version: number, name: string) {
    await withBusy(`download:${portfolioId}:${version}`, async () => {
      const response = await fetch(`/api/portfolio/pdf?portfolioId=${encodeURIComponent(portfolioId)}&version=${version}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`PDF download failed (${response.status}). Refresh and retry.`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = objectUrl; anchor.download = `${name.replace(/[^\w-]+/g, "-") || "portfolio"}-v${version}.pdf`;
      document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    });
  }

  async function recommend() {
    await withBusy("recommend", async () => {
      const result = await portfolioRequest<{ application: { role: string }; recommendations: Recommendation[] }>(`/api/portfolio/recommend?applicationNumber=${encodeURIComponent(appNumber.trim())}`);
      setMatchedRole(result.application.role); setRecommendations(result.recommendations);
    });
  }

  async function attach(portfolio: Portfolio) {
    await withBusy(`attach:${portfolio.id}`, async () => {
      const version = selectedVersions[portfolio.id] || portfolio.latestVersion;
      if (!version) throw new Error("Choose an existing portfolio PDF version first.");
      const payload = { applicationNumber: appNumber.trim(), portfolioId: portfolio.id, version };
      const opId = operationKeys.current.begin(`associate:${appNumber}:${portfolio.id}:${version}`, payload);
      await portfolioRequest("/api/portfolio/associate", json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`associate:${appNumber}:${portfolio.id}:${version}`, opId); await refresh();
      setSuccess(`Attached ${portfolio.title} v${version} to application #${appNumber}. No application was submitted.`);
    });
  }

  async function reviewFacts() {
    const review = sourceReviewOf(activeRun);
    if (!activeRun || !review || !activeRun.draftSha256) return;
    await withBusy("facts-preview", async () => {
      const decisions = review.claims.filter((claim) => !claim.outcome).map((claim) => ({
        claimId: claim.id, outcome: claimChoices[claim.id],
        correctedText: claimChoices[claim.id] === "correct" ? claimCorrections[claim.id] || "" : undefined,
      }));
      if (decisions.length === 0) throw new Error("All source claims already have saved outcomes. Use the saved review below.");
      if (decisions.some((decision) => !decision.outcome || (decision.outcome === "correct" && !decision.correctedText?.trim()))) {
        throw new Error("Choose an outcome for every claim. Corrected claims also need the accurate wording.");
      }
      const payload = { expectedDraftSha256: activeRun.draftSha256, decisions };
      const opId = operationKeys.current.begin(`facts-preview:${activeRun.runId}`, payload);
      const response = await portfolioRequest<{ run: PortfolioRun; factsReview: PortfolioRun["factsReview"] }>(`/api/portfolio/runs/${encodeURIComponent(activeRun.runId)}/facts/preview`, json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`facts-preview:${activeRun.runId}`, opId); setActiveRun({ ...activeRun, ...response.run, sourceReview: response.factsReview });
      const hasProfileProposal = Boolean(response.factsReview?.profileProposalId);
      const hasProfileChanges = Array.isArray(response.factsReview?.sourceDiff) ? response.factsReview.sourceDiff.length > 0 : Boolean(response.factsReview?.sourceDiff);
      setSuccess(hasProfileProposal && hasProfileChanges
        ? "The profile diff is ready. Review it below before applying it separately."
        : "Claim decisions are previewed. No primary source has changed.");
    });
  }

  async function applyFacts() {
    const facts = sourceReviewOf(activeRun);
    if (!activeRun || !facts?.previewId) return;
    await withBusy("facts-apply", async () => {
      const sourcePayload = { previewId: facts.previewId, expectedDraftSha256: activeRun.draftSha256 };
      const sourceOperationId = facts.profileProposalId ? operationKeys.current.begin(`source-apply:${activeRun.runId}`, { profileProposalId: facts.profileProposalId, expectedProfileSha256: facts.profileSha256 }) : undefined;
      const payload = { ...sourcePayload, ...(facts.profileProposalId ? { profileProposalId: facts.profileProposalId, expectedProfileSha256: facts.profileSha256, sourceOperationId } : {}), confirm: true };
      const opId = operationKeys.current.begin(`facts-apply:${activeRun.runId}`, payload);
      const response = await portfolioRequest<{ run: PortfolioRun; factsReview: PortfolioRun["factsReview"] }>(`/api/portfolio/runs/${encodeURIComponent(activeRun.runId)}/facts/apply`, json({ ...payload, operationId: opId }));
      operationKeys.current.complete(`facts-apply:${activeRun.runId}`, opId);
      if (sourceOperationId) operationKeys.current.complete(`source-apply:${activeRun.runId}`, sourceOperationId);
      setActiveRun({ ...activeRun, ...response.run, sourceReview: response.factsReview });
      setSuccess(response.factsReview?.profileProposalId && (Array.isArray(response.factsReview.sourceDiff) ? response.factsReview.sourceDiff.length > 0 : Boolean(response.factsReview.sourceDiff))
        ? "The confirmed profile diff was applied. Review the refreshed draft before rendering."
        : "Claim decisions are saved. No primary source was changed. Review the refreshed draft before rendering.");
    });
  }

  const publicPortfolios = catalog.portfolios.filter((portfolio) => showArchived || !portfolio.archivedAt);
  const archivedProjects = catalog.projects.filter((project) => project.archivedAt);
  const activeSourceReview = sourceReviewOf(activeRun);
  const errorBanner = error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"><CircleAlert size={17} className="mt-0.5 shrink-0"/><span>{error}</span><button type="button" className="ml-auto underline" onClick={() => setError("")}>Dismiss</button></div>;

  return <main className="mx-auto max-w-6xl space-y-8 px-5 py-8 md:px-8">
    <header className="border-b border-border pb-6">
      <span className="font-mono text-[11px] uppercase tracking-[.2em] text-brand-text">Supporting documents / private</span>
      <h1 className="mt-3 font-display text-4xl tracking-tight text-landing md:text-5xl">Portfolio library<span className="text-brand-text">.</span></h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">Build source-backed portfolio drafts, review every edit, then render private immutable PDF versions. Uploaded originals stay available as their own versions.</p>
    </header>

    <section className={card} aria-labelledby="library-status">
      <div className="flex flex-wrap items-center gap-3"><LockKeyhole size={18} className="text-brand-text"/><h2 id="library-status" className="font-medium">Private document library</h2>
        <button type="button" className={`${secondary} ml-auto`} disabled={Boolean(busy)} onClick={() => void withBusy("refresh", async () => { await refresh(); })}><RefreshCw size={15}/>{busy === "refresh" ? "Refreshing…" : "Refresh"}</button>
      </div>
      <p className="mt-2 text-xs text-muted">Uses your existing Career Ops owner login. Files and drafts remain private.</p>
      <div className="mt-3">{errorBanner}{success && <p role="status" className="mt-3 rounded-lg bg-brand-soft p-3 text-sm text-brand-text">{success}</p>}</div>
    </section>

    {loading ? <section className={card} role="status"><LoaderCircle className="mr-2 inline animate-spin" size={17}/>Loading your private portfolio library…</section> : error && catalog.portfolios.length === 0 ? <section className={`${card} text-sm text-muted`}>The library could not load. Use Refresh after your owner session is available.</section> : <>
      <section className="grid gap-6 lg:grid-cols-[1.1fr_.9fr]">
        <form className={`${card} space-y-4`} onSubmit={createRun}>
          <div className="flex items-center gap-2"><Sparkles size={19} className="text-brand-text"/><h2 className="text-lg font-semibold">Create a portfolio draft</h2></div>
          <p className="text-xs leading-relaxed text-muted">Drafts use your primary profile sources. The PDF is created only after you review the content and explicitly apply it.</p>
          <label className="block space-y-1.5 text-sm">Portfolio title<input required maxLength={160} className={input} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Product and AI portfolio"/></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm">Document type<select className={input} value={kind} onChange={(event) => setKind(event.target.value as "master" | "variant")}><option value="master">Master</option><option value="variant">Role-focused variant</option></select></label>
            <label className="block space-y-1.5 text-sm">Page size<select className={input} value={format} onChange={(event) => setFormat(event.target.value as "letter" | "a4")}><option value="letter">Letter</option><option value="a4">A4</option></select></label>
          </div>
          <label className="block space-y-1.5 text-sm">Tags<input className={input} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="AI, product, engineering"/></label>
          <label className="block space-y-1.5 text-sm">Draft source<select className={input} value={sourceMode} onChange={(event) => setSourceMode(event.target.value as "profile" | "portfolio")}><option value="profile">Primary profile sources</option><option value="portfolio">Convert an imported PDF into a source-reviewed draft</option></select></label>
          {sourceMode === "portfolio" && <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-muted">The uploaded PDF is reference material only. Unsupported numbers and responsibility claims need an explicit four-outcome review before the draft can render.</div>}
          <label className="block space-y-1.5 text-sm">Source portfolio version{sourceMode === "portfolio" ? " · required for PDF intake" : " (optional)"}<select required={sourceMode === "portfolio"} className={input} value={basePortfolioId ? `${basePortfolioId}:${baseVersion}` : ""} onChange={(event) => { const [id, version] = event.target.value ? event.target.value.split(":") : ["", ""]; setBasePortfolioId(id); setBaseVersion(version ? Number(version) : ""); }}><option value="">{sourceMode === "portfolio" ? "Select an imported PDF" : "Start a new profile-backed draft"}</option>{catalog.portfolios.filter((portfolio) => !portfolio.archivedAt).map((portfolio) => portfolio.versions.map((version) => <option key={`${portfolio.id}:${version.version}`} value={`${portfolio.id}:${version.version}`}>{portfolio.title} · v{version.version}{version.hasEditableContent ? " · editable" : " · imported PDF"}</option>))}</select></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm">Link to application (optional)<input className={input} value={applicationNumber} onChange={(event) => setApplicationNumber(event.target.value)} inputMode="numeric" pattern="[1-9][0-9]{0,5}" placeholder="Tracker number"/></label>
            <label className="block space-y-1.5 text-sm">Projects (optional)<span className="block max-h-28 overflow-y-auto rounded-xl border border-border p-2">{catalog.projects.filter((project) => !project.archivedAt).map((project) => <span key={project.id} className="mr-3 inline-flex items-center gap-1.5 py-1"><input aria-label={`Include project ${project.name}`} type="checkbox" checked={projectIds.includes(project.id)} onChange={(event) => setProjectIds((old) => event.target.checked ? [...old, project.id] : old.filter((id) => id !== project.id))}/>{project.name}</span>)}{catalog.projects.length === 0 && <span className="text-xs text-muted">Add evidence projects below.</span>}</span></label>
          </div>
          <label className="block space-y-1.5 text-sm">Instructions (optional)<textarea className={input} rows={3} maxLength={3000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Describe the target emphasis. Do not add unsupported facts."/></label>
          <button className={primary} disabled={Boolean(busy)} type="submit"><Sparkles size={16}/>{busy === "generate" ? "Starting draft…" : "Start source-backed draft"}</button>
        </form>

        <form className={`${card} space-y-3`} onSubmit={saveProject}>
          <div className="flex items-center gap-2"><FolderArchive size={19} className="text-brand-text"/><h2 className="text-lg font-semibold">Project evidence</h2></div>
          <p className="text-xs leading-relaxed text-muted">Keep descriptions and links grounded in work you can support. Projects are editable and can be restored from trash.</p>
          <label className="block space-y-1.5 text-sm">Project name<input required maxLength={160} className={input} value={projectName} onChange={(event) => setProjectName(event.target.value)}/></label>
          <label className="block space-y-1.5 text-sm">Summary<textarea required maxLength={2000} rows={3} className={input} value={projectSummary} onChange={(event) => setProjectSummary(event.target.value)} placeholder="Your contribution and substantiated outcome"/></label>
          <label className="block space-y-1.5 text-sm">Evidence URL<input type="url" className={input} value={projectUrl} onChange={(event) => setProjectUrl(event.target.value)} placeholder="https://…"/></label>
          <label className="block space-y-1.5 text-sm">Tags<input className={input} value={projectTags} onChange={(event) => setProjectTags(event.target.value)} placeholder="data, automation"/></label>
          <button className={secondary} disabled={Boolean(busy)} type="submit"><Plus size={16}/>{projectTarget ? "Save project changes" : "Add project"}</button>
          {projectTarget && <button className="ml-2 text-sm text-muted underline" type="button" onClick={() => openProject()}>Cancel edit</button>}
          <div className="space-y-2 border-t border-border pt-3">
            {catalog.projects.filter((project) => !project.archivedAt).map((project) => <div key={project.id} className="flex flex-wrap items-start gap-2 rounded-lg bg-background/60 p-3">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">{project.name}</p><p className="mt-1 line-clamp-2 text-xs text-muted">{project.summary}</p>{project.url && <a className="mt-1 block truncate text-xs text-brand-text underline" href={project.url} target="_blank" rel="noopener noreferrer">{project.url}</a>}</div>
              <button className="p-2 text-muted hover:text-foreground" type="button" aria-label={`Edit project ${project.name}`} onClick={() => openProject(project)}><Pencil size={15}/></button>
              <button className="p-2 text-muted hover:text-foreground" type="button" aria-label={`Move project ${project.name} to trash`} onClick={() => setDestructive({ kind: "archive-project", id: project.id, title: project.name, revision: revisionOf(project), references: project.usageCount || 0 })}><Archive size={15}/></button>
            </div>)}
            {archivedProjects.map((project) => <div key={project.id} className="flex items-center gap-2 text-xs text-muted"><span className="flex-1">{project.name} · in trash</span><button type="button" className="inline-flex items-center gap-1 underline" onClick={() => void restore("restore-project", project.id, revisionOf(project))}><RotateCcw size={13}/>Restore</button><button type="button" className="underline" onClick={() => setDestructive({ kind: "purge-project", id: project.id, title: project.name, revision: revisionOf(project), references: project.usageCount || 0 })}>Delete permanently</button></div>)}
          </div>
        </form>
      </section>

      <form className={`${card} grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end`} onSubmit={uploadPdf}>
        <div><h2 className="flex items-center gap-2 text-lg font-semibold"><UploadCloud size={18} className="text-brand-text"/>Import a master PDF</h2><p className="mt-1 text-xs text-muted">Keep the exact uploaded bytes as an immutable version. PDF limit: 4 MB.</p></div>
        {!uploadTargetId && <label className="block space-y-1.5 text-sm">Portfolio title<input required maxLength={160} className={input} value={uploadTitle} onChange={(event) => setUploadTitle(event.target.value)} placeholder="Master portfolio"/></label>}
        <label className="block space-y-1.5 text-sm">PDF file<input required type="file" accept="application/pdf,.pdf" className={`${input} file:mr-3 file:rounded-full file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-brand-text`} onChange={(event) => setUploadFile(event.target.files?.[0] || null)}/></label>
        <button className={primary} disabled={Boolean(busy) || !uploadFile} type="submit"><UploadCloud size={15}/>{busy === "upload" ? "Importing…" : "Import PDF"}</button>
        {uploadTargetId && <p className="text-xs text-brand-text lg:col-span-3">Adding a new version to {catalog.portfolios.find((portfolio) => portfolio.id === uploadTargetId)?.title}. <button type="button" className="underline" onClick={() => setUploadTargetId("")}>Cancel</button></p>}
      </form>

      {(allRuns.length > 0) && <section className={`${card} space-y-3`} aria-labelledby="runs-heading">
        <div className="flex items-center gap-2"><Clock3 size={18} className="text-brand-text"/><h2 id="runs-heading" className="text-lg font-semibold">Drafts and renders</h2><span className="ml-auto text-xs text-muted">Resumes from saved run status</span></div>
        <div className="divide-y divide-border">
          {allRuns.map((run) => <div key={runIdOf(run)} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{run.title || (runMode(run) === "generate" ? "Portfolio draft" : "Portfolio edit")}</p><p className="mt-1 text-xs capitalize text-muted">{run.phase} · {statusLabel(run.status)}{run.version ? ` · v${run.version}` : ""}{run.error || run.errorCode ? ` · ${run.error || run.errorCode}` : ""}</p></div>
            {run.status === "awaiting_review" && <button type="button" className={secondary} onClick={() => void withBusy(`resume:${runIdOf(run)}`, async () => { await inspectRun(runIdOf(run)); })}>Resume review</button>}
            {run.status === "completed" && run.portfolioId && run.version && <button type="button" className={secondary} onClick={() => { const portfolio = catalog.portfolios.find((entry) => entry.id === run.portfolioId); void download(run.portfolioId!, run.version!, portfolio?.title || run.title || "portfolio"); }}><ArrowDownToLine size={15}/>Download result</button>}
            {activeStatuses.has(run.status) && <button type="button" className="text-xs text-muted underline" onClick={() => void cancelRun(run)}>Cancel run</button>}
          </div>)}
        </div>
      </section>}

      {activeRun && editorDocument && <section className={`${card} space-y-5`} aria-labelledby="editor-heading">
        <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><p className="font-mono text-[10px] uppercase tracking-widest text-brand-text">Review before rendering</p><h2 id="editor-heading" className="mt-1 text-xl font-semibold">{activeRun.title || "Portfolio draft"}</h2><p className="mt-1 text-xs text-muted">Run {activeRun.runId} · {activeRun.phase} · {statusLabel(activeRun.status)}</p></div><button type="button" className={secondary} onClick={closeEditor} aria-label="Close draft editor"><X size={16}/>Close</button></div>
        {activeSourceReview?.claims?.length ? <section className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" aria-labelledby="facts-heading">
          <h3 id="facts-heading" className="font-semibold">Review source claims</h3><p className="text-xs leading-relaxed text-muted">Choose one outcome for each claim. “I don’t know” keeps it narrative-only and never treats its number as verified.</p>
          {activeSourceReview.claims.map((claim) => <fieldset key={claim.id} className="space-y-2 border-t border-amber-500/20 pt-3"><legend className="font-medium">{claim.text}</legend>{claim.provenance && <p className="text-xs text-muted">Source: {claim.provenance}</p>}<div className="grid gap-2 sm:grid-cols-2">{([["confirm", "Confirm as accurate"], ["correct", "Provide the correct wording"], ["narrative-only", "Narrative only, not quantified"], ["do-not-know", "I don’t know"]] as const).map(([value, label]) => <label key={value} className="flex items-center gap-2 text-xs"><input type="radio" name={`claim-${claim.id}`} checked={claimChoices[claim.id] === value} disabled={Boolean(claim.outcome) || Boolean(activeSourceReview.previewId)} onChange={() => setClaimChoices((current) => ({ ...current, [claim.id]: value }))}/>{label}</label>)}</div>{claimChoices[claim.id] === "correct" && <label className="block space-y-1 text-xs">Correct wording<textarea className={input} rows={2} value={claimCorrections[claim.id] || ""} onChange={(event) => setClaimCorrections((current) => ({ ...current, [claim.id]: event.target.value }))}/></label>}</fieldset>)}
          {activeSourceReview.status === "applied" ? <p role="status" className="text-xs text-muted">These claim decisions are saved. Claims marked “I don’t know” remain narrative-only.</p> : <button type="button" className={secondary} disabled={Boolean(busy) || Boolean(activeSourceReview.previewId)} onClick={() => void reviewFacts()}>Preview claim decisions</button>}
          {activeSourceReview.previewId && <div className="space-y-2 rounded-lg bg-background p-3">{activeSourceReview.sourceDiff != null && <><p className="text-sm font-medium">Profile source diff</p><pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs">{typeof activeSourceReview.sourceDiff === "string" ? activeSourceReview.sourceDiff : JSON.stringify(activeSourceReview.sourceDiff, null, 2) || ""}</pre></>}<button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => void applyFacts()}>{activeSourceReview.profileProposalId ? "Apply profile update and confirm claims" : "Confirm claim review"}</button></div>}
        </section> : null}
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm">Title<input className={input} maxLength={160} value={editorTitle} onChange={(event) => setEditorTitle(event.target.value)}/></label><label className="space-y-1 text-sm">Tags<input className={input} value={editorTags} onChange={(event) => setEditorTags(event.target.value)}/></label></div>
            <label className="block space-y-1 text-sm">Name<input className={input} value={editorDocument.name} onChange={(event) => setEditorDocument({ ...editorDocument, name: event.target.value })}/></label>
            <label className="block space-y-1 text-sm">Headline<input className={input} value={editorDocument.headline} onChange={(event) => setEditorDocument({ ...editorDocument, headline: event.target.value })}/></label>
            <label className="block space-y-1 text-sm">Summary<textarea className={input} rows={4} value={editorDocument.summary} onChange={(event) => setEditorDocument({ ...editorDocument, summary: event.target.value })}/></label>
            <label className="block space-y-1 text-sm">Highlights<textarea className={input} rows={4} value={editorDocument.highlights.join("\n")} onChange={(event) => setEditorDocument({ ...editorDocument, highlights: event.target.value.split("\n") })} placeholder="One item per line"/></label>
            <label className="block space-y-1 text-sm">Skills<input className={input} value={editorDocument.skills.join(", ")} onChange={(event) => setEditorDocument({ ...editorDocument, skills: words(event.target.value) })}/></label>
            <label className="block space-y-1 text-sm">Theme<select className={input} value={editorDocument.theme || "classic"} onChange={(event) => setEditorDocument({ ...editorDocument, theme: event.target.value as "classic" | "editorial" })}><option value="classic">Classic</option><option value="editorial">Editorial</option></select></label>
            <label className="block space-y-1 text-sm">Links<textarea className={input} rows={3} value={editorDocument.links.map((link) => `${link.label} | ${link.url}`).join("\n")} onChange={(event) => setEditorDocument({ ...editorDocument, links: event.target.value.split("\n").filter(Boolean).map((line) => { const [label, url] = line.split("|").map((part) => part.trim()); return { label: label || "", url: url || "" }; }) })} placeholder="Label | https://…"/></label>
            <div className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-medium">Projects · {editorDocument.projects.length}</h3><button className={secondary} type="button" disabled={editorDocument.projects.length >= 10} onClick={() => setEditorDocument({ ...editorDocument, projects: [...editorDocument.projects, { title: "", role: "", summary: "", highlights: [], skills: [], links: [] }] })}><Plus size={14}/>Add project</button></div>
              {editorDocument.projects.map((project, index) => <fieldset key={`project-${index}`} className="space-y-2 rounded-xl border border-border p-3"><legend className="px-1 text-sm font-medium">Project {index + 1}</legend><div className="flex gap-3"><button type="button" className="text-xs underline disabled:opacity-40" aria-label={`Move project ${project.title || index + 1} up`} disabled={index === 0} onClick={() => setEditorDocument({ ...editorDocument, projects: moveItem(editorDocument.projects, index, index - 1) })}>Move up</button><button type="button" className="text-xs underline disabled:opacity-40" aria-label={`Move project ${project.title || index + 1} down`} disabled={index === editorDocument.projects.length - 1} onClick={() => setEditorDocument({ ...editorDocument, projects: moveItem(editorDocument.projects, index, index + 1) })}>Move down</button></div><label className="block space-y-1 text-xs">Title<input className={input} value={project.title} onChange={(event) => setEditorDocument({ ...editorDocument, projects: editorDocument.projects.map((item, i) => i === index ? { ...item, title: event.target.value } : item) })}/></label><label className="block space-y-1 text-xs">Role<input className={input} value={project.role} onChange={(event) => setEditorDocument({ ...editorDocument, projects: editorDocument.projects.map((item, i) => i === index ? { ...item, role: event.target.value } : item) })}/></label><label className="block space-y-1 text-xs">Summary<textarea className={input} rows={3} value={project.summary} onChange={(event) => setEditorDocument({ ...editorDocument, projects: editorDocument.projects.map((item, i) => i === index ? { ...item, summary: event.target.value } : item) })}/></label><label className="block space-y-1 text-xs">Highlights<textarea className={input} rows={2} value={project.highlights.join("\n")} onChange={(event) => setEditorDocument({ ...editorDocument, projects: editorDocument.projects.map((item, i) => i === index ? { ...item, highlights: event.target.value.split("\n") } : item) })}/></label><label className="block space-y-1 text-xs">Skills<input className={input} value={project.skills.join(", ")} onChange={(event) => setEditorDocument({ ...editorDocument, projects: editorDocument.projects.map((item, i) => i === index ? { ...item, skills: words(event.target.value) } : item) })}/></label><label className="block space-y-1 text-xs">Links<textarea className={input} rows={2} value={project.links.map((link) => `${link.label} | ${link.url}`).join("\n")} onChange={(event) => setEditorDocument({ ...editorDocument, projects: editorDocument.projects.map((item, i) => i === index ? { ...item, links: event.target.value.split("\n").filter(Boolean).map((line) => { const [label, url] = line.split("|").map((part) => part.trim()); return { label: label || "", url: url || "" }; }) } : item) })}/></label><button className="text-xs text-red-600 underline" type="button" onClick={() => setEditorDocument({ ...editorDocument, projects: editorDocument.projects.filter((_, i) => i !== index) })}>Remove project</button></fieldset>)}
            </div>
            <fieldset className="space-y-1"><legend className="mb-1 text-sm">Add registered project references</legend>{catalog.projects.filter((project) => !project.archivedAt).map((project) => <label key={project.id} className="mr-3 inline-flex items-center gap-1.5 py-1 text-xs"><input type="checkbox" checked={editorProjectIds.includes(project.id)} onChange={(event) => setEditorProjectIds((old) => event.target.checked ? [...old, project.id] : old.filter((id) => id !== project.id))}/>{project.name}</label>)}</fieldset>
            <div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={Boolean(busy) || activeRun.status !== "awaiting_review"} onClick={() => void savePreview()}><Save size={15}/>{busy === "preview" ? "Saving…" : "Save draft edits"}</button><button type="button" className={primary} disabled={Boolean(busy) || !draftIsSaved} onClick={() => void applyRender()}><FilePlus2 size={15}/>{busy === "apply" ? "Queueing render…" : !sourceReviewResolved ? "Resolve source review before rendering" : draftIsSaved ? "Apply and render new PDF" : "Save edits before rendering"}</button></div>
            <p role="status" className="text-xs leading-relaxed text-muted">Saving updates the review draft. Applying is available only when the visible edits match the saved draft hash. A PDF appears only after the worker confirms completion.</p>
          </div>
          <div className="min-h-[35rem] overflow-hidden rounded-xl border border-border bg-white"><div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted"><span>Safe document preview · {format.toUpperCase()}</span><select aria-label="Preview page size" className="rounded-md border border-border px-2 py-1" value={format} onChange={(event) => setFormat(event.target.value as "letter" | "a4")}><option value="letter">Letter</option><option value="a4">A4</option></select></div><iframe title="Portfolio document preview" sandbox="" className="h-[34rem] w-full bg-white" srcDoc={renderPreview(editorDocument, format, editorTitle)}/></div>
        </div>
      </section>}

      <section className={`${card} space-y-3`}>
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Link2 size={18} className="text-brand-text"/>Match to an application</h2>
        <p className="text-xs text-muted">Suggestions use role and tag overlap. Attach a selected saved version only when you choose it.</p>
        <div className="flex flex-wrap gap-2"><label className="sr-only" htmlFor="application-number">Application number</label><input id="application-number" className={`${input} max-w-xs`} aria-label="Application number" inputMode="numeric" value={appNumber} onChange={(event) => { setAppNumber(event.target.value); setRecommendations([]); setMatchedRole(""); }} placeholder="Application #"/><button type="button" className={secondary} disabled={Boolean(busy) || !appNumber.trim()} onClick={() => void recommend()}>Find relevant portfolios</button></div>
        {matchedRole && <p className="text-sm text-muted">Matching against: <strong className="text-foreground">{matchedRole}</strong></p>}
        {catalog.associations.filter((association) => association.applicationNumber === appNumber.trim()).map((association) => <p key={`${association.applicationNumber}:${association.portfolioId}:${association.version}`} className="text-xs text-brand-text">Linked: {catalog.portfolios.find((portfolio) => portfolio.id === association.portfolioId)?.title || association.portfolioId} · v{association.version}</p>)}
      </section>

      <section className="space-y-4" aria-labelledby="saved-portfolios-heading">
        <div className="flex flex-wrap items-center gap-3"><h2 id="saved-portfolios-heading" className="font-display text-2xl text-landing">Saved portfolios</h2><span className="font-mono text-xs text-faint">{publicPortfolios.length} records</span><label className="ml-auto flex items-center gap-2 text-xs"><input type="checkbox" checked={showArchived} onChange={async (event) => { setShowArchived(event.target.checked); setLoading(true); try { await refresh(event.target.checked); } catch (caught) { setLoading(false); setError(asError(caught)); } }}/>Include trash</label></div>
        {publicPortfolios.length === 0 ? <div className={`${card} text-sm text-muted`}>{showArchived ? "No portfolios in this view." : "No portfolios yet. Start a source-backed draft or import an existing PDF."}</div> : <div className="grid gap-4 md:grid-cols-2">
          {publicPortfolios.slice().sort((a, b) => (recommendations.find((entry) => entry.portfolioId === b.id)?.score || 0) - (recommendations.find((entry) => entry.portfolioId === a.id)?.score || 0)).map((portfolio) => {
            const versionNumber = selectedVersions[portfolio.id] || portfolio.latestVersion || portfolio.versions[0]?.version || 0;
            const recommendation = recommendations.find((entry) => entry.portfolioId === portfolio.id);
            const isArchived = Boolean(portfolio.archivedAt);
            return <article key={portfolio.id} className={`${card} space-y-3`}>
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className="font-mono text-[10px] uppercase tracking-[.18em] text-brand-text">{portfolio.kind} / {portfolio.versions.length} versions{isArchived ? " / in trash" : ""}</span><h3 className="mt-1 break-words text-lg font-semibold">{portfolio.title}</h3></div>{recommendation && <span className="rounded-full bg-brand-soft px-2 py-1 text-xs text-brand-text">{recommendation.score} matching terms</span>}</div>
              <p className="text-xs text-muted">{portfolio.tags.join(" · ") || "No tags"}{portfolio.revision ? ` · revision ${portfolio.revision}` : ""}</p>{recommendation?.matchedTerms.length ? <p className="text-xs text-brand-text">Matched: {recommendation.matchedTerms.join(", ")}</p> : null}
              <label className="flex flex-wrap items-center gap-2 text-sm">PDF version<select aria-label={`PDF version for ${portfolio.title}`} className={`${input} max-w-40`} value={versionNumber} onChange={(event) => setSelectedVersions((old) => ({ ...old, [portfolio.id]: Number(event.target.value) }))}>{portfolio.versions.map((version) => <option key={version.version} value={version.version}>v{version.version}{version.hasEditableContent ? " · editable" : " · imported PDF"}</option>)}</select></label>
              <div className="flex flex-wrap gap-2">{versionNumber > 0 && <button type="button" disabled={Boolean(busy)} className={secondary} onClick={() => void download(portfolio.id, versionNumber, portfolio.title)}><ArrowDownToLine size={15}/>{busy === `download:${portfolio.id}:${versionNumber}` ? "Downloading…" : `Download v${versionNumber}`}</button>}
                {!isArchived && versionNumber > 0 && <button type="button" disabled={Boolean(busy)} className={secondary} onClick={() => void beginEdit(portfolio, versionNumber)}><Pencil size={15}/>{portfolio.versions.find((version) => version.version === versionNumber)?.hasEditableContent ? "Edit content" : "Create editable draft"}</button>}
                {!isArchived && <label className={`${secondary} cursor-pointer`}><UploadCloud size={15}/>New PDF version<input aria-label={`Upload a new PDF version for ${portfolio.title}`} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => { const chosen = event.target.files?.[0]; if (chosen) { setUploadTargetId(portfolio.id); setUploadFile(chosen); setSuccess(`Selected ${chosen.name}. Use Import PDF above to append it as a new version.`); } event.target.value = ""; }}/></label>}
                {!isArchived && matchedRole && <button type="button" disabled={Boolean(busy)} className={primary} onClick={() => void attach(portfolio)}><Link2 size={15}/>Attach v{versionNumber}</button>}
                {!isArchived && <button type="button" className={secondary} onClick={() => openMetadata(portfolio)}><Pencil size={15}/>Details</button>}
                {!isArchived && <button type="button" disabled={Boolean(busy)} className={secondary} onClick={() => setDestructive({ kind: "archive", id: portfolio.id, title: portfolio.title, revision: revisionOf(portfolio), references: portfolio.associationCount || 0, activeRuns: (catalog.runs || []).filter((run) => run.portfolioId === portfolio.id && activeStatuses.has(run.status)).length })}><Archive size={15}/>Move to trash</button>}
                {isArchived && <button type="button" disabled={Boolean(busy)} className={secondary} onClick={() => void restore("restore", portfolio.id, revisionOf(portfolio))}><RotateCcw size={15}/>Restore</button>}
                {isArchived && <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-full border border-red-500/40 px-4 py-2 text-sm text-red-700 hover:bg-red-500/10 dark:text-red-300" onClick={() => setDestructive({ kind: "purge", id: portfolio.id, title: portfolio.title, revision: revisionOf(portfolio), references: portfolio.associationCount || 0 })}><Trash2 size={15}/>Delete permanently</button>}
              </div>
            </article>;
          })}
        </div>}
      </section>
    </>}

    {metadataTarget && <Modal title={`Edit ${metadataTarget.title}`} onClose={() => setMetadataTarget(null)}><form className="space-y-3" onSubmit={saveMetadata}><p className="text-xs text-muted">Metadata updates do not change or replace any PDF version.</p><label className="block space-y-1 text-sm">Title<input className={input} required maxLength={160} value={metadataTitle} onChange={(event) => setMetadataTitle(event.target.value)}/></label><label className="block space-y-1 text-sm">Kind<select className={input} value={metadataKind} onChange={(event) => setMetadataKind(event.target.value as "master" | "variant")}><option value="master">Master</option><option value="variant">Variant</option></select></label><label className="block space-y-1 text-sm">Tags<input className={input} value={metadataTags} onChange={(event) => setMetadataTags(event.target.value)}/></label><fieldset><legend className="text-sm">Associated projects</legend>{catalog.projects.filter((project) => !project.archivedAt).map((project) => <label key={project.id} className="mr-3 inline-flex items-center gap-1.5 py-1 text-xs"><input type="checkbox" checked={metadataProjects.includes(project.id)} onChange={(event) => setMetadataProjects((old) => event.target.checked ? [...old, project.id] : old.filter((id) => id !== project.id))}/>{project.name}</label>)}</fieldset><button className={primary} disabled={Boolean(busy)} type="submit"><Save size={15}/>{busy.startsWith("metadata:") ? "Saving…" : "Save metadata"}</button></form></Modal>}

    {destructive && <Modal title={destructive.kind.includes("purge") ? "Permanently delete?" : "Move to recoverable trash?"} onClose={() => { setDestructive(null); setConfirmationName(""); setDetachAssociations(false); }}><form className="space-y-4" onSubmit={confirmDestructive}><div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><p className="font-semibold">{destructive.title}</p><p className="mt-1 text-xs leading-relaxed text-muted">{destructive.kind.includes("purge") ? "This permanently removes this record and its private portfolio files. Tracker rows, CVs and independent variants are not changed." : "This moves the record to recoverable trash. Its PDF versions and existing application associations remain in place, and you can restore it later."}</p><p className="mt-2 text-xs text-muted">Revision {destructive.revision} · {destructive.references} linked references</p></div>{destructive.kind === "purge" && destructive.references > 0 && <label className="flex gap-2 text-sm"><input type="checkbox" checked={detachAssociations} onChange={(event) => setDetachAssociations(event.target.checked)}/>I confirm permanent deletion may detach these application references</label>}{destructive.kind === "archive" && (destructive.activeRuns || 0) > 0 && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">This portfolio has {destructive.activeRuns} draft or render run(s). Review or cancel them in Drafts and renders before moving it to trash.</p>}{destructive.kind === "purge-project" && destructive.references > 0 && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">This project is still referenced by portfolios. Remove those project links in each portfolio’s Details first.</p>}{destructive.kind.includes("purge") && <label className="block space-y-1 text-sm">Type the exact record name to confirm<input autoComplete="off" className={input} value={confirmationName} onChange={(event) => setConfirmationName(event.target.value)} placeholder={destructive.title}/></label>}<div className="flex flex-wrap gap-2"><button className={destructive.kind.includes("purge") ? "inline-flex min-h-10 items-center gap-2 rounded-full bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50" : primary} disabled={Boolean(busy) || (destructive.kind.includes("purge") && confirmationName !== destructive.title) || (destructive.kind === "purge" && destructive.references > 0 && !detachAssociations) || (destructive.kind === "purge-project" && destructive.references > 0) || (destructive.kind === "archive" && (destructive.activeRuns || 0) > 0)} type="submit">{destructive.kind.includes("purge") ? <><Trash2 size={15}/>Delete permanently</> : <><Archive size={15}/>Move to trash</>}</button><button className={secondary} type="button" onClick={() => setDestructive(null)}>Cancel</button></div></form></Modal>}
  </main>;
}

function renderPreview(documentValue: PortfolioDocument, pageFormat: "letter" | "a4", title: string) {
  try {
    const document = normalizePortfolioDocument({ ...documentValue, name: documentValue.name || title });
    return renderPortfolioDocument(document, { format: pageFormat });
  } catch {
    return "<!doctype html><html><body style=\"font:15px Arial;padding:24px;color:#526171\"><p>Complete the required fields and use valid HTTP or HTTPS links to preview this document.</p></body></html>";
  }
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from < 0 || from >= items.length) return items;
  const reordered = items.slice();
  const [item] = reordered.splice(from, 1);
  reordered.splice(to, 0, item);
  return reordered;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') || [])];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable(); if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, []);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl" role="dialog" aria-modal="true" aria-label={title}><div className="mb-4 flex items-start gap-3"><h2 className="min-w-0 flex-1 text-lg font-semibold">{title}</h2><button type="button" aria-label="Close dialog" className="p-1 text-muted hover:text-foreground" onClick={onClose}><X size={18}/></button></div>{children}</section></div>;
}
