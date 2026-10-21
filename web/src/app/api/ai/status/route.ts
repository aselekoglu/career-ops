import { createHostedAiService } from "@/lib/ai/hosted-ai.mjs";
import { toPublicHostedAiStatus } from "@/lib/ai/cloud-ai-gate.mjs";
import { isCloudRuntime } from "@/lib/deployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const hosted = isCloudRuntime();
  const status = createHostedAiService().status();
  return Response.json(toPublicHostedAiStatus(status, hosted), {
    headers: { "Cache-Control": "no-store" },
  });
}
