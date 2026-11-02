import { Suspense } from "react";
import { pipelineSummary } from "@/lib/career-ops";
import { cloudDataEnabled } from "@/lib/cloud-store";
import { cloudPipelineSummary } from "@/lib/cloud-career-ops";
import { PipelineView } from "@/components/pipeline-view";

export const dynamic = "force-dynamic"; // always read fresh local files

export default async function PipelinePage() {
  const { inbox, applications } = cloudDataEnabled() ? await cloudPipelineSummary() : pipelineSummary();
  return (
    <Suspense>
      <PipelineView applications={applications} inbox={inbox} />
    </Suspense>
  );
}
