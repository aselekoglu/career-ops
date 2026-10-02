import { handleEvaluationRequest } from "@/lib/cloud-evaluation-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleEvaluationRequest(request);
}
