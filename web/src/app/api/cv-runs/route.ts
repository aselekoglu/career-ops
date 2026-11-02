import { handleCvRunRequest } from "@/lib/cloud-cv-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  return handleCvRunRequest(request);
}
