import { parseApplications } from "@/lib/tracker-table.mjs";
import type { Application, InboxJob, LifecyclePhase, PipelineSummary, ReportData } from "@/lib/career-ops";
import { getCloudDocument } from "@/lib/cloud-store";

async function text(path: string): Promise<string | null> {
  const row = await getCloudDocument(path);
  if (!row) return null;
  if (row.content_encoding === "utf8") return row.content;
  return null;
}

export async function cloudReadInbox(): Promise<InboxJob[]> {
  const md = await text("data/pipeline.md");
  if (!md) return [];
  const jobs: InboxJob[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const labels = new Map<string, string>();
    const parts: string[] = [];
    for (const [i, seg] of m[2].split("|").map((s) => s.trim()).entries()) {
      const lm = i >= 3 ? seg.match(/^([a-z][a-z_-]*):\s*(.*)$/i) : null;
      if (lm) labels.set(lm[1].toLowerCase(), lm[2].trim()); else parts.push(seg);
    }
    if (parts.length < 3 || !parts[0]) continue;
    const posted = labels.get("posted");
    jobs.push({ done: m[1].toLowerCase() === "x", url: parts[0], company: parts[1], role: parts[2], location: parts[3] || undefined, compensation: parts[4] || undefined, postedAt: posted && /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : undefined });
  }
  return jobs;
}

export async function cloudReadApplications(): Promise<Application[]> {
  const md = await text("data/applications.md");
  return md ? parseApplications(md, "") as Application[] : [];
}

async function cloudScanDates() {
  const tsv = await text("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  for (const [i, line] of tsv.split("\n").entries()) {
    if (!line || (i === 0 && line.startsWith("url\t"))) continue;
    const tab = line.indexOf("\t");
    const firstSeen = tab > 0 ? line.slice(tab + 1).split("\t")[0]?.trim() : "";
    if (tab > 0 && /^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(line.slice(0, tab))) dates.set(line.slice(0, tab), firstSeen);
  }
  return dates;
}

export async function cloudPipelineSummary(): Promise<PipelineSummary> {
  const [inbox, applications, dates] = await Promise.all([cloudReadInbox(), cloudReadApplications(), cloudScanDates()]);
  return { root: "neon", rootExists: true, inbox: inbox.map((j) => ({ ...j, postedAt: j.postedAt ?? dates.get(j.url) })), applications };
}

export async function cloudDoctorState(): Promise<{ phase: LifecyclePhase; onboardingNeeded: boolean; missing: string[]; hasCv: boolean; hasData: boolean }> {
  const prereqs: [string, string][] = [["cv.md", "cv.md"], ["config/profile.yml", "config/profile.yml"], ["modes/_profile.md", "modes/_profile.md"], ["portals.yml", "portals.yml"]];
  const found = await Promise.all(prereqs.map(([p]) => getCloudDocument(p)));
  const missing = prereqs.filter((_, i) => !found[i]).map(([, label]) => label);
  const hasCv = !!found[0];
  const [apps, inbox] = await Promise.all([cloudReadApplications(), cloudReadInbox()]);
  const hasData = apps.length > 0 || inbox.some((j) => !j.done);
  return { phase: !hasCv && !hasData ? "first-run" : missing.length ? "in-between" : "established", onboardingNeeded: missing.length > 0, missing, hasCv, hasData };
}

export async function cloudReadMemory(): Promise<string> {
  const md = await text("modes/_profile.md");
  if (!md) return "";
  const i = md.indexOf("<!-- co-web-notes:start -->");
  const j = md.indexOf("<!-- co-web-notes:end -->");
  return i !== -1 && j > i ? md.slice(i + "<!-- co-web-notes:start -->".length, j).trim() : "";
}

export async function cloudReadCv(): Promise<string | null> { return text("cv.md"); }

export async function cloudReadReport(n: string): Promise<ReportData | null> {
  const apps = await cloudReadApplications();
  const app = apps.find((a) => a.n === n);
  const linked = app?.report.match(/\]\(([^)]+)\)/)?.[1]?.replaceAll("\\", "/");
  const candidates = linked && linked.startsWith("../") ? linked.slice(3) : linked;
  if (candidates && candidates.startsWith("reports/") && !candidates.includes("..")) {
    const body = await text(candidates);
    if (body) return { content: body, file: candidates.slice("reports/".length) };
  }
  return null;
}
