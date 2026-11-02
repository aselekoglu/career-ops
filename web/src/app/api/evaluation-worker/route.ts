import { handleEvaluationWorker } from "@/lib/cloud-evaluation-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  return handleEvaluationWorker(request);
}
