import { handleCloudTrackerGet } from "@/lib/cloud-tracker-management.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ applicationId: string }> }) {
  const { applicationId } = await context.params;
  return handleCloudTrackerGet(applicationId);
}
