import { handleJobImportRequest } from "@/lib/cloud-job-import.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleJobImportRequest(request);
}
