import { handleCvArtifactRequest } from "@/lib/cloud-pdf-artifacts.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleCvArtifactRequest(request, id, "associate");
}
