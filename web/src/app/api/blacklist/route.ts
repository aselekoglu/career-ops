import { handleCloudBlacklist } from "@/lib/cloud-blacklist-management.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleCloudBlacklist(request, "list");
}
