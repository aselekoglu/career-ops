import { handleCvArtifactRequest } from "@/lib/cloud-pdf-artifacts.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleCvArtifactRequest(request, null, "list");
}
