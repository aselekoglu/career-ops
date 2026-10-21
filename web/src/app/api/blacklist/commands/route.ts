import { handleCloudBlacklist } from "@/lib/cloud-blacklist-management.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleCloudBlacklist(request, "mutate");
}
