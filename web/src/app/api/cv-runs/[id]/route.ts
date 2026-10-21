import { handleCvRunRequest } from "@/lib/cloud-cv-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleCvRunRequest(request, id);
}
