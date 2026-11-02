import { handleCloudSourceRevision } from "@/lib/cloud-source-management.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ source: string; sha256: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { source, sha256 } = await params;
  return handleCloudSourceRevision(source, sha256);
}
