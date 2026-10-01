import { handleCvWorker } from "@/lib/cloud-cv-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleCvWorker(request);
}
