import { handleCloudPortal } from "@/lib/cloud-portal-management.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleCloudPortal(request, "mutate");
}
