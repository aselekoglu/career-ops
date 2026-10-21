import { notFound } from "next/navigation";
import { readReport, findApplication, trackerCanDelete } from "@/lib/career-ops";
import { ReportView } from "@/components/report-view";
import { cloudDataEnabled } from "@/lib/cloud-store";
import { cloudReadApplications, cloudReadReport } from "@/lib/cloud-career-ops";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cloud = cloudDataEnabled();
  const apps = cloud ? await cloudReadApplications() : null;
  const app = cloud ? (apps ?? []).find((a) => a.n === id) ?? null : findApplication(id);
  const report = cloud ? await cloudReadReport(id) : readReport(id);
  if (!app && !report) notFound();
  return <ReportView id={id} app={app} report={report?.content ?? null} file={report?.file ?? null} canDelete={cloud ? false : trackerCanDelete()} />;
}
