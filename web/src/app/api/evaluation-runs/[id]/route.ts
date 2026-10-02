import { handleEvaluationRequest } from "@/lib/cloud-evaluation-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleEvaluationRequest(request, id);
}
